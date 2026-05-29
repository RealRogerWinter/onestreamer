const { EgressClient, SegmentedFileOutput, SegmentedFileProtocol, RoomServiceClient, EncodedFileOutput, EncodedFileType } = require('livekit-server-sdk');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { runAsync, getAsync, allAsync } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');
const ContinuousRecordingRepository = require('../database/repository/ContinuousRecordingRepository');

const logger = require('../bootstrap/logger').child({ svc: 'ContinuousRecordingService' });

/**
 * ContinuousRecordingService - Manages continuous room composite recording using LiveKit Egress
 *
 * This service maintains a continuous recording of the room's output, capturing
 * whoever is streaming at any moment. This allows clips to be created from
 * any point in time, regardless of streamer changes.
 *
 * Recording Strategy:
 * - Uses LiveKit Room Composite Egress with HLS segmented output
 * - Records in 4-second segments for low-latency clip creation
 * - Maintains a rolling buffer of the last N minutes
 * - Automatically starts when room has participants, stops when empty
 */
class ContinuousRecordingService extends EventEmitter {
  constructor(config = {}) {
    super();

    // LiveKit configuration
    this.livekitHost = config.livekitHost || process.env.LIVEKIT_HOST || 'http://127.0.0.1:7882';
    this.apiKey = config.apiKey || process.env.LIVEKIT_API_KEY;
    this.apiSecret = config.apiSecret || process.env.LIVEKIT_API_SECRET;
    this.roomName = config.roomName || process.env.LIVEKIT_ROOM_NAME || 'onestreamer-main';

    // Recording configuration
    this.outputDir = config.outputDir || '/root/onestreamer/egress-recordings';
    this.segmentDuration = config.segmentDuration || 4; // 4 seconds per segment for low latency
    this.retentionMinutes = config.retentionMinutes || 10; // keep last 10 minutes
    this.maxClipDuration = config.maxClipDuration || 120; // max 2 minute clips

    // State
    this.egressClient = null;
    this.currentEgressId = null;
    this.isRecording = false;
    this.recordingStartTime = null;
    this.currentSessionId = null; // Unique ID for current recording session
    this.roomServiceClient = null;
    this.autoRecordInterval = null;
    this.currentRecordingTarget = null; // 'room' or participant identity (for participant egress)
    this.lastRealStreamerCheck = null; // Track last detected real streamer

    // Stream identity tracking
    this.currentStreamIdentity = null;
    this.currentStreamSegmentId = null;
    this.lastStreamCheck = null;

    // Repository for users-table reads
    this.userRepository = new UserRepository({ getAsync, runAsync, allAsync });

    // PR 6.3: ContinuousRecordingRepository wraps the 10 inline SQL
    // calls against recording_sessions + recording_stream_segments.
    // Two cross-table reads (url_streams, streaming_logs) stay
    // inline below — they belong to other domains.
    this.recordingRepository = new ContinuousRecordingRepository({ getAsync, runAsync, allAsync });

    // Initialize
    this.initialize();
  }

