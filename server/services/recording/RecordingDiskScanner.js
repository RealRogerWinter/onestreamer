const path = require('path');
const fs = require('fs');

const logger = require('../../bootstrap/logger').child({ svc: 'RecordingDiskScanner' });

/**
 * RecordingDiskScanner - disk-facing collaborator for ContinuousRecordingService.
 *
 * Owns the on-disk session-directory scanning, the clippable-range / segment
 * lookup used by clip creation, and the retention cleanup loop. Extracted
 * verbatim from ContinuousRecordingService; behavior unchanged.
 *
 * @param {Object} deps
 * @param {string} deps.outputDir - Egress recordings output directory.
 * @param {number} deps.segmentDuration - Segment duration in seconds.
 * @param {number} deps.retentionMinutes - Retention window in minutes.
 * @param {Object} deps.recordingRepository - ContinuousRecordingRepository.
 * @param {Object} deps.owner - Back-reference to the service for live state
 *   (currentSessionId).
 */
class RecordingDiskScanner {
  constructor({ outputDir, segmentDuration, retentionMinutes, recordingRepository, owner }) {
    this.outputDir = outputDir;
    this.segmentDuration = segmentDuration;
    this.retentionMinutes = retentionMinutes;
    this.recordingRepository = recordingRepository;
    this.owner = owner;
    this.cleanupInterval = null;
  }

  /**
   * Scan the output directory for `session_` directories, reporting the `.ts`
   * segments in each and whether the session looks active (latest segment
   * mtime within 30s). Shared by getStatus/getAvailableRecordings/cleanup.
   *
   * @returns {Array<{sessionId,itemPath,stat,segments,isActiveFromDisk,latestSegmentAge}>}
   */
  _scanSessionDirs() {
    const results = [];
    const items = fs.readdirSync(this.outputDir);

    for (const item of items) {
      if (!item.startsWith('session_')) {
        continue;
      }
      const itemPath = path.join(this.outputDir, item);
      const stat = fs.statSync(itemPath);
      if (!stat.isDirectory()) {
        continue;
      }

      const segments = fs.readdirSync(itemPath).filter(f => f.endsWith('.ts'));

      let isActiveFromDisk = false;
      let latestSegmentAge = null;
      if (segments.length > 0) {
        const latestSegment = segments.sort().slice(-1)[0];
        const latestPath = path.join(itemPath, latestSegment);
        const latestStat = fs.statSync(latestPath);
        latestSegmentAge = Date.now() - latestStat.mtimeMs;
        if (latestSegmentAge < 30000) { // Active if segment within 30 seconds
          isActiveFromDisk = true;
        }
      }

      results.push({ sessionId: item, itemPath, stat, segments, isActiveFromDisk, latestSegmentAge });
    }

    return results;
  }

  /**
   * Disk-scanning branch of getStatus(): returns whether any session on disk
   * appears active and the first such session id.
   */
  getDiskStatus() {
    let isActiveFromDisk = false;
    let activeSessionFromDisk = null;

    try {
      for (const entry of this._scanSessionDirs()) {
        if (entry.isActiveFromDisk) {
          isActiveFromDisk = true;
          activeSessionFromDisk = entry.sessionId;
          break;
        }
      }
    } catch (e) {
      // Ignore disk check errors
    }

    return { isActiveFromDisk, activeSessionFromDisk };
  }

  /**
   * Get all available recording sessions for clipping
   * Returns sessions sorted by time with their segment info
   */
  async getAvailableRecordings() {
    const recordings = [];

    try {
      for (const entry of this._scanSessionDirs()) {
        const { sessionId, itemPath, stat } = entry;
        const playlistPath = path.join(itemPath, 'playlist.m3u8');
        const livePlaylistPath = path.join(itemPath, 'live.m3u8');

        // Check if we have a playlist
        const hasPlaylist = fs.existsSync(playlistPath) || fs.existsSync(livePlaylistPath);

        if (hasPlaylist) {
          // Get segment files
          const segments = entry.segments
            .slice()
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
              isActive: this.owner.currentSessionId === sessionId || isActiveFromDisk,
              latestSegmentAge: segmentAge
            });
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
          if (item === this.owner.currentSessionId) {
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

  /**
   * Stop the cleanup interval (used during service shutdown).
   */
  stopCleanupInterval() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = RecordingDiskScanner;
