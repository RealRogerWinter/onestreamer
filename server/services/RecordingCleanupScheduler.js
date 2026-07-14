/**
 * RecordingCleanupScheduler - Manages deletion of expired recordings
 *
 * Runs daily to delete recordings older than the configured retention period
 * from both Backblaze B2 and the local database.
 */

const { runAsync, getAsync, allAsync } = require('../database/database');
const b2Storage = require('./B2StorageService');

const logger = require('../bootstrap/logger').child({ svc: 'RecordingCleanupScheduler' });
class RecordingCleanupScheduler {
    constructor(config = {}) {
        this.checkIntervalMs = config.checkIntervalMs || 60 * 60 * 1000; // Check every hour
        this.checkInterval = null;
        // PR 8.4 (Phase 8): how much LONGER an un-uploaded recording is
        // kept past the retention cutoff to give `RecordingUploadScheduler`
        // a chance to finish retrying. Default 24 h. With retention = 7 d
        // and retry_window = 1 d, an un-uploaded session survives until
        // it's 8 d old; an uploaded session is cleaned at 7 d as before.
        // Closes the race documented in
        // `docs/architecture/background-work.md` ("Notable hazards →
        // Recording cleanup races recording upload"). The PR 2.6 fix
        // already gated the **filesystem** cleanup on b2_file_id; this
        // closes the matching gap in the **database** cleanup.
        this.retryWindowMs = config.retryWindowMs ?? (24 * 60 * 60 * 1000);

        logger.debug(`[CleanupScheduler] Initialized (retryWindowMs=${this.retryWindowMs})`);
    }

    /**
     * Start the scheduler
     */
    start() {
        // Run initial cleanup
        this.runCleanup();

        // Start periodic check
        this.checkInterval = setInterval(() => {
            this.runCleanup();
        }, this.checkIntervalMs);

        logger.debug('[CleanupScheduler] Started');
    }

    /**
     * Get the current retention setting
     * @returns {Promise<number>} Retention days (1-7)
     */
    async getRetentionDays() {
        try {
            const setting = await getAsync(
                "SELECT value FROM admin_review_settings WHERE key = 'retention_days'"
            );
            const days = parseInt(setting?.value || '7');
            return Math.max(1, Math.min(7, days)); // Clamp to 1-7 days
        } catch (error) {
            logger.error({ err: error }, '[CleanupScheduler] Error getting retention setting');
            return 7; // Default to 7 days
        }
    }

    /**
     * Run the cleanup process
     */
    async runCleanup() {
        try {
            const retentionDays = await this.getRetentionDays();
            const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
            // PR 8.4 (Phase 8): un-uploaded sessions get the retry-window
            // extension beyond the retention cutoff before they're eligible
            // for deletion. extendedCutoff is FURTHER in the past than
            // cutoff; `start_time < extendedCutoff` means age exceeds
            // retention + retry_window.
            const extendedCutoff = cutoffTime - this.retryWindowMs;

            logger.debug(`[CleanupScheduler] Running cleanup - retention: ${retentionDays} days, cutoff: ${new Date(cutoffTime).toISOString()}, extendedCutoff: ${new Date(extendedCutoff).toISOString()}`);

            // Find expired sessions. The `(b2_file_id IS NOT NULL OR
            // start_time < ?)` guard protects un-uploaded sessions from
            // being deleted while RecordingUploadScheduler is still
            // retrying. b2_file_id IS NOT NULL → confirmed uploaded
            // (safe to delete locally). start_time < extendedCutoff →
            // safety valve: even an un-uploaded session is cleaned up
            // eventually, so a permanently-failed upload doesn't leak
            // local storage forever.
            const expiredSessions = await allAsync(`
                SELECT * FROM recording_sessions
                WHERE start_time < ?
                  AND status IN ('completed', 'uploaded')
                  AND (b2_file_id IS NOT NULL OR start_time < ?)
            `, [cutoffTime, extendedCutoff]);

            if (expiredSessions.length === 0) {
                return;
            }

            logger.debug(`[CleanupScheduler] Found ${expiredSessions.length} expired session(s) to delete`);

            let deletedCount = 0;
            let errorCount = 0;

            for (const session of expiredSessions) {
                try {
                    await this.deleteSession(session);
                    deletedCount++;
                } catch (error) {
                    logger.error({ err: error }, `[CleanupScheduler] Error deleting session ${session.session_id}`);
                    errorCount++;
                }
            }

            logger.debug(`[CleanupScheduler] Cleanup complete - deleted: ${deletedCount}, errors: ${errorCount}`);

        } catch (error) {
            logger.error({ err: error }, '[CleanupScheduler] Error running cleanup');
        }
    }

