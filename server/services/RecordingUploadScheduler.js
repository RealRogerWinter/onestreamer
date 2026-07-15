/**
 * RecordingUploadScheduler - Manages upload of completed recording sessions to B2
 *
 * Listens for recording-stopped events and schedules upload after the local buffer period.
 * Concatenates HLS segments to MP4 and uploads to Backblaze B2.
 */

const { runAsync, getAsync, allAsync } = require('../database/database');
const b2Storage = require('./B2StorageService');
const path = require('path');
const fs = require('fs');

const logger = require('../bootstrap/logger').child({ svc: 'RecordingUploadScheduler' });
class RecordingUploadScheduler {
    constructor(config = {}) {
        this.localBufferHours = config.localBufferHours || 2;
        this.checkIntervalMs = config.checkIntervalMs || 5 * 60 * 1000; // Check every 5 minutes
        this.uploadQueue = new Map(); // sessionId -> scheduledTime
        this.isProcessing = false;
        this.checkInterval = null;

        // P2.2: terminal-failure bookkeeping. After maxUploadAttempts
        // consecutive transient failures (12 × 30min ≈ 6h, inside the disk
        // scanner's 26h pending-dir grace) the session goes to the terminal
        // 'upload_failed' status so the cleaner can reclaim it. The counter
        // is deliberately in-memory: a restart resets it, but the
        // local-recording-missing path (dir reclaimed at 26h) guarantees
        // termination anyway, and persisting it would need a schema change
        // for no behavioral gain.
        this.maxUploadAttempts = config.maxUploadAttempts || 12;
        this.attempts = new Map(); // sessionId -> consecutive failure count
        this.processingStartedAt = null; // watchdog on the isProcessing latch

        logger.debug(`[UploadScheduler] Initialized with ${this.localBufferHours}h local buffer`);
    }

    /**
     * Start the scheduler
     */
    start() {
        if (!b2Storage.isEnabled()) {
            logger.debug('[UploadScheduler] B2 storage not configured, scheduler disabled');
            return;
        }

        // Load pending uploads from database
        this.loadPendingUploads();

        // Start periodic check
        this.checkInterval = setInterval(() => {
            this.processPendingUploads();
        }, this.checkIntervalMs);

        logger.debug('[UploadScheduler] Started');
    }

    /**
     * Load any sessions that need uploading from database.
     *
     * Status-agnostic on purpose (ADR-0028): the old
     * `WHERE status = 'completed'` recovered nothing because the retired
     * per-day session model never wrote a terminal status. Anything with a
     * finished recording (end_time set) and no confirmed archive
     * (b2_file_id NULL) is a recovery candidate — including stale
     * 'processing' rows from a crash mid-upload (the every-boot
     * 202607140001 migration also resets those to 'completed' for the
     * DB-row reaper's benefit).
     *
     * ADDITIVE: never overwrite an entry already in uploadQueue — a failed
     * upload sits there with a +30min retry backoff, and re-deriving its
     * schedule from end_time+buffer (long past due) would collapse the
     * backoff into a tight retry loop.
     */
    async loadPendingUploads() {
        try {
            const sessions = await allAsync(`
                SELECT * FROM recording_sessions
                WHERE b2_file_id IS NULL AND end_time IS NOT NULL AND status NOT IN ('uploaded', 'upload_failed')
                ORDER BY end_time ASC
            `);

            let queued = 0;
            for (const session of sessions) {
                if (this.uploadQueue.has(session.session_id)) {
                    continue;
                }
                const scheduledTime = session.end_time + (this.localBufferHours * 60 * 60 * 1000);
                this.uploadQueue.set(session.session_id, scheduledTime);
                queued++;
                logger.debug(`[UploadScheduler] Queued session ${session.session_id} for upload at ${new Date(scheduledTime).toISOString()}`);
            }

            if (queued > 0) {
                logger.debug(`[UploadScheduler] Loaded ${queued} pending uploads from database`);
            }
        } catch (error) {
            logger.error({ err: error }, '[UploadScheduler] Error loading pending uploads');
        }
    }

    /**
     * Schedule a session for upload after the local buffer period
     * @param {string} sessionId - Recording session ID
     * @param {number} endTime - Session end time in milliseconds
     */
    scheduleUpload(sessionId, endTime) {
        if (!b2Storage.isEnabled()) {
            logger.debug(`[UploadScheduler] B2 not configured, skipping upload for ${sessionId}`);
            return;
        }

        const scheduledTime = endTime + (this.localBufferHours * 60 * 60 * 1000);
        this.uploadQueue.set(sessionId, scheduledTime);

        logger.debug(`[UploadScheduler] Scheduled ${sessionId} for upload at ${new Date(scheduledTime).toISOString()}`);
    }

