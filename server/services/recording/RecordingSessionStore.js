const logger = require('../../bootstrap/logger').child({ svc: 'RecordingSessionStore' });

/**
 * RecordingSessionStore - DB-facing collaborator for ContinuousRecordingService.
 *
 * Owns the recording_sessions / recording_stream_segments writes and the
 * stream-identity-change bookkeeping. Extracted verbatim from
 * ContinuousRecordingService; behavior unchanged.
 *
 * @param {Object} deps
 * @param {Object} deps.recordingRepository - ContinuousRecordingRepository.
 * @param {Object} deps.userRepository - UserRepository.
 * @param {Object} deps.inspector - RoomParticipantInspector (for current stream info).
 * @param {Object} deps.owner - Back-reference to the service for live state
 *   (isRecording, currentSessionId, currentStreamIdentity, currentStreamSegmentId).
 */
class RecordingSessionStore {
  constructor({ recordingRepository, userRepository, inspector, owner }) {
    this.recordingRepository = recordingRepository;
    this.userRepository = userRepository;
    this.inspector = inspector;
    this.owner = owner;
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

      // Per-run session ids (ADR-0028): every run inserts a fresh row.
      // INSERT OR IGNORE remains as a guard against a re-entrant create
      // for the same run id.
      await this.recordingRepository.insertSessionIfMissing({
        sessionId, streamerIdentity, streamerUserId, streamerUsername, startTime, localPath,
      });

      // Re-activate the row for a re-entrant start of the SAME run. The
      // repository guard refuses to downgrade 'uploaded'/'processing'
      // rows (audit R8).
      await this.recordingRepository.setSessionRecording(sessionId);

      logger.debug(`📝 SESSION DB: Recording session ${sessionId} active for streamer ${streamerUsername || streamerIdentity || 'room'}`);
      return { success: true };
    } catch (error) {
      logger.error({ err: error }, '❌ SESSION DB: Failed to create session record');
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

      await this.recordingRepository.updateSessionEnd(sessionId, {
        endTime, durationMs, segmentCount,
      });

      // Per-run sessions reach a terminal state when the run stops
      // (ADR-0028): 'completed' is what upload recovery and DB-row
      // reaping key on. The retired per-day model deliberately never
      // wrote this ("session represents the whole day"), which left
      // rows in 'recording' forever.
      await this.recordingRepository.markSessionCompleted(sessionId);

      logger.debug(`📝 SESSION DB: Updated session ${sessionId} - duration: ${Math.floor(durationMs / 1000)}s, added ${segmentCount} segments`);
      return { success: true };
    } catch (error) {
      logger.error({ err: error }, '❌ SESSION DB: Failed to update session record');
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
      logger.error({ err: error }, '❌ STREAM TRACKING: Failed to log segment start');
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
      logger.error({ err: error }, '❌ STREAM TRACKING: Failed to log segment end');
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
      logger.error({ err: error }, '❌ STREAM TRACKING: Failed to end open segments');
    }
  }

  /**
   * Check for stream identity changes and log them
   */
  async trackStreamIdentityChange() {
    if (!this.owner.isRecording || !this.owner.currentSessionId) {
      return;
    }

    try {
      const streamInfo = await this.inspector.getCurrentStreamInfo();

      // Build a comparable identity string
      const currentIdentity = streamInfo ? `${streamInfo.type}:${streamInfo.identity}` : null;

      // Check if stream identity changed
      if (currentIdentity !== this.owner.currentStreamIdentity) {
        logger.debug(`🔄 STREAM TRACKING: Identity changed from "${this.owner.currentStreamIdentity}" to "${currentIdentity}"`);

        // End the previous segment if there was one
        if (this.owner.currentStreamSegmentId) {
          await this.logStreamSegmentEnd(this.owner.currentStreamSegmentId);
          this.owner.currentStreamSegmentId = null;
        }

        // Start a new segment if there's a new stream
        if (streamInfo) {
          this.owner.currentStreamSegmentId = await this.logStreamSegmentStart(this.owner.currentSessionId, streamInfo);
        }

        this.owner.currentStreamIdentity = currentIdentity;
      }

    } catch (error) {
      logger.error({ err: error }, '❌ STREAM TRACKING: Error tracking identity change');
    }
  }
}

module.exports = RecordingSessionStore;