    /**
     * Delete a single session and all its data
     * @param {object} session - Session record from database
     */
    async deleteSession(session) {
        logger.debug(`[CleanupScheduler] Deleting session ${session.session_id}`);

        // Delete from B2 if uploaded
        if (session.b2_file_name && b2Storage.isEnabled()) {
            const result = await b2Storage.deleteFile(session.b2_file_name);
            if (!result.success) {
                logger.warn(`[CleanupScheduler] Could not delete B2 file: ${result.error}`);
            }
        }

        // Delete chat messages (cascade should handle this, but be explicit)
        await runAsync('DELETE FROM session_chat_messages WHERE session_id = ?', [session.session_id]);

        // Delete session record
        await runAsync('DELETE FROM recording_sessions WHERE session_id = ?', [session.session_id]);

        logger.debug(`[CleanupScheduler] Deleted session ${session.session_id}`);
    }

    /**
     * Manually delete a session by ID (for admin use)
     * @param {string} sessionId - Session ID to delete
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteSessionById(sessionId) {
        try {
            const session = await getAsync('SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);

            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            await this.deleteSession(session);
            return { success: true };
        } catch (error) {
            logger.error({ err: error }, `[CleanupScheduler] Error deleting session ${sessionId}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get cleanup status
     */
    async getStatus() {
        const retentionDays = await this.getRetentionDays();
        const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
        // PR 8.4: mirror runCleanup's `(b2_file_id IS NOT NULL OR
        // start_time < extendedCutoff)` guard so getStatus reports the
        // same count the next tick will actually delete.
        const extendedCutoff = cutoffTime - this.retryWindowMs;

        // Count sessions that would be deleted
        const expiredCount = await getAsync(`
            SELECT COUNT(*) as count FROM recording_sessions
            WHERE start_time < ?
              AND status IN ('completed', 'uploaded')
              AND (b2_file_id IS NOT NULL OR start_time < ?)
        `, [cutoffTime, extendedCutoff]);

        // Get total session count
        const totalCount = await getAsync('SELECT COUNT(*) as count FROM recording_sessions');

        // Get total storage used (approximate based on file_size_bytes)
        const storageUsed = await getAsync(`
            SELECT SUM(file_size_bytes) as total FROM recording_sessions
            WHERE file_size_bytes IS NOT NULL
        `);

        return {
            retentionDays,
            cutoffTime: new Date(cutoffTime).toISOString(),
            // PR 8.4: surface the retry-window so admins can see why an
            // expected-to-be-cleaned session is still around.
            retryWindowMs: this.retryWindowMs,
            extendedCutoffTime: new Date(extendedCutoff).toISOString(),
            pendingDeletion: expiredCount?.count || 0,
            totalSessions: totalCount?.count || 0,
            totalStorageBytes: storageUsed?.total || 0,
            totalStorageMB: Math.round((storageUsed?.total || 0) / 1024 / 1024)
        };
    }

    /**
     * Update retention setting
     * @param {number} days - New retention days (1-7)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async setRetentionDays(days) {
        try {
            const clampedDays = Math.max(1, Math.min(7, parseInt(days)));

            await runAsync(`
                INSERT INTO admin_review_settings (key, value, updated_at)
                VALUES ('retention_days', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
            `, [clampedDays.toString(), clampedDays.toString()]);

            logger.debug(`[CleanupScheduler] Retention set to ${clampedDays} days`);
            return { success: true, retentionDays: clampedDays };
        } catch (error) {
            logger.error({ err: error }, '[CleanupScheduler] Error setting retention');
            return { success: false, error: error.message };
        }
    }

    /**
     * Stop the scheduler
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        logger.debug('[CleanupScheduler] Stopped');
    }
}

module.exports = RecordingCleanupScheduler;
