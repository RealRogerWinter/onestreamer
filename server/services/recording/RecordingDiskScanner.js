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
  constructor({ outputDir, segmentDuration, retentionMinutes, recordingRepository, owner, pendingUploadMaxAgeMs, diskBudgetBytes }) {
    this.outputDir = outputDir;
    this.segmentDuration = segmentDuration;
    this.retentionMinutes = retentionMinutes;
    this.recordingRepository = recordingRepository;
    this.owner = owner;
    this.cleanupInterval = null;
    // Backstop against the pending-upload gate pinning a dir forever (the
    // 37 GB leak): a dir whose upload never confirms is reclaimed once its
    // newest segment is older than this, regardless of b2_file_id. Mirrors the
    // DB-side RecordingCleanupScheduler extendedCutoff valve. Default covers
    // RecordingUploadScheduler.localBufferHours (2h) + RecordingCleanupScheduler
    // retryWindow (24h) with margin.
    this.pendingUploadMaxAgeMs = pendingUploadMaxAgeMs || (26 * 60 * 60 * 1000);
    // Hard disk-budget backstop independent of upload state (defense in depth).
    this.diskBudgetBytes = diskBudgetBytes || (20 * 1024 * 1024 * 1024);
  }

  /**
   * Age (ms) of a session dir measured from its NEWEST `.ts` segment's mtime,
   * not the dir-name date. A `recording_<YYYY-MM-DD>` bucket reads as hours old
   * by its name even while it holds minutes-old segments, so name-based age
   * would delete fresh footage during the `currentSessionId===null` window.
   * Returns null when the dir has no segments.
   */
  _newestSegmentAgeMs(dirPath, now = Date.now()) {
    let newest = 0;
    try {
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith('.ts')) continue;
        try {
          const m = fs.statSync(path.join(dirPath, f)).mtimeMs;
          if (m > newest) newest = m;
        } catch (_) { /* segment vanished mid-scan — ignore */ }
      }
    } catch (_) {
      return null;
    }
    return newest > 0 ? (now - newest) : null;
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
      if (this._parseSessionDir(item) === null) {
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
        const { sessionId, itemPath } = entry;
        const playlistPath = path.join(itemPath, 'playlist.m3u8');
        const livePlaylistPath = path.join(itemPath, 'live.m3u8');

        // Check if we have a playlist
        const hasPlaylist = fs.existsSync(playlistPath) || fs.existsSync(livePlaylistPath);

        if (hasPlaylist) {
          // Stat every segment for its mtime — the segment file's completion
          // time is the only reliable per-segment timestamp now that egress
          // writes per-DAY `recording_<date>` buckets (the dir name is a date,
          // not a start time, and segments aren't start-aligned). A finished
          // segment covers roughly [mtime - segmentDuration, mtime].
          const segDurMs = this.segmentDuration * 1000;
          const segMeta = entry.segments
            .map((file) => {
              try {
                return { file, mtimeMs: fs.statSync(path.join(itemPath, file)).mtimeMs };
              } catch (_) {
                return null;
              }
            })
            .filter(Boolean)
            .sort((a, b) => a.mtimeMs - b.mtimeMs);

          if (segMeta.length > 0) {
            const segments = segMeta.map((s) => s.file);
            const startTime = segMeta[0].mtimeMs - segDurMs; // first segment's media start
            const endTime = segMeta[segMeta.length - 1].mtimeMs;
            const durationMs = Math.max(0, endTime - startTime);
            const segmentAge = Date.now() - endTime;
            const isActiveFromDisk = segmentAge < 30000;

            recordings.push({
              sessionId,
              path: itemPath,
              startTime,
              segments,
              segMeta, // per-segment {file, mtimeMs} for findSegmentsForClip
              segmentCount: segments.length,
              duration: Math.round(durationMs / 1000), // in seconds
              durationMs,
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
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Failed to list recordings');
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

    const segmentDurationMs = this.segmentDuration * 1000;
    for (const recording of recordings) {
      const recordingEndMs = recording.startTime + recording.durationMs;

      // Skip recordings whose overall span doesn't overlap the clip window.
      if (recording.startTime > endMs || recordingEndMs < startMs) {
        continue;
      }

      // Map each segment by its REAL mtime, not startTime + index*duration: the
      // per-day bucket can contain gaps (stream stop/restart within the day)
      // that the index math silently mis-times. A finished segment covers
      // roughly [mtime - segmentDuration, mtime].
      const meta = recording.segMeta || [];
      for (let i = 0; i < meta.length; i++) {
        const segmentEndMs = meta[i].mtimeMs;
        const segmentStartMs = segmentEndMs - segmentDurationMs;
        if (segmentStartMs < endMs && segmentEndMs > startMs) {
          neededSegments.push({
            sessionId: recording.sessionId,
            segmentFile: meta[i].file,
            segmentPath: path.join(recording.path, meta[i].file),
            segmentIndex: i,
            startMs: segmentStartMs,
            endMs: segmentEndMs
          });
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
   * Recognize a recording session directory and return its start timestamp in
   * ms, or null if the name isn't a session dir. Handles the current egress
   * format `recording_<YYYY-MM-DD>` (a per-day bucket; the date parses to that
   * day's UTC midnight) and the legacy `session_<unix-ms>` format older builds
   * wrote. The previous code matched ONLY `session_`, so against today's
   * `recording_<date>` dirs every cleanup scan found nothing — the root cause
   * of the unbounded disk growth.
   */
  _parseSessionDir(item) {
    let m = item.match(/^recording_(\d{4}-\d{2}-\d{2})$/);
    if (m) {
      const ts = Date.parse(`${m[1]}T00:00:00Z`);
      return Number.isNaN(ts) ? null : ts;
    }
    m = item.match(/^session_(\d+)$/);
    if (m) {
      return parseInt(m[1], 10);
    }
    return null;
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
      const now = Date.now();
      const retentionMs = this.retentionMinutes * 60 * 1000;
      const cutoffTime = now - retentionMs;

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
        logger.error({ err: dbError }, '❌ CONTINUOUS RECORDING: Cleanup aborted — failed to load pending uploads');
        return;
      }

      const items = fs.readdirSync(this.outputDir);
      let deletedCount = 0;
      let skippedPendingUpload = 0;
      let reclaimedStale = 0;

      for (const item of items) {
        const itemPath = path.join(this.outputDir, item);
        let stat;
        try {
          stat = fs.statSync(itemPath);
        } catch (_) {
          continue; // vanished mid-scan
        }

        // Recognize both `recording_<YYYY-MM-DD>` (current egress buckets) and
        // legacy `session_<unix-ms>` dirs.
        const sessionTs = stat.isDirectory() ? this._parseSessionDir(item) : null;
        if (sessionTs !== null) {
          // Never touch the live session dir.
          if (item === this.owner.currentSessionId) {
            continue;
          }

          // Age from the NEWEST segment mtime, not the dir-name date (which for
          // a per-day bucket reads as hours old even when it holds fresh
          // segments). Empty dirs fall back to the dir-name date.
          const newestAgeMs = this._newestSegmentAgeMs(itemPath, now);
          const dirAgeMs = newestAgeMs !== null ? newestAgeMs : (now - sessionTs);

          // Still inside the rolling retention window — keep it.
          if (dirAgeMs < retentionMs) {
            continue;
          }

          if (pendingSessionIds.has(item)) {
            // PR 2.6 gate: normally skip dirs whose recording_sessions row still
            // has b2_file_id = NULL (upload pending/in-flight) so we don't race
            // the uploader. BUT bound it: past pendingUploadMaxAgeMs the upload
            // is never going to confirm (B2 off, or a permanently-failed
            // session), and an unbounded skip pins the dir forever — the 37 GB
            // leak. Reclaim it, loudly.
            if (dirAgeMs < this.pendingUploadMaxAgeMs) {
              skippedPendingUpload++;
              continue;
            }
            logger.warn(
              `🧹 CONTINUOUS RECORDING: Reclaiming stale pending-upload dir ${item} ` +
              `(newest segment ${Math.round(dirAgeMs / 3600000)}h old, past ` +
              `${Math.round(this.pendingUploadMaxAgeMs / 3600000)}h grace) — upload never confirmed`
            );
            fs.rmSync(itemPath, { recursive: true, force: true });
            reclaimedStale++;
            continue;
          }

          // Uploaded (or untracked) and past retention — delete.
          fs.rmSync(itemPath, { recursive: true, force: true });
          deletedCount++;
        } else if (!stat.isDirectory() && (item.endsWith('.mp4') || item.endsWith('.json'))) {
          // Legacy single-file recordings (not produced by current pipeline).
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

      if (deletedCount > 0 || skippedPendingUpload > 0 || reclaimedStale > 0) {
        const parts = [];
        if (skippedPendingUpload > 0) parts.push(`skipped ${skippedPendingUpload} pending B2 upload`);
        if (reclaimedStale > 0) parts.push(`reclaimed ${reclaimedStale} stale un-uploaded`);
        const suffix = parts.length ? ` (${parts.join(', ')})` : '';
        logger.debug(`🧹 CONTINUOUS RECORDING: Cleaned up ${deletedCount} old recording(s)${suffix}`);
      }

      // Hard disk-budget backstop, independent of upload state — defense in
      // depth against any future regression of the gate above.
      this._enforceDiskBudget(now);

    } catch (error) {
      logger.error({ err: error }, '❌ CONTINUOUS RECORDING: Cleanup error');
    }
  }

  /**
   * Total bytes of a directory's immediate files (segments live one level deep).
   */
  _dirSizeBytes(dirPath) {
    let total = 0;
    try {
      for (const f of fs.readdirSync(dirPath)) {
        try {
          total += fs.statSync(path.join(dirPath, f)).size;
        } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
    return total;
  }

  /**
   * If the recordings footprint exceeds diskBudgetBytes, delete the oldest
   * (by newest-segment mtime) session dirs — never the live one, never a dir
   * still inside the rolling window — until under budget. This is a last-resort
   * guard: after the age-backstop above runs, the footprint should already be
   * small, so this normally computes sizes over a handful of dirs and deletes
   * nothing.
   */
  _enforceDiskBudget(now = Date.now()) {
    let entries;
    try {
      entries = fs.readdirSync(this.outputDir);
    } catch (_) {
      return;
    }
    const retentionMs = this.retentionMinutes * 60 * 1000;
    const dirs = [];
    let totalBytes = 0;
    for (const item of entries) {
      if (this._parseSessionDir(item) === null) continue;
      const itemPath = path.join(this.outputDir, item);
      let stat;
      try {
        stat = fs.statSync(itemPath);
      } catch (_) {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const size = this._dirSizeBytes(itemPath);
      totalBytes += size;
      const ageMs = this._newestSegmentAgeMs(itemPath, now);
      dirs.push({ item, itemPath, size, ageMs: ageMs === null ? Infinity : ageMs });
    }

    if (totalBytes <= this.diskBudgetBytes) return;

    // Oldest first; protect the live dir and anything inside the rolling window.
    dirs.sort((a, b) => b.ageMs - a.ageMs);
    for (const d of dirs) {
      if (totalBytes <= this.diskBudgetBytes) break;
      if (d.item === this.owner.currentSessionId) continue;
      if (d.ageMs < retentionMs) continue;
      logger.warn(
        `🧹 CONTINUOUS RECORDING: Disk-budget backstop deleting ${d.item} ` +
        `(${Math.round(d.size / 1e9 * 10) / 10} GB) — footprint over ` +
        `${Math.round(this.diskBudgetBytes / 1e9)} GB budget`
      );
      try {
        fs.rmSync(d.itemPath, { recursive: true, force: true });
        totalBytes -= d.size;
      } catch (e) {
        logger.error({ err: e }, `❌ CONTINUOUS RECORDING: Disk-budget delete failed for ${d.item}`);
      }
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
