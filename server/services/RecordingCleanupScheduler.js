/**
 * RecordingCleanupScheduler - Manages deletion of expired recordings
 *
 * Runs daily to delete recordings older than the configured retention period
 * from both Backblaze B2 and the local database.
 */

const { runAsync, getAsync, allAsync } = require('../database/database');
const b2Storage = require('./B2StorageService');

class RecordingCleanupScheduler {
    constructor(config = {}) {
        this.checkIntervalMs = config.checkIntervalMs || 60 * 60 * 1000; // Check every hour
        this.checkInterval = null;

        console.log('[CleanupScheduler] Initialized');
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

        console.log('[CleanupScheduler] Started');
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
            console.error('[CleanupScheduler] Error getting retention setting:', error.message);
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

            console.log(`[CleanupScheduler] Running cleanup - retention: ${retentionDays} days, cutoff: ${new Date(cutoffTime).toISOString()}`);

            // Find expired sessions
            const expiredSessions = await allAsync(`
                SELECT * FROM recording_sessions
                WHERE start_time < ? AND status IN ('completed', 'uploaded')
            `, [cutoffTime]);

            if (expiredSessions.length === 0) {
                return;
            }

            console.log(`[CleanupScheduler] Found ${expiredSessions.length} expired session(s) to delete`);

            let deletedCount = 0;
            let errorCount = 0;

            for (const session of expiredSessions) {
                try {
                    await this.deleteSession(session);
                    deletedCount++;
                } catch (error) {
                    console.error(`[CleanupScheduler] Error deleting session ${session.session_id}:`, error.message);
                    errorCount++;
                }
            }

            console.log(`[CleanupScheduler] Cleanup complete - deleted: ${deletedCount}, errors: ${errorCount}`);

        } catch (error) {
            console.error('[CleanupScheduler] Error running cleanup:', error.message);
        }
    }

    /**
     * Delete a single session and all its data
     * @param {object} session - Session record from database
     */
    async deleteSession(session) {
        console.log(`[CleanupScheduler] Deleting session ${session.session_id}`);

        // Delete from B2 if uploaded
        if (session.b2_file_name && b2Storage.isEnabled()) {
            const result = await b2Storage.deleteFile(session.b2_file_name);
            if (!result.success) {
                console.warn(`[CleanupScheduler] Could not delete B2 file: ${result.error}`);
            }
        }

        // Delete chat messages (cascade should handle this, but be explicit)
        await runAsync('DELETE FROM session_chat_messages WHERE session_id = ?', [session.session_id]);

        // Delete session record
        await runAsync('DELETE FROM recording_sessions WHERE session_id = ?', [session.session_id]);

        console.log(`[CleanupScheduler] Deleted session ${session.session_id}`);
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
            console.error(`[CleanupScheduler] Error deleting session ${sessionId}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get cleanup status
     */
    async getStatus() {
        const retentionDays = await this.getRetentionDays();
        const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

        // Count sessions that would be deleted
        const expiredCount = await getAsync(`
            SELECT COUNT(*) as count FROM recording_sessions
            WHERE start_time < ? AND status IN ('completed', 'uploaded')
        `, [cutoffTime]);

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

            console.log(`[CleanupScheduler] Retention set to ${clampedDays} days`);
            return { success: true, retentionDays: clampedDays };
        } catch (error) {
            console.error('[CleanupScheduler] Error setting retention:', error.message);
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
        console.log('[CleanupScheduler] Stopped');
    }
}

module.exports = RecordingCleanupScheduler;