    /**
     * Process any uploads that are due
     */
    async processPendingUploads() {
        if (this.isProcessing) {
            // P2.2 watchdog: alarm (don't force-release) if the latch has
            // been held implausibly long — every await under it is now
            // bounded (concat timeout + S3 request timeouts), so a trip
            // here means one of those bounds failed.
            const heldMs = this.processingStartedAt ? Date.now() - this.processingStartedAt : 0;
            if (heldMs > 2 * 60 * 60 * 1000) {
                logger.error(`[UploadScheduler] isProcessing latch held ${Math.round(heldMs / 60000)} min - a hung upload/concat is blocking all uploads`);
            }
            return;
        }

        this.isProcessing = true;
        this.processingStartedAt = Date.now();

        try {
            // Re-discover pending sessions each tick (additive — see
            // loadPendingUploads) so a missed recording-stopped event or a
            // restart can never strand a finished run un-archived.
            await this.loadPendingUploads();

            const now = Date.now();

            for (const [sessionId, scheduledTime] of this.uploadQueue) {
                if (scheduledTime <= now) {
                    logger.debug(`[UploadScheduler] Processing upload for session ${sessionId}`);

                    const result = await this.uploadSession(sessionId);

                    if (result.success) {
                        this.uploadQueue.delete(sessionId);
                        this.attempts.delete(sessionId);
                        logger.debug(`[UploadScheduler] Successfully uploaded session ${sessionId}`);
                    } else if (result.permanent) {
                        // P2.2: terminal — the session is 'upload_failed' in
                        // the DB; stop retrying so the cleaner can reclaim it.
                        this.uploadQueue.delete(sessionId);
                        this.attempts.delete(sessionId);
                        logger.error(`[UploadScheduler] Giving up on ${sessionId} (upload_failed): ${result.error}`);
                    } else {
                        // Retry in 30 minutes
                        this.uploadQueue.set(sessionId, now + 30 * 60 * 1000);
                        logger.error(`[UploadScheduler] Failed to upload ${sessionId}, will retry: ${result.error}`);
                    }
                }
            }
        } catch (error) {
            logger.error({ err: error }, '[UploadScheduler] Error processing uploads');
        } finally {
            this.isProcessing = false;
            this.processingStartedAt = null;
        }
    }

    /**
     * Upload a single session to B2
     * @param {string} sessionId - Recording session ID
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async uploadSession(sessionId) {
        try {
            // Get session from database
            const session = await getAsync('SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);

            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            if (session.b2_file_id) {
                logger.debug(`[UploadScheduler] Session ${sessionId} already uploaded`);
                return { success: true };
            }

            // Check if local path exists
            if (!session.local_path || !fs.existsSync(session.local_path)) {
                // Try default path
                const defaultPath = path.join(process.env.EGRESS_RECORDINGS_DIR || '/root/onestreamer/egress-recordings', sessionId);
                if (!fs.existsSync(defaultPath)) {
                    // P2.2: PERMANENT — the source dir is gone (reclaimed by
                    // the disk scanner after its 26h grace), so this upload
                    // can never succeed. Terminal status lets the DB-row
                    // cleaner reap it instead of retrying forever.
                    await runAsync(
                        'UPDATE recording_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                        ['upload_failed', sessionId]
                    );
                    return { success: false, permanent: true, error: 'Local recording not found' };
                }
                session.local_path = defaultPath;
            }

            // Update status to processing
            await runAsync(
                'UPDATE recording_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                ['processing', sessionId]
            );

            // Process and upload
            const metadata = {
                streamerIdentity: session.streamer_identity || 'unknown',
                streamerUsername: session.streamer_username || 'unknown',
                startTime: session.start_time?.toString() || '',
                endTime: session.end_time?.toString() || '',
                durationMs: session.duration_ms?.toString() || '',
                segmentCount: session.segment_count?.toString() || ''
            };

            const result = await b2Storage.processAndUploadSession(
                sessionId,
                session.local_path,
                metadata
            );

            if (result.success) {
                // Update database with B2 info
                await runAsync(`
                    UPDATE recording_sessions
                    SET b2_file_id = ?, b2_file_name = ?, file_size_bytes = ?, status = 'uploaded', updated_at = CURRENT_TIMESTAMP
                    WHERE session_id = ?
                `, [result.fileId, result.fileName, result.fileSize, sessionId]);

                // Optionally delete local files
                await this.cleanupLocalFiles(session.local_path);

                this.attempts.delete(sessionId);
                return { success: true };
            } else {
                // P2.2: cap consecutive transient failures — after
                // maxUploadAttempts, flip to the terminal 'upload_failed'
                // instead of reverting to 'completed' for another retry.
                const attemptCount = (this.attempts.get(sessionId) || 0) + 1;
                this.attempts.set(sessionId, attemptCount);
                if (attemptCount >= this.maxUploadAttempts) {
                    await runAsync(
                        'UPDATE recording_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                        ['upload_failed', sessionId]
                    );
                    return { success: false, permanent: true, error: `${result.error} (giving up after ${attemptCount} attempts)` };
                }
                // Revert status
                await runAsync(
                    'UPDATE recording_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                    ['completed', sessionId]
                );
                return { success: false, error: result.error };
            }
        } catch (error) {
            logger.error({ err: error }, `[UploadScheduler] Error uploading session ${sessionId}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Clean up local recording files after successful upload
     * @param {string} localPath - Path to local recording directory
     */
    async cleanupLocalFiles(localPath) {
        try {
            if (fs.existsSync(localPath)) {
                fs.rmSync(localPath, { recursive: true, force: true });
                logger.debug(`[UploadScheduler] Cleaned up local files: ${localPath}`);
            }
        } catch (error) {
            logger.error({ err: error }, '[UploadScheduler] Error cleaning up local files');
        }
    }

    /**
     * Force upload a session immediately (for admin use)
     * @param {string} sessionId - Recording session ID
     */
    async forceUpload(sessionId) {
        return await this.uploadSession(sessionId);
    }

    /**
     * Get scheduler status
     */
    getStatus() {
        return {
            enabled: b2Storage.isEnabled(),
            localBufferHours: this.localBufferHours,
            pendingUploads: this.uploadQueue.size,
            queuedSessions: Array.from(this.uploadQueue.entries()).map(([sessionId, time]) => ({
                sessionId,
                scheduledTime: new Date(time).toISOString(),
                ready: time <= Date.now()
            }))
        };
    }

    /**
     * Stop the scheduler
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        logger.debug('[UploadScheduler] Stopped');
    }
}

module.exports = RecordingUploadScheduler;
