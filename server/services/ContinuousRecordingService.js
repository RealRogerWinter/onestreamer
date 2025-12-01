const { EgressClient, SegmentedFileOutput, SegmentedFileProtocol, RoomServiceClient } = require('livekit-server-sdk');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

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
    this.apiKey = config.apiKey || process.env.LIVEKIT_API_KEY || 'devkey';
    this.apiSecret = config.apiSecret || process.env.LIVEKIT_API_SECRET || 'secret';
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

    // Initialize
    this.initialize();
  }

  /**
   * Initialize the Egress client
   */
  initialize() {
    console.log('🎥 CONTINUOUS RECORDING: Initializing with HLS segments...');
    console.log(`   LiveKit Host: ${this.livekitHost}`);
    console.log(`   Room: ${this.roomName}`);
    console.log(`   Output: ${this.outputDir}`);
    console.log(`   Segment Duration: ${this.segmentDuration}s`);

    try {
      this.egressClient = new EgressClient(this.livekitHost, this.apiKey, this.apiSecret);
      this.roomServiceClient = new RoomServiceClient(this.livekitHost, this.apiKey, this.apiSecret);
      console.log('✅ CONTINUOUS RECORDING: Egress and Room clients initialized');

      // Ensure output directory exists
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }

      // Start cleanup interval
      this.startCleanupInterval();

      // Clean up any stale egress jobs from previous server crashes/restarts
      this.cleanupStaleEgress().catch(err => {
        console.error('❌ CONTINUOUS RECORDING: Initial cleanup failed:', err.message);
      });

      // Start auto-record polling (check every 5 seconds if room has participants)
      this.startAutoRecordPolling();

    } catch (error) {
      console.error('❌ CONTINUOUS RECORDING: Failed to initialize:', error);
    }
  }

  /**
   * Check if room has active publishers and auto-start/stop recording
   */
  async checkAndAutoRecord() {
    try {
      const participants = await this.roomServiceClient.listParticipants(this.roomName);

      // Check if any participant is publishing video
      const hasPublisher = participants.some(p =>
        p.tracks && p.tracks.some(t => t.type === 1 && !t.muted) // type 1 = VIDEO
      );

      if (hasPublisher && !this.isRecording) {
        console.log('🎥 CONTINUOUS RECORDING: Detected publisher, starting recording...');
        await this.startRecording();
      } else if (!hasPublisher && this.isRecording) {
        // Keep recording for a bit after stream ends to capture final moments
        console.log('🎥 CONTINUOUS RECORDING: No publishers detected, will continue recording briefly...');
      }
    } catch (error) {
      // Room might not exist yet, that's ok
      if (!error.message?.includes('room not found')) {
        console.error('❌ CONTINUOUS RECORDING: Error checking room:', error.message);
      }
    }
  }

  /**
   * Start polling for auto-record
   */
  startAutoRecordPolling() {
    // Check immediately
    this.checkAndAutoRecord();

    // Then check every 5 seconds
    this.autoRecordInterval = setInterval(() => {
      this.checkAndAutoRecord();
    }, 5000);

    console.log('🔄 CONTINUOUS RECORDING: Auto-record polling started');
  }

  /**
   * Start continuous recording of the room with HLS segments
   */
  async startRecording() {
    // If we think we're recording, verify the egress is still active
    if (this.isRecording && this.currentEgressId) {
      const egressInfo = await this.getEgressInfo(this.currentEgressId);
      if (egressInfo && (egressInfo.status === 0 || egressInfo.status === 1)) {
        console.log('⚠️ CONTINUOUS RECORDING: Already recording, verified egress is active');
        return { success: true, egressId: this.currentEgressId };
      } else {
        // Egress completed or failed, reset state
        console.log('🔄 CONTINUOUS RECORDING: Previous egress completed/failed, resetting state');
        this.isRecording = false;
        this.currentEgressId = null;
        this.recordingStartTime = null;
        this.currentSessionId = null;
      }
    }

    try {
      // Check if there's already an active egress for this room
      const activeEgresses = await this.listActiveEgress();
      if (activeEgresses.length > 0) {
        console.log(`⚠️ CONTINUOUS RECORDING: Found ${activeEgresses.length} active egress job(s), using existing`);
        this.currentEgressId = activeEgresses[0].egressId;
        this.isRecording = true;
        this.recordingStartTime = Date.now();
        // Try to extract session ID from existing egress
        this.currentSessionId = this.extractSessionIdFromEgress(activeEgresses[0]);
        return { success: true, egressId: this.currentEgressId };
      }

      console.log('🎬 CONTINUOUS RECORDING: Starting HLS segmented recording...');

      // Create a unique session ID for this recording
      this.currentSessionId = `session_${Date.now()}`;
      const sessionDir = `/out/${this.currentSessionId}`;

      // Create HLS segmented output
      // Egress runs in Docker with /out mapped to outputDir
      const segmentOutput = new SegmentedFileOutput({
        protocol: SegmentedFileProtocol.HLS_PROTOCOL,
        filenamePrefix: `${sessionDir}/segment`,
        playlistName: 'playlist.m3u8',
        // Don't use live playlist - it causes segment deletion
        // livePlaylistName: 'live.m3u8',
        segmentDuration: this.segmentDuration,
        filenameSuffix: 0, // INDEX suffix (segment_0.ts, segment_1.ts, etc.)
        disableManifest: false
      });

      // Create session directory on host with write permissions for egress container
      const hostSessionDir = path.join(this.outputDir, this.currentSessionId);
      if (!fs.existsSync(hostSessionDir)) {
        fs.mkdirSync(hostSessionDir, { recursive: true, mode: 0o777 });
      }
      // Ensure permissions are correct (mkdirSync mode can be affected by umask)
      fs.chmodSync(hostSessionDir, 0o777);

      // Start room composite egress with segmented output
      const egressInfo = await this.egressClient.startRoomCompositeEgress(
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

      this.currentEgressId = egressInfo.egressId;
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      console.log(`✅ CONTINUOUS RECORDING: Started with egress ID: ${this.currentEgressId}`);
      console.log(`   Session: ${this.currentSessionId}`);
      console.log(`   Segments: ${hostSessionDir}/`);

      this.emit('recording-started', {
        egressId: this.currentEgressId,
        sessionId: this.currentSessionId,
        startTime: this.recordingStartTime,
        outputPath: hostSessionDir
      });

      return {
        success: true,
        egressId: this.currentEgressId,
        sessionId: this.currentSessionId,
        startTime: this.recordingStartTime
      };

    } catch (error) {
      console.error('❌ CONTINUOUS RECORDING: Failed to start:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract session ID from existing egress info
   */
  extractSessionIdFromEgress(egressInfo) {
    try {
      // Try to extract from the segmented output filepath
      if (egressInfo.segmentResults && egressInfo.segmentResults.length > 0) {
        const filepath = egressInfo.segmentResults[0].playlistName;
        const match = filepath.match(/session_(\d+)/);
        if (match) {
          return `session_${match[1]}`;
        }
      }
    } catch (err) {
      // Ignore extraction errors
    }
    return `session_${Date.now()}`;
  }

  /**
   * Stop continuous recording
   */
  async stopRecording() {
    if (!this.isRecording || !this.currentEgressId) {
      console.log('⚠️ CONTINUOUS RECORDING: Not currently recording');
      return { success: true };
    }

    try {
      console.log(`🛑 CONTINUOUS RECORDING: Stopping egress ${this.currentEgressId}...`);

      await this.egressClient.stopEgress(this.currentEgressId);

      const duration = Date.now() - this.recordingStartTime;

      console.log(`✅ CONTINUOUS RECORDING: Stopped after ${Math.floor(duration / 1000)}s`);

      this.emit('recording-stopped', {
        egressId: this.currentEgressId,
        sessionId: this.currentSessionId,
        duration,
        startTime: this.recordingStartTime
      });

      this.currentEgressId = null;
      this.isRecording = false;
      this.recordingStartTime = null;
      this.currentSessionId = null;

      return { success: true, duration };

    } catch (error) {
      console.error('❌ CONTINUOUS RECORDING: Failed to stop:', error);
      // Reset state anyway
      this.currentEgressId = null;
      this.isRecording = false;
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
      isActiveFromDisk
    };
  }

  /**
   * Clean up stale/zombie egress jobs that are marked active but not actually recording
   */
  async cleanupStaleEgress() {
    try {
      const egresses = await this.egressClient.listEgress({ roomName: this.roomName });
      const activeEgresses = egresses.filter(e => e.status === 0 || e.status === 1);

      if (activeEgresses.length > 0) {
        // RESUME the active recording instead of stopping it
        const activeEgress = activeEgresses[0];
        console.log(`🔄 CONTINUOUS RECORDING: Found active egress ${activeEgress.egressId}, resuming state...`);

        this.currentEgressId = activeEgress.egressId;
        this.isRecording = true;
        this.recordingStartTime = Date.now();
        this.currentSessionId = this.extractSessionIdFromEgress(activeEgress);

        console.log(`✅ CONTINUOUS RECORDING: Resumed recording - session: ${this.currentSessionId}`);

        // If there are multiple active egresses (shouldn't happen), stop the extras
        for (let i = 1; i < activeEgresses.length; i++) {
          const extraEgress = activeEgresses[i];
          try {
            console.log(`🧹 CONTINUOUS RECORDING: Stopping extra egress ${extraEgress.egressId}...`);
            await this.egressClient.stopEgress(extraEgress.egressId);
          } catch (err) {
            console.log(`🔍 CONTINUOUS RECORDING: Could not stop extra egress: ${err.message}`);
          }
        }
      }
    } catch (error) {
      console.error('❌ CONTINUOUS RECORDING: Error in egress check:', error.message);
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
        console.log(`🔍 CONTINUOUS RECORDING: Found ${egresses.length} egress job(s):`);
        egresses.forEach(e => {
          const statusNames = ['STARTING', 'ACTIVE', 'ENDING', 'COMPLETE', 'FAILED'];
          console.log(`   - ${e.egressId}: status=${e.status} (${statusNames[e.status] || 'UNKNOWN'})`);
        });
      }

      // Only return actually active egresses (status 0 or 1)
      const activeEgresses = egresses.filter(e => e.status === 0 || e.status === 1);
      console.log(`🔍 CONTINUOUS RECORDING: ${activeEgresses.length} egress job(s) are currently active`);

      return activeEgresses;
    } catch (error) {
      console.error('❌ CONTINUOUS RECORDING: Failed to list egress:', error.message);
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
      console.error('❌ CONTINUOUS RECORDING: Failed to get egress info:', error);
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
      console.error('❌ CONTINUOUS RECORDING: Failed to list recordings:', error);
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
    console.log(`🔍 CLIP SEARCH: Starting findSegmentsForClip`);
    console.log(`🔍 CLIP SEARCH: outputDir = ${this.outputDir}`);

    const recordings = await this.getAvailableRecordings();
    const neededSegments = [];

    console.log(`🔍 CLIP SEARCH: Looking for segments between ${startMs} and ${endMs}`);
    console.log(`🔍 CLIP SEARCH: Found ${recordings.length} recording sessions`);
    recordings.forEach(r => {
      console.log(`   Session ${r.sessionId}: start=${r.startTime}, end=${r.startTime + r.durationMs}, segments=${r.segmentCount}`);
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

    console.log(`🔍 CLIP SEARCH: Found ${neededSegments.length} matching segments`);
    if (neededSegments.length === 0) {
      console.log(`⚠️ CLIP SEARCH: No segments found! Requested range: ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}`);
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
   * Clean up recordings older than retention period
   */
  cleanupOldRecordings() {
    try {
      const cutoffTime = Date.now() - (this.retentionMinutes * 60 * 1000);
      const items = fs.readdirSync(this.outputDir);
      let deletedCount = 0;

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
              // Delete the entire session directory
              fs.rmSync(itemPath, { recursive: true, force: true });
              deletedCount++;
            }
          }
        } else if (item.endsWith('.mp4') || item.endsWith('.json')) {
          // Clean up old single-file recordings too
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

      if (deletedCount > 0) {
        console.log(`🧹 CONTINUOUS RECORDING: Cleaned up ${deletedCount} old recording(s)`);
      }

    } catch (error) {
      console.error('❌ CONTINUOUS RECORDING: Cleanup error:', error);
    }
  }

  /**
   * Stop the service
   */
  async shutdown() {
    console.log('🛑 CONTINUOUS RECORDING: Shutting down...');

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    if (this.autoRecordInterval) {
      clearInterval(this.autoRecordInterval);
    }

    if (this.isRecording) {
      await this.stopRecording();
    }

    console.log('✅ CONTINUOUS RECORDING: Shutdown complete');
  }
}

module.exports = ContinuousRecordingService;
