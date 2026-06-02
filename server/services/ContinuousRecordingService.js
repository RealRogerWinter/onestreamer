const { EgressClient, SegmentedFileOutput, SegmentedFileProtocol, RoomServiceClient } = require('livekit-server-sdk');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { runAsync, getAsync, allAsync } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');
const ContinuousRecordingRepository = require('../database/repository/ContinuousRecordingRepository');
const RecordingDiskScanner = require('./recording/RecordingDiskScanner');
const RoomParticipantInspector = require('./recording/RoomParticipantInspector');
const RecordingSessionStore = require('./recording/RecordingSessionStore');

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

    // State
    this.egressClient = null;
    this.currentEgressId = null;
    this.isRecording = false;
    this.recordingStartTime = null;
    this.currentSessionId = null; // Unique ID for current recording session
    this.roomServiceClient = null;
    this.autoRecordInterval = null;
    this.currentRecordingTarget = null; // 'room' or participant identity (for participant egress)

    // Stream identity tracking
    this.currentStreamIdentity = null;
    this.currentStreamSegmentId = null;

    // Repository for users-table reads
    this.userRepository = new UserRepository({ getAsync, runAsync, allAsync });

    // PR 6.3: ContinuousRecordingRepository wraps the 10 inline SQL
    // calls against recording_sessions + recording_stream_segments.
    // Two cross-table reads (url_streams, streaming_logs) stay
    // inline below — they belong to other domains.
    this.recordingRepository = new ContinuousRecordingRepository({ getAsync, runAsync, allAsync });

    // Collaborators (decomposed seams). The inspector needs roomServiceClient,
    // which is created in initialize(); it is wired up there.
    this.diskScanner = new RecordingDiskScanner({
      outputDir: this.outputDir,
      segmentDuration: this.segmentDuration,
      retentionMinutes: this.retentionMinutes,
      recordingRepository: this.recordingRepository,
      owner: this,
    });
    this.inspector = null;
    this.sessionStore = new RecordingSessionStore({
      recordingRepository: this.recordingRepository,
      userRepository: this.userRepository,
      inspector: null, // set once the inspector exists in initialize()
      owner: this,
    });

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

      // Wire up the room inspector now that roomServiceClient exists.
      this.inspector = new RoomParticipantInspector({
        roomServiceClient: this.roomServiceClient,
        roomName: this.roomName,
        userRepository: this.userRepository,
        getAsync,
      });
      this.sessionStore.inspector = this.inspector;

      // Ensure output directory exists
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }

      // Start cleanup interval
      this.startCleanupInterval();

      // Clean up any stale egress jobs from previous server crashes/restarts
      this.cleanupStaleEgress().catch(err => {
        logger.error({ err: err }, '❌ CONTINUOUS RECORDING: Initial cleanup failed');
      });

      // Start auto-record polling (check every 5 seconds if room has participants)
      this.startAutoRecordPolling();

    } catch (error) {
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Failed to initialize');
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
      logger.error({ err: error }, '❌ Failed to generate master playlist');
      return null;
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
      const realStreamer = await this.inspector.findRealStreamer();

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
        await this.sessionStore.trackStreamIdentityChange();
      }
    } catch (error) {
      // Room might not exist yet, that's ok
      if (!error.message?.includes('room not found')) {
        logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Error checking room');
      }
    }
  }

  /**
   * Start polling for auto-record
   */
  startAutoRecordPolling() {
    // Check immediately
    this.checkAndAutoRecord().catch(err => {
      logger.error({ err: err }, '❌ CONTINUOUS RECORDING: Initial auto-record check failed');
    });

    // Then check every 5 seconds
    this.autoRecordInterval = setInterval(async () => {
      try {
        await this.checkAndAutoRecord();
      } catch (err) {
        logger.error({ err: err }, '❌ CONTINUOUS RECORDING: Auto-record polling error');
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
      await this.sessionStore.createSessionRecord(
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
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Failed to start');
      return { success: false, error: error.message };
    }
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
        logger.warn({ err: e }, 'Could not count segments');
      }

      // Update database record
      await this.sessionStore.updateSessionRecord(this.currentSessionId, endTime, segmentCount);

      // End any open stream segments
      await this.sessionStore.endAllOpenSegments(this.currentSessionId);

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
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Failed to stop');

      // Even if stop failed, end open stream segments to keep timeline accurate
      if (this.currentSessionId) {
        try {
          await this.sessionStore.endAllOpenSegments(this.currentSessionId);
        } catch (e) {
          logger.error({ err: e }, '❌ CONTINUOUS RECORDING: Failed to end segments on error');
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
    const { isActiveFromDisk, activeSessionFromDisk } = this.diskScanner.getDiskStatus();

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
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Error in egress check');
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
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Failed to list egress');
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
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Failed to get egress info');
      return null;
    }
  }

  /**
   * Get all available recording sessions for clipping
   * Returns sessions sorted by time with their segment info
   */
  async getAvailableRecordings() {
    return this.diskScanner.getAvailableRecordings();
  }

  /**
   * Get the clippable time range (what's available for clipping)
   */
  async getClippableRange() {
    return this.diskScanner.getClippableRange();
  }

  /**
   * Find segments needed for a clip between startTime and endTime
   * @param {number} startMs - Clip start time in milliseconds (unix timestamp)
   * @param {number} endMs - Clip end time in milliseconds (unix timestamp)
   */
  async findSegmentsForClip(startMs, endMs) {
    return this.diskScanner.findSegmentsForClip(startMs, endMs);
  }

  /**
   * Start interval to clean up old recordings.
   * Routes through this.cleanupOldRecordings() (which delegates to the
   * scanner) so the call path stays observable via the service's public
   * method. The interval handle is owned by the scanner so shutdown can
   * clear it.
   */
  startCleanupInterval() {
    // Run cleanup every minute
    this.diskScanner.cleanupInterval = setInterval(() => {
      this.cleanupOldRecordings();
    }, 60 * 1000);

    // Run initial cleanup
    this.cleanupOldRecordings();
  }

  /**
   * Clean up recordings older than retention period.
   * See RecordingDiskScanner.cleanupOldRecordings for the PR 2.6 gating rationale.
   */
  async cleanupOldRecordings() {
    return this.diskScanner.cleanupOldRecordings();
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

    this.diskScanner.stopCleanupInterval();

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