  /**
   * Initialize the Egress client
   */
  initialize() {
    logger.debug('🎥 CONTINUOUS RECORDING: Initializing with HLS segments...');
    logger.debug(`   LiveKit Host: ${this.livekitHost}`);
    logger.debug(`   Room: ${this.roomName}`);
    logger.debug(`   Output: ${this.outputDir}`);
    logger.debug(`   Segment Duration: ${this.segmentDuration}s`);

    try {
      this.egressClient = new EgressClient(this.livekitHost, this.apiKey, this.apiSecret);
      this.roomServiceClient = new RoomServiceClient(this.livekitHost, this.apiKey, this.apiSecret);
      logger.debug('✅ CONTINUOUS RECORDING: Egress and Room clients initialized');

      // Ensure output directory exists
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }

      // Start cleanup interval
      this.startCleanupInterval();

      // Clean up any stale egress jobs from previous server crashes/restarts
      this.cleanupStaleEgress().catch(err => {
        logger.error('❌ CONTINUOUS RECORDING: Initial cleanup failed:', err.message);
      });

      // Start auto-record polling (check every 5 seconds if room has participants)
      this.startAutoRecordPolling();

    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Failed to initialize:', error);
    }
  }

  /**
   * Create a recording session record in the database
   */
  async createSessionRecord(sessionId, streamerIdentity, startTime, localPath) {
    try {
      // Try to get streamer user info if identity looks like a user ID
      let streamerUserId = null;
      let streamerUsername = null;

      if (streamerIdentity && streamerIdentity !== 'room') {
        // Identity might be username or user ID
        try {
          const user = await this.userRepository.getByIdOrUsername(
            streamerIdentity,
            parseInt(streamerIdentity) || 0
          );
          if (user) {
            streamerUserId = user.id;
            streamerUsername = user.username;
          } else {
            streamerUsername = streamerIdentity;
          }
        } catch (e) {
          streamerUsername = streamerIdentity;
        }
      }

      // Use INSERT OR IGNORE to avoid creating duplicates for the same day's recording
      await this.recordingRepository.insertSessionIfMissing({
        sessionId, streamerIdentity, streamerUserId, streamerUsername, startTime, localPath,
      });

      // Update the session to recording status (in case it was marked as ended)
      await this.recordingRepository.setSessionRecording(sessionId);

      logger.debug(`📝 SESSION DB: Recording session ${sessionId} active for streamer ${streamerUsername || streamerIdentity || 'room'}`);
      return { success: true };
    } catch (error) {
      logger.error('❌ SESSION DB: Failed to create session record:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update a recording session record when recording ends
   */
  async updateSessionRecord(sessionId, endTime, segmentCount) {
    try {
      const startTime = await this.getSessionStartTime(sessionId);
      const durationMs = startTime ? (endTime - startTime) : 0;

      // Don't mark as completed - session represents the whole day's recording
      // Just update the segment count and duration
      await this.recordingRepository.updateSessionEnd(sessionId, {
        endTime, durationMs, segmentCount,
      });

      logger.debug(`📝 SESSION DB: Updated session ${sessionId} - duration: ${Math.floor(durationMs / 1000)}s, added ${segmentCount} segments`);
      return { success: true };
    } catch (error) {
      logger.error('❌ SESSION DB: Failed to update session record:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get session start time from database
   */
  async getSessionStartTime(sessionId) {
    try {
      const session = await this.recordingRepository.getSessionStartTime(sessionId);
      return session ? session.start_time : Date.now();
    } catch (error) {
      return Date.now();
    }
  }

  /**
   * Get recording session from database by session ID
   */
  async getSessionRecord(sessionId) {
    try {
      return await this.recordingRepository.getSessionById(sessionId);
    } catch (error) {
      logger.error('❌ SESSION DB: Failed to get session record:', error.message);
      return null;
    }
  }

  /**
   * Generate a master HLS playlist that combines all segment playlists for seamless playback
   */
  async generateMasterPlaylist(sessionId) {
    try {
      const sessionDir = path.join(this.outputDir, sessionId);
      if (!fs.existsSync(sessionDir)) {
        return null;
      }

      // Find all playlist files and sort by timestamp
      const files = fs.readdirSync(sessionDir);
      const playlists = files
        .filter(f => f.startsWith('playlist_') && f.endsWith('.m3u8'))
        .sort((a, b) => {
          const tsA = parseInt(a.match(/playlist_(\d+)\.m3u8/)?.[1] || '0');
          const tsB = parseInt(b.match(/playlist_(\d+)\.m3u8/)?.[1] || '0');
          return tsA - tsB;
        });

      if (playlists.length === 0) {
        return null;
      }

      // Combine all playlists into one master playlist
      let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';

      for (const playlist of playlists) {
        const playlistPath = path.join(sessionDir, playlist);
        const content = fs.readFileSync(playlistPath, 'utf8');
        const lines = content.split('\n');

        for (const line of lines) {
          // Skip header lines
          if (line.startsWith('#EXTM3U') || line.startsWith('#EXT-X-VERSION') ||
              line.startsWith('#EXT-X-TARGETDURATION') || line.startsWith('#EXT-X-MEDIA-SEQUENCE') ||
              line.startsWith('#EXT-X-ENDLIST') || line.trim() === '') {
            continue;
          }

          // Convert segment filenames to query parameter format for the streaming endpoint
          // e.g., seg_123_00001.ts becomes ?file=seg_123_00001.ts
          if (line.endsWith('.ts') && !line.startsWith('#')) {
            masterContent += `?file=${line}\n`;
          } else {
            masterContent += line + '\n';
          }
        }
      }

      masterContent += '#EXT-X-ENDLIST\n';

      // Write master playlist
      const masterPath = path.join(sessionDir, 'master.m3u8');
      fs.writeFileSync(masterPath, masterContent);

      return masterPath;
    } catch (error) {
      logger.error('❌ Failed to generate master playlist:', error.message);
      return null;
    }
  }

  /**
   * Get all recording sessions from database with optional filters
   */
  async getSessionRecords(options = {}) {
    try {
      return await this.recordingRepository.listSessions(options);
    } catch (error) {
      logger.error('❌ SESSION DB: Failed to get session records:', error.message);
      return [];
    }
  }

  /**
   * Check if a participant is a viewbot (not a real streamer)
   */
  isViewbot(participant) {
    const identity = participant.identity || '';
    const name = participant.name || '';

    // Check identity patterns
    if (identity.startsWith('viewbot-') ||
        identity.includes('viewbot') ||
        identity.startsWith('bot-')) {
      return true;
    }

    // Check metadata
    try {
      const metadata = JSON.parse(participant.metadata || '{}');
      if (metadata.type === 'viewbot') {
        return true;
      }
    } catch (e) {
      // Ignore parse errors
    }

    return false;
  }

  /**
   * Check if a participant is a URL stream relay (not a real person streaming)
   */
  isUrlStreamRelay(participant) {
    const identity = participant.identity || '';
    return identity.startsWith('url-stream-');
  }

  /**
   * Find the real (non-viewbot, non-URL-stream) streamer with video tracks
   * Returns the participant identity if found, null otherwise
   */
  async findRealStreamer() {
    try {
      const participants = await this.roomServiceClient.listParticipants(this.roomName);

      // Find participants with video tracks who are NOT viewbots and NOT URL stream relays
      const realStreamers = participants.filter(p => {
        const hasVideo = p.tracks && p.tracks.some(t => t.type === 1 && !t.muted);
        return hasVideo && !this.isViewbot(p) && !this.isUrlStreamRelay(p);
      });

      if (realStreamers.length > 0) {
        // Return the first real streamer found
        const streamer = realStreamers[0];
        logger.debug(`🎯 CONTINUOUS RECORDING: Found real streamer: ${streamer.identity}`);
        return streamer.identity;
      }

      return null;
    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Error finding real streamer:', error.message);
      return null;
    }
  }

  /**
   * Find any URL stream relay that is publishing video
   * Returns the participant identity if found, null otherwise
   */
  async findUrlStreamPublisher() {
    try {
      const participants = await this.roomServiceClient.listParticipants(this.roomName);

      // Find URL stream relays with video tracks
      const urlStreamers = participants.filter(p => {
        const hasVideo = p.tracks && p.tracks.some(t => t.type === 1 && !t.muted);
        return hasVideo && this.isUrlStreamRelay(p);
      });

      if (urlStreamers.length > 0) {
        const streamer = urlStreamers[0];
        logger.debug(`🎯 CONTINUOUS RECORDING: Found URL stream publisher: ${streamer.identity}`);
        return streamer.identity;
      }

      return null;
    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Error finding URL stream publisher:', error.message);
      return null;
    }
  }

  /**
   * Extract username from a streaming platform URL
   * @param {string} sourceUrl - The source URL (e.g., https://twitch.tv/xqc)
   * @param {string} platform - The platform type (twitch, kick, etc.)
   * @returns {string|null} The extracted username or null if not found
   */
  extractUsernameFromUrl(sourceUrl, platform) {
    if (!sourceUrl) return null;

    try {
      // Handle Twitch URLs
      // Formats: https://twitch.tv/username, https://www.twitch.tv/username
      const twitchMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i);
      if (twitchMatch) {
        return twitchMatch[1];
      }

      // Handle Kick URLs
      // Formats: https://kick.com/username, https://www.kick.com/username
      const kickMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)/i);
      if (kickMatch) {
        return kickMatch[1];
      }

      // Handle YouTube URLs
      // Formats: youtube.com/@username, youtube.com/channel/xxx, youtube.com/c/username
      const youtubeMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([a-zA-Z0-9_-]+)/i);
      if (youtubeMatch) {
        return youtubeMatch[1];
      }

      // For AWS IVS URLs (Kick backend), try to extract channel name from query params or return platform name
      if (sourceUrl.includes('live-video.net') || sourceUrl.includes('playback.')) {
        // These are CDN URLs, we can't extract username from them
        return null;
      }

      // Generic fallback: try to get the last path segment
      try {
        const url = new URL(sourceUrl);
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length > 0) {
          const lastPart = pathParts[pathParts.length - 1];
          // Only return if it looks like a username (alphanumeric, not a file extension)
          if (/^[a-zA-Z0-9_-]+$/.test(lastPart) && !lastPart.includes('.')) {
            return lastPart;
          }
        }
      } catch (e) {
        // URL parsing failed
      }

      return null;
    } catch (error) {
      logger.error('Error extracting username from URL:', error.message);
      return null;
    }
  }

  /**
   * Get the current active stream info from the database
   * This determines what's currently being shown (URL stream, real streamer, or viewbot)
   */
  async getCurrentStreamInfo() {
    try {
      // Check for real streamers via LiveKit participants first
      let activePublisher = await this.findRealStreamer();

      // If no real streamer, check for URL stream publishers
      if (!activePublisher) {
        activePublisher = await this.findUrlStreamPublisher();
      }

      if (activePublisher) {
        // Check if this is a URL stream relay (identity starts with 'url-stream-')
        if (activePublisher.startsWith('url-stream-')) {
          // First check the active ViewBotURLService for live stream metadata
          // This is more reliable since it has the current stream info in memory
          if (global.viewBotURLService && global.viewBotURLService.activeStreams) {
            const activeStream = global.viewBotURLService.activeStreams.get(activePublisher);
            if (activeStream) {
              // Extract the actual username from the source URL
              const extractedUsername = this.extractUsernameFromUrl(activeStream.sourceUrl, activeStream.platform);
              return {
                identity: activePublisher,
                type: 'url_stream',
                displayName: extractedUsername || activeStream.platform || 'URL Stream',
                platform: activeStream.platform || 'direct',
                sourceUrl: activeStream.sourceUrl
              };
            }
          }

          // Fallback: Look up the URL stream by its ID in the database
          const urlStream = await getAsync(`
            SELECT url_id, source_url, platform, display_name
            FROM url_streams
            WHERE url_id = ?
          `, [activePublisher]);

          if (urlStream) {
            // Extract the actual username from the source URL
            const extractedUsername = this.extractUsernameFromUrl(urlStream.source_url, urlStream.platform);
            return {
              identity: urlStream.url_id,
              type: 'url_stream',
              displayName: extractedUsername || urlStream.platform || 'URL Stream',
              platform: urlStream.platform || 'unknown',
              sourceUrl: urlStream.source_url
            };
          } else {
            // URL stream not found anywhere - use the identity
            return {
              identity: activePublisher,
              type: 'url_stream',
              displayName: 'URL Relay Stream',
              platform: 'unknown',
              sourceUrl: null
            };
          }
        }

        // This is a real user streamer - look up user info
        let displayName = activePublisher;
        try {
          // First try streaming_logs which stores socket ID -> username mapping
          const streamLog = await getAsync(
            'SELECT streamer_name FROM streaming_logs WHERE streamer_id = ? ORDER BY id DESC LIMIT 1',
            [activePublisher]
          );
          if (streamLog && streamLog.streamer_name) {
            displayName = streamLog.streamer_name;
          } else {
            // Fall back to users table (in case the identity is a username or user ID)
            const user = await this.userRepository.getByIdOrUsername(
              activePublisher,
              parseInt(activePublisher) || 0
            );
            if (user) {
              displayName = user.username;
            }
          }
        } catch (e) {
          // Use identity as display name
        }

        return {
          identity: activePublisher,
          type: 'real_streamer',
          displayName: displayName,
          platform: 'direct',
          sourceUrl: null
        };
      }

      // Check for viewbots as fallback
      try {
        const participants = await this.roomServiceClient.listParticipants(this.roomName);
        const viewbot = participants.find(p => this.isViewbot(p) && p.tracks?.some(t => t.type === 1 && !t.muted));
        if (viewbot) {
          return {
            identity: viewbot.identity,
            type: 'viewbot',
            displayName: viewbot.name || viewbot.identity,
            platform: null,
            sourceUrl: null
          };
        }
      } catch (e) {
        // Room might not exist
      }

      return null;
    } catch (error) {
      logger.error('❌ STREAM TRACKING: Error getting current stream info:', error.message);
      return null;
    }
  }

  /**
   * Log the start of a new stream segment during recording
   */
  async logStreamSegmentStart(sessionId, streamInfo) {
    if (!sessionId || !streamInfo) return null;

    try {
      const now = Date.now();

      const result = await this.recordingRepository.insertStreamSegment({
        sessionId,
        streamIdentity: streamInfo.identity,
        streamType: streamInfo.type,
        displayName: streamInfo.displayName,
        platform: streamInfo.platform,
        sourceUrl: streamInfo.sourceUrl,
        startedAt: now,
      });

      logger.debug(`📝 STREAM TRACKING: Started segment for ${streamInfo.type} "${streamInfo.displayName}" at ${new Date(now).toISOString()}`);

      return result.lastID;
    } catch (error) {
      logger.error('❌ STREAM TRACKING: Failed to log segment start:', error.message);
      return null;
    }
  }

  /**
   * Log the end of a stream segment
   */
  async logStreamSegmentEnd(segmentId) {
    if (!segmentId) return;

    try {
      const now = Date.now();
      await this.recordingRepository.endStreamSegment(segmentId, now);

      logger.debug(`📝 STREAM TRACKING: Ended segment ID ${segmentId} at ${new Date(now).toISOString()}`);
    } catch (error) {
      logger.error('❌ STREAM TRACKING: Failed to log segment end:', error.message);
    }
  }

  /**
   * End all open segments for a session
   */
  async endAllOpenSegments(sessionId) {
    if (!sessionId) return;

    try {
      const now = Date.now();
      await this.recordingRepository.endAllOpenSegments(sessionId, now);

      logger.debug(`📝 STREAM TRACKING: Ended all open segments for session ${sessionId}`);
    } catch (error) {
      logger.error('❌ STREAM TRACKING: Failed to end open segments:', error.message);
    }
  }

  /**
   * Check for stream identity changes and log them
   */
  async trackStreamIdentityChange() {
    if (!this.isRecording || !this.currentSessionId) {
      return;
    }

    try {
      const streamInfo = await this.getCurrentStreamInfo();

      // Build a comparable identity string
      const currentIdentity = streamInfo ? `${streamInfo.type}:${streamInfo.identity}` : null;

      // Check if stream identity changed
      if (currentIdentity !== this.currentStreamIdentity) {
        logger.debug(`🔄 STREAM TRACKING: Identity changed from "${this.currentStreamIdentity}" to "${currentIdentity}"`);

        // End the previous segment if there was one
        if (this.currentStreamSegmentId) {
          await this.logStreamSegmentEnd(this.currentStreamSegmentId);
          this.currentStreamSegmentId = null;
        }

        // Start a new segment if there's a new stream
        if (streamInfo) {
          this.currentStreamSegmentId = await this.logStreamSegmentStart(this.currentSessionId, streamInfo);
        }

        this.currentStreamIdentity = currentIdentity;
      }

      this.lastStreamCheck = Date.now();
    } catch (error) {
      logger.error('❌ STREAM TRACKING: Error tracking identity change:', error.message);
    }
  }

  /**
   * Check if room has active publishers and auto-start/stop recording
   * Prioritizes real streamers over viewbots
   */
  async checkAndAutoRecord() {
    try {
      const participants = await this.roomServiceClient.listParticipants(this.roomName);

      // Check if any participant is publishing video
      const hasPublisher = participants.some(p =>
        p.tracks && p.tracks.some(t => t.type === 1 && !t.muted) // type 1 = VIDEO
      );

      // Find real streamer (non-viewbot)
      const realStreamer = await this.findRealStreamer();

      // Check if recording target changed (room -> participant, participant -> room, or participant identity changed)
      const targetChanged = this.isRecording && (
        (realStreamer && this.currentRecordingTarget === 'room') ||
        (!realStreamer && this.currentRecordingTarget !== 'room' && this.currentRecordingTarget !== null) ||
        (realStreamer && this.currentRecordingTarget !== 'room' && this.currentRecordingTarget !== realStreamer)
      );

      if (targetChanged) {
        logger.debug(`🔄 CONTINUOUS RECORDING: Recording target changed. Real streamer: ${realStreamer || 'none'}, Current target: ${this.currentRecordingTarget}`);
        // Stop current recording and restart with new target
        await this.stopRecording();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Brief delay
      }

      if (hasPublisher && !this.isRecording) {
        if (realStreamer) {
          logger.debug(`🎥 CONTINUOUS RECORDING: Detected REAL streamer ${realStreamer}, starting participant recording...`);
        } else {
          logger.debug('🎥 CONTINUOUS RECORDING: Detected viewbot publisher, starting room recording...');
        }
        await this.startRecording(realStreamer);
      } else if (!hasPublisher && this.isRecording) {
        // Keep recording for a bit after stream ends to capture final moments
        logger.debug('🎥 CONTINUOUS RECORDING: No publishers detected, will continue recording briefly...');
      }

      // Track stream identity changes (check what's actually being shown)
      if (this.isRecording) {
        await this.trackStreamIdentityChange();
      }
    } catch (error) {
      // Room might not exist yet, that's ok
      if (!error.message?.includes('room not found')) {
        logger.error('❌ CONTINUOUS RECORDING: Error checking room:', error.message);
      }
    }
  }

  /**
   * Start polling for auto-record
   */
  startAutoRecordPolling() {
    // Check immediately
    this.checkAndAutoRecord().catch(err => {
      logger.error('❌ CONTINUOUS RECORDING: Initial auto-record check failed:', err.message);
    });

    // Then check every 5 seconds
    this.autoRecordInterval = setInterval(async () => {
      try {
        await this.checkAndAutoRecord();
      } catch (err) {
        logger.error('❌ CONTINUOUS RECORDING: Auto-record polling error:', err.message);
        // Don't rethrow - keep polling running
      }
    }, 5000);

    logger.debug('🔄 CONTINUOUS RECORDING: Auto-record polling started');
  }

  /**
   * Start continuous recording of the room with HLS segments
   * @param {string|null} targetParticipant - If provided, use Participant Egress for this identity (real streamer).
   *                                          If null, use Room Composite Egress (viewbot/default).
   */
  async startRecording(targetParticipant = null) {
    // If we think we're recording, verify the egress is still active
    if (this.isRecording && this.currentEgressId) {
      const egressInfo = await this.getEgressInfo(this.currentEgressId);
      if (egressInfo && (egressInfo.status === 0 || egressInfo.status === 1)) {
        // Check if target changed (need to switch from room to participant or vice versa)
        if (targetParticipant && this.currentRecordingTarget === 'room') {
          logger.debug(`🔄 CONTINUOUS RECORDING: Need to switch from room to participant egress for ${targetParticipant}`);
          // Will stop and restart below
        } else if (!targetParticipant && this.currentRecordingTarget !== 'room') {
          logger.debug(`🔄 CONTINUOUS RECORDING: Need to switch from participant to room egress`);
          // Will stop and restart below
        } else {
          logger.debug('⚠️ CONTINUOUS RECORDING: Already recording, verified egress is active');
          return { success: true, egressId: this.currentEgressId };
        }
      }
      // Egress completed or failed or target changed, reset state
      logger.debug('🔄 CONTINUOUS RECORDING: Previous egress completed/failed/target changed, resetting state');
      this.isRecording = false;
      this.currentEgressId = null;
      this.recordingStartTime = null;
      this.currentSessionId = null;
      this.currentRecordingTarget = null;
    }

    try {
      // Stop any existing active egress for this room before creating a new
      // one. We used to adopt the existing one when targetParticipant was
      // null, but LiveKit's "active" status includes zombies (egress worker
      // dead, session-table not updated). Adopting a zombie leaves
      // isRecording=true with nothing being written to disk. Cleaner to
      // always stop and recreate — the ~5 s gap on a real restart is cheap
      // compared to days of silent dataloss.
      const activeEgresses = await this.listActiveEgress();
      if (activeEgresses.length > 0) {
        logger.debug(`🔄 CONTINUOUS RECORDING: Stopping ${activeEgresses.length} existing egress(es) before creating new`);
        for (const egress of activeEgresses) {
          try {
            await this.egressClient.stopEgress(egress.egressId);
          } catch (e) {
            logger.debug(`⚠️ Could not stop egress ${egress.egressId}: ${e.message}`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Create a unique session ID for this recording
      // Use date-based session ID so all recordings for the same day go into one session
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      this.currentSessionId = `recording_${today}`;
      const sessionDir = `/out/${this.currentSessionId}`;

      // Create HLS segmented output
      // Egress runs in Docker with /out mapped to outputDir
      // Use timestamp prefix to avoid overwriting segments when egress restarts
      const egressTimestamp = Date.now();
      const segmentOutput = new SegmentedFileOutput({
        protocol: SegmentedFileProtocol.HLS_PROTOCOL,
        filenamePrefix: `${sessionDir}/seg_${egressTimestamp}`,
        playlistName: `playlist_${egressTimestamp}.m3u8`,
        segmentDuration: this.segmentDuration,
        filenameSuffix: 0, // INDEX suffix (seg_TIMESTAMP_0.ts, seg_TIMESTAMP_1.ts, etc.)
        disableManifest: false
      });

      // Create session directory on host with write permissions for egress container
      const hostSessionDir = path.join(this.outputDir, this.currentSessionId);
      if (!fs.existsSync(hostSessionDir)) {
        fs.mkdirSync(hostSessionDir, { recursive: true, mode: 0o777 });
      }
      // Ensure permissions are correct (mkdirSync mode can be affected by umask)
      fs.chmodSync(hostSessionDir, 0o777);

      let egressInfo;

      if (targetParticipant) {
        // Use Participant Egress for real streamers - records ONLY this participant
        logger.debug(`🎬 CONTINUOUS RECORDING: Starting PARTICIPANT egress for ${targetParticipant}...`);

        egressInfo = await this.egressClient.startParticipantEgress(
          this.roomName,
          targetParticipant, // participant identity
          {
            segments: segmentOutput,
          },
          {
            // screenShare: false, // Don't include screen share
            // Record both audio and video from this participant
          }
        );

        this.currentRecordingTarget = targetParticipant;
        logger.debug(`✅ CONTINUOUS RECORDING: Started PARTICIPANT egress for ${targetParticipant}`);
      } else {
        // Use Room Composite egress for viewbots (no real streamer)
        logger.debug('🎬 CONTINUOUS RECORDING: Starting ROOM COMPOSITE egress (viewbot mode)...');

        egressInfo = await this.egressClient.startRoomCompositeEgress(
          this.roomName,
          {
            segments: segmentOutput,
          },
          {
            layout: 'single-speaker',
            audioOnly: false,
            videoOnly: false,
            customBaseUrl: '',
          }
        );

        this.currentRecordingTarget = 'room';
        logger.debug('✅ CONTINUOUS RECORDING: Started ROOM COMPOSITE egress');
      }

      this.currentEgressId = egressInfo.egressId;
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      logger.debug(`   Egress ID: ${this.currentEgressId}`);
      logger.debug(`   Session: ${this.currentSessionId}`);
      logger.debug(`   Target: ${this.currentRecordingTarget}`);
      logger.debug(`   Segments: ${hostSessionDir}/`);

      // Create database record for this session
      await this.createSessionRecord(
        this.currentSessionId,
        this.currentRecordingTarget,
        this.recordingStartTime,
        hostSessionDir
      );

      this.emit('recording-started', {
        egressId: this.currentEgressId,
        sessionId: this.currentSessionId,
        startTime: this.recordingStartTime,
        outputPath: hostSessionDir,
        target: this.currentRecordingTarget,
        streamerIdentity: this.currentRecordingTarget
      });

      return {
        success: true,
        egressId: this.currentEgressId,
        sessionId: this.currentSessionId,
        startTime: this.recordingStartTime,
        target: this.currentRecordingTarget
      };

    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Failed to start:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract session ID from existing egress info
   * Now uses date-based session IDs (recording_YYYY-MM-DD)
   */
  extractSessionIdFromEgress(egressInfo) {
    try {
      // Try to extract from the segmented output filepath
      if (egressInfo.segmentResults && egressInfo.segmentResults.length > 0) {
        const filepath = egressInfo.segmentResults[0].playlistName || '';

        // Check for new date-based format: recording_YYYY-MM-DD
        const dateMatch = filepath.match(/recording_(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          return `recording_${dateMatch[1]}`;
        }

        // Legacy format: session_timestamp
        const legacyMatch = filepath.match(/session_(\d+)/);
        if (legacyMatch) {
          return `session_${legacyMatch[1]}`;
        }
      }
    } catch (err) {
      // Ignore extraction errors
    }

    // Default to today's date-based session ID
    const today = new Date().toISOString().split('T')[0];
    return `recording_${today}`;
  }

  /**
   * Stop continuous recording
   */
  async stopRecording() {
    if (!this.isRecording || !this.currentEgressId) {
      logger.debug('⚠️ CONTINUOUS RECORDING: Not currently recording');
      return { success: true };
    }

    try {
      logger.debug(`🛑 CONTINUOUS RECORDING: Stopping egress ${this.currentEgressId}...`);

      await this.egressClient.stopEgress(this.currentEgressId);

      const duration = Date.now() - this.recordingStartTime;
      const endTime = Date.now();

      logger.debug(`✅ CONTINUOUS RECORDING: Stopped after ${Math.floor(duration / 1000)}s`);

      // Get segment count for the session
      let segmentCount = 0;
      try {
        const sessionDir = path.join(this.outputDir, this.currentSessionId);
        if (fs.existsSync(sessionDir)) {
          segmentCount = fs.readdirSync(sessionDir).filter(f => f.endsWith('.ts')).length;
        }
      } catch (e) {
        logger.warn('Could not count segments:', e.message);
      }

      // Update database record
      await this.updateSessionRecord(this.currentSessionId, endTime, segmentCount);

      // End any open stream segments
      await this.endAllOpenSegments(this.currentSessionId);

      this.emit('recording-stopped', {
        egressId: this.currentEgressId,
        sessionId: this.currentSessionId,
        duration,
        startTime: this.recordingStartTime,
        endTime: endTime,
        segmentCount: segmentCount
      });

      const stoppedSessionId = this.currentSessionId;
      this.currentEgressId = null;
      this.isRecording = false;
      this.recordingStartTime = null;
      this.currentSessionId = null;
      this.currentRecordingTarget = null;
      // Reset stream tracking state
      this.currentStreamIdentity = null;
      this.currentStreamSegmentId = null;

      return { success: true, duration, sessionId: stoppedSessionId, segmentCount };

    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Failed to stop:', error);

      // Even if stop failed, end open stream segments to keep timeline accurate
      if (this.currentSessionId) {
        try {
          await this.endAllOpenSegments(this.currentSessionId);
        } catch (e) {
          logger.error('❌ CONTINUOUS RECORDING: Failed to end segments on error:', e.message);
        }
      }

      // Reset state anyway
      this.currentEgressId = null;
      this.isRecording = false;
      this.currentRecordingTarget = null;
      this.currentStreamIdentity = null;
      this.currentStreamSegmentId = null;
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current recording status
   */
  getStatus() {
    // Also check disk for active recordings in case SDK state is out of sync
    let isActiveFromDisk = false;
    let activeSessionFromDisk = null;

    try {
      const items = fs.readdirSync(this.outputDir);
      for (const item of items) {
        if (item.startsWith('session_')) {
          const itemPath = path.join(this.outputDir, item);
          const segments = fs.readdirSync(itemPath).filter(f => f.endsWith('.ts'));
          if (segments.length > 0) {
            const latestSegment = segments.sort().slice(-1)[0];
            const latestPath = path.join(itemPath, latestSegment);
            const stat = fs.statSync(latestPath);
            const age = Date.now() - stat.mtimeMs;
            if (age < 30000) { // Active if segment within 30 seconds
              isActiveFromDisk = true;
              activeSessionFromDisk = item;
              break;
            }
          }
        }
      }
    } catch (e) {
      // Ignore disk check errors
    }

    return {
      isRecording: this.isRecording || isActiveFromDisk,
      egressId: this.currentEgressId,
      sessionId: this.currentSessionId || activeSessionFromDisk,
      startTime: this.recordingStartTime,
      duration: this.isRecording ? Date.now() - this.recordingStartTime : 0,
      outputDir: this.outputDir,
      isActiveFromDisk,
      recordingTarget: this.currentRecordingTarget, // 'room' or participant identity
      isParticipantEgress: this.currentRecordingTarget && this.currentRecordingTarget !== 'room'
    };
  }

  /**
   * Clean up stale/zombie egress jobs that are marked active but not actually recording
   */
  async cleanupStaleEgress() {
    try {
      const egresses = await this.egressClient.listEgress({ roomName: this.roomName });
      const activeEgresses = egresses.filter(e => e.status === 0 || e.status === 1);
      if (activeEgresses.length === 0) return;

      // Do NOT adopt. LiveKit's status==1 ("active") includes zombies — the
      // egress worker process has died but LiveKit's session table wasn't
      // updated. We've seen one stuck active for 3+ weeks. Adopting one
      // leaves isRecording=true with no segments ever written to disk, so
      // every downstream consumer (frame capture, clip extraction, vision
      // bot) silently miss-skips. Force-stop them all on startup; the
      // polling loop will create a fresh egress within 5 s if there's
      // actually a publisher in the room.
      for (const e of activeEgresses) {
        const startedAtIso = e.startedAt
          ? new Date(Number(BigInt(e.startedAt) / BigInt(1e6))).toISOString()
          : '?';
        logger.warn(`🧹 CONTINUOUS RECORDING: Stopping stale egress ${e.egressId} (started ${startedAtIso})`);
        try {
          await this.egressClient.stopEgress(e.egressId);
        } catch (err) {
          // Zombie egresses with no worker process to receive the stop
          // command time out here; that's expected. LiveKit's status will
          // age out on its own. Our state is clean either way.
          logger.warn(`   stopEgress timed out / failed for ${e.egressId}: ${err.message}`);
        }
      }
    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Error in egress check:', error.message);
    }
  }

  /**
   * List all active egress jobs for the room
   * Status codes: 0=STARTING, 1=ACTIVE, 2=ENDING, 3=COMPLETE, 4=FAILED
   */
  async listActiveEgress() {
    try {
      const egresses = await this.egressClient.listEgress({ roomName: this.roomName });

      // Log all egress jobs with their status for debugging
      if (egresses.length > 0) {
        logger.debug(`🔍 CONTINUOUS RECORDING: Found ${egresses.length} egress job(s):`);
        egresses.forEach(e => {
          const statusNames = ['STARTING', 'ACTIVE', 'ENDING', 'COMPLETE', 'FAILED'];
          logger.debug(`   - ${e.egressId}: status=${e.status} (${statusNames[e.status] || 'UNKNOWN'})`);
        });
      }

      // Only return actually active egresses (status 0 or 1)
      const activeEgresses = egresses.filter(e => e.status === 0 || e.status === 1);
      logger.debug(`🔍 CONTINUOUS RECORDING: ${activeEgresses.length} egress job(s) are currently active`);

      return activeEgresses;
    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Failed to list egress:', error.message);
      return [];
    }
  }

  /**
   * Get info about a specific egress
   */
  async getEgressInfo(egressId) {
    try {
      const egresses = await this.egressClient.listEgress({ egressId });
      return egresses[0] || null;
    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Failed to get egress info:', error);
      return null;
    }
  }

  /**
   * Get all available recording sessions for clipping
   * Returns sessions sorted by time with their segment info
   */
  async getAvailableRecordings() {
    const recordings = [];

    try {
      // Scan for session directories
      const items = fs.readdirSync(this.outputDir);

      for (const item of items) {
        const itemPath = path.join(this.outputDir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && item.startsWith('session_')) {
          // This is a recording session
          const sessionId = item;
          const playlistPath = path.join(itemPath, 'playlist.m3u8');
          const livePlaylistPath = path.join(itemPath, 'live.m3u8');

          // Check if we have a playlist
          const hasPlaylist = fs.existsSync(playlistPath) || fs.existsSync(livePlaylistPath);

          if (hasPlaylist) {
            // Get segment files
            const segments = fs.readdirSync(itemPath)
              .filter(f => f.endsWith('.ts'))
              .sort((a, b) => {
                // Sort by segment index
                const aMatch = a.match(/_(\d+)\.ts$/);
                const bMatch = b.match(/_(\d+)\.ts$/);
                const aNum = aMatch ? parseInt(aMatch[1]) : 0;
                const bNum = bMatch ? parseInt(bMatch[1]) : 0;
                return aNum - bNum;
              });

            if (segments.length > 0) {
              // Parse timestamp from session ID
              const timestampMatch = sessionId.match(/session_(\d+)/);
              const startTime = timestampMatch ? parseInt(timestampMatch[1]) : stat.mtimeMs;

              // Calculate total duration from segments
              const totalDuration = segments.length * this.segmentDuration;

              // Check if this session is actively recording by checking latest segment age
              const latestSegment = segments[segments.length - 1];
              const latestSegmentPath = path.join(itemPath, latestSegment);
              const latestSegmentStat = fs.statSync(latestSegmentPath);
              const segmentAge = Date.now() - latestSegmentStat.mtimeMs;
              // Consider active if last segment was written within 30 seconds
              const isActiveFromDisk = segmentAge < 30000;

              recordings.push({
                sessionId,
                path: itemPath,
                startTime,
                segments,
                segmentCount: segments.length,
                duration: totalDuration, // in seconds
                durationMs: totalDuration * 1000,
                hasLivePlaylist: fs.existsSync(livePlaylistPath),
                hasPlaylist: fs.existsSync(playlistPath),
                isActive: this.currentSessionId === sessionId || isActiveFromDisk,
                latestSegmentAge: segmentAge
              });
            }
          }
        }
      }

      // Sort by start time, most recent first
      recordings.sort((a, b) => b.startTime - a.startTime);

    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Failed to list recordings:', error);
    }

    return recordings;
  }

  /**
   * Get the clippable time range (what's available for clipping)
   */
  async getClippableRange() {
    const recordings = await this.getAvailableRecordings();

    if (recordings.length === 0) {
      return { available: false, start: null, end: null, duration: 0 };
    }

    // Calculate total available duration across all recordings
    // Filter based on whether the recording has recent content (end time), not just start time
    // This ensures actively recording sessions remain available even if started long ago
    const retentionCutoff = Date.now() - (this.retentionMinutes * 60 * 1000);
    const availableRecordings = recordings.filter(r => {
      // Calculate recording end time
      const recordingEndTime = r.startTime + r.durationMs;
      // Include if still has content within retention window OR is actively recording
      return recordingEndTime >= retentionCutoff || r.isActive;
    });

    if (availableRecordings.length === 0) {
      return { available: false, start: null, end: null, duration: 0 };
    }

    // Get the time range
    const oldest = availableRecordings[availableRecordings.length - 1];
    const newest = availableRecordings[0];

    const start = oldest.startTime;
    // Use the actual segment-based end time, NOT Date.now()
    // Segments lag behind real-time, so using Date.now() causes out-of-range clip requests
    const end = newest.startTime + newest.durationMs;

    const totalDuration = end - start;

    return {
      available: totalDuration >= 30000, // At least 30 seconds available
      start,
      end,
      duration: totalDuration,
      recordingCount: availableRecordings.length,
      totalSegments: availableRecordings.reduce((sum, r) => sum + r.segmentCount, 0)
    };
  }

  /**
   * Find segments needed for a clip between startTime and endTime
   * @param {number} startMs - Clip start time in milliseconds (unix timestamp)
   * @param {number} endMs - Clip end time in milliseconds (unix timestamp)
   */
  async findSegmentsForClip(startMs, endMs) {
    logger.debug(`🔍 CLIP SEARCH: Starting findSegmentsForClip`);
    logger.debug(`🔍 CLIP SEARCH: outputDir = ${this.outputDir}`);

    const recordings = await this.getAvailableRecordings();
    const neededSegments = [];

    logger.debug(`🔍 CLIP SEARCH: Looking for segments between ${startMs} and ${endMs}`);
    logger.debug(`🔍 CLIP SEARCH: Found ${recordings.length} recording sessions`);
    recordings.forEach(r => {
      logger.debug(`   Session ${r.sessionId}: start=${r.startTime}, end=${r.startTime + r.durationMs}, segments=${r.segmentCount}`);
    });

    for (const recording of recordings) {
      const recordingEndMs = recording.startTime + recording.durationMs;

      // Check if this recording overlaps with the clip time range
      if (recording.startTime <= endMs && recordingEndMs >= startMs) {
        // Calculate which segments we need from this recording
        const segmentDurationMs = this.segmentDuration * 1000;

        for (let i = 0; i < recording.segments.length; i++) {
          const segmentStartMs = recording.startTime + (i * segmentDurationMs);
          const segmentEndMs = segmentStartMs + segmentDurationMs;

          // Check if this segment overlaps with the clip
          if (segmentStartMs < endMs && segmentEndMs > startMs) {
            neededSegments.push({
              sessionId: recording.sessionId,
              segmentFile: recording.segments[i],
              segmentPath: path.join(recording.path, recording.segments[i]),
              segmentIndex: i,
              startMs: segmentStartMs,
              endMs: segmentEndMs
            });
          }
        }
      }
    }

    // Sort by time
    neededSegments.sort((a, b) => a.startMs - b.startMs);

    logger.debug(`🔍 CLIP SEARCH: Found ${neededSegments.length} matching segments`);
    if (neededSegments.length === 0) {
      logger.debug(`⚠️ CLIP SEARCH: No segments found! Requested range: ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}`);
    }

    return {
      segments: neededSegments,
      clipStartMs: startMs,
      clipEndMs: endMs,
      clipDurationMs: endMs - startMs
    };
  }

  /**
   * Start interval to clean up old recordings
   */
  startCleanupInterval() {
    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldRecordings();
    }, 60 * 1000);

    // Run initial cleanup
    this.cleanupOldRecordings();
  }

  /**
   * Clean up recordings older than retention period.
   *
   * PR 2.6: gated on `recording_sessions.b2_file_id IS NOT NULL`. The
   * production default retention is 10 minutes (bootstrap/services.js)
   * but `RecordingUploadScheduler.localBufferHours` is 2 hours — so
   * without a gate, this cleanup *always* deletes local files before
   * the upload scheduler ever fires. Recording is then permanently
   * lost: the upload retries every 30 minutes against a missing
   * `local_path`, status stays at `'completed'`, b2_file_id stays
   * NULL forever.
   *
   * Fix: preload the set of session_ids that have NOT yet been
   * uploaded (b2_file_id IS NULL) and skip those directories. Both
   * "pending upload" (status = 'completed') and "currently uploading"
   * (status = 'processing') match the same predicate, so the gate
   * covers both. Once the upload pipeline either succeeds (sets
   * b2_file_id) or is admin-acknowledged as failed (a future cleanup
   * path can NULL-out the row or hard-fail it), the session falls out
   * of the pending set and the next cleanup tick is free to delete.
   *
   * The single-file `.mp4` / `.json` branch (legacy `room_<ts>.*`
   * format, no longer produced — grep confirms no caller writes
   * matching filenames) is left untouched: those aren't tracked in
   * `recording_sessions`, so there's no gate to apply, and the dead
   * code is harmless on a production filesystem that doesn't contain
   * such files.
   */
  async cleanupOldRecordings() {
    try {
      const cutoffTime = Date.now() - (this.retentionMinutes * 60 * 1000);

      // Build the pending-upload set BEFORE the readdir/stat loop so a
      // mid-iteration race (an upload completing while we iterate)
      // can only ever *expand* the deletion window we'd take on the
      // next tick, never shrink it within this tick.
      let pendingSessionIds = new Set();
      try {
        const pendingRows = await this.recordingRepository.listSessionsPendingUpload();
        pendingSessionIds = new Set(pendingRows.map((r) => r.session_id));
      } catch (dbError) {
        // Fail-closed: if the DB lookup fails, do NOT delete anything
        // this tick. Better to delay cleanup than to nuke an
        // unconfirmed upload's source file. Next tick retries.
        logger.error('❌ CONTINUOUS RECORDING: Cleanup aborted — failed to load pending uploads:', dbError);
        return;
      }

      const items = fs.readdirSync(this.outputDir);
      let deletedCount = 0;
      let skippedPendingUpload = 0;

      for (const item of items) {
        const itemPath = path.join(this.outputDir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && item.startsWith('session_')) {
          // Don't delete the current active session
          if (item === this.currentSessionId) {
            continue;
          }

          // Parse timestamp from session ID
          const match = item.match(/session_(\d+)/);
          if (match) {
            const timestamp = parseInt(match[1]);
            if (timestamp < cutoffTime) {
              // PR 2.6: skip directories whose recording_sessions row
              // still has b2_file_id = NULL (upload pending or in
              // flight). Without this gate, we race the uploader.
              if (pendingSessionIds.has(item)) {
                skippedPendingUpload++;
                continue;
              }
              // Delete the entire session directory
              fs.rmSync(itemPath, { recursive: true, force: true });
              deletedCount++;
            }
          }
        } else if (item.endsWith('.mp4') || item.endsWith('.json')) {
          // Clean up old single-file recordings too (legacy format —
          // not produced by current pipeline; left in place for any
          // historical files that may still exist on disk).
          const match = item.match(/room_(\d+)\./);
          if (match) {
            const timestamp = parseInt(match[1]);
            if (timestamp < cutoffTime) {
              fs.unlinkSync(itemPath);
              deletedCount++;
            }
          }
        }
      }

      if (deletedCount > 0 || skippedPendingUpload > 0) {
        const suffix = skippedPendingUpload > 0
          ? ` (skipped ${skippedPendingUpload} pending B2 upload)`
          : '';
        logger.debug(`🧹 CONTINUOUS RECORDING: Cleaned up ${deletedCount} old recording(s)${suffix}`);
      }

    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Cleanup error:', error);
    }
  }

  // Lifecycle entry point — uniform name across services for the bootstrap
  // shutdown loop (PR 1.2). Delegates to the existing teardown.
  async stop() {
    await this.shutdown();
  }

  /**
   * Stop the service
   */
  async shutdown() {
    logger.debug('🛑 CONTINUOUS RECORDING: Shutting down...');

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    if (this.autoRecordInterval) {
      clearInterval(this.autoRecordInterval);
    }

    if (this.isRecording) {
      await this.stopRecording();
    }

    logger.debug('✅ CONTINUOUS RECORDING: Shutdown complete');
  }
}

module.exports = ContinuousRecordingService;
