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

class RecordingUploadScheduler {
    constructor(config = {}) {
        this.localBufferHours = config.localBufferHours || 2;
        this.checkIntervalMs = config.checkIntervalMs || 5 * 60 * 1000; // Check every 5 minutes
        this.uploadQueue = new Map(); // sessionId -> scheduledTime
        this.isProcessing = false;
        this.checkInterval = null;

        console.log(`[UploadScheduler] Initialized with ${this.localBufferHours}h local buffer`);
    }

    /**
     * Start the scheduler
     */
    start() {
        if (!b2Storage.isEnabled()) {
            console.log('[UploadScheduler] B2 storage not configured, scheduler disabled');
            return;
        }

        // Load pending uploads from database
        this.loadPendingUploads();

        // Start periodic check
        this.checkInterval = setInterval(() => {
            this.processPendingUploads();
        }, this.checkIntervalMs);

        console.log('[UploadScheduler] Started');
    }

    /**
     * Load any sessions that need uploading from database
     */
    async loadPendingUploads() {
        try {
            // Find completed sessions that haven't been uploaded yet
            const sessions = await allAsync(`
                SELECT * FROM recording_sessions
                WHERE status = 'completed' AND b2_file_id IS NULL
                ORDER BY end_time ASC
            `);

            for (const session of sessions) {
                if (session.end_time) {
                    const scheduledTime = session.end_time + (this.localBufferHours * 60 * 60 * 1000);
                    this.uploadQueue.set(session.session_id, scheduledTime);
                    console.log(`[UploadScheduler] Queued session ${session.session_id} for upload at ${new Date(scheduledTime).toISOString()}`);
                }
            }

            console.log(`[UploadScheduler] Loaded ${sessions.length} pending uploads from database`);
        } catch (error) {
            console.error('[UploadScheduler] Error loading pending uploads:', error.message);
        }
    }

    /**
     * Schedule a session for upload after the local buffer period
     * @param {string} sessionId - Recording session ID
     * @param {number} endTime - Session end time in milliseconds
     */
    scheduleUpload(sessionId, endTime) {
        if (!b2Storage.isEnabled()) {
            console.log(`[UploadScheduler] B2 not configured, skipping upload for ${sessionId}`);
            return;
        }

        const scheduledTime = endTime + (this.localBufferHours * 60 * 60 * 1000);
        this.uploadQueue.set(sessionId, scheduledTime);

        console.log(`[UploadScheduler] Scheduled ${sessionId} for upload at ${new Date(scheduledTime).toISOString()}`);
    }

    /**
     * Process any uploads that are due
     */
    async processPendingUploads() {
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;

        try {
            const now = Date.now();

            for (const [sessionId, scheduledTime] of this.uploadQueue) {
                if (scheduledTime <= now) {
                    console.log(`[UploadScheduler] Processing upload for session ${sessionId}`);

                    const result = await this.uploadSession(sessionId);

                    if (result.success) {
                        this.uploadQueue.delete(sessionId);
                        console.log(`[UploadScheduler] Successfully uploaded session ${sessionId}`);
                    } else {
                        // Retry in 30 minutes
                        this.uploadQueue.set(sessionId, now + 30 * 60 * 1000);
                        console.error(`[UploadScheduler] Failed to upload ${sessionId}, will retry: ${result.error}`);
                    }
                }
            }
        } catch (error) {
            console.error('[UploadScheduler] Error processing uploads:', error.message);
        } finally {
            this.isProcessing = false;
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
                console.log(`[UploadScheduler] Session ${sessionId} already uploaded`);
                return { success: true };
            }

            // Check if local path exists
            if (!session.local_path || !fs.existsSync(session.local_path)) {
                // Try default path
                const defaultPath = path.join('/root/onestreamer/egress-recordings', sessionId);
                if (!fs.existsSync(defaultPath)) {
                    return { success: false, error: 'Local recording not found' };
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

                return { success: true };
            } else {
                // Revert status
                await runAsync(
                    'UPDATE recording_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                    ['completed', sessionId]
                );
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error(`[UploadScheduler] Error uploading session ${sessionId}:`, error.message);
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
                console.log(`[UploadScheduler] Cleaned up local files: ${localPath}`);
            }
        } catch (error) {
            console.error(`[UploadScheduler] Error cleaning up local files:`, error.message);
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
        console.log('[UploadScheduler] Stopped');
    }
}

module.exports = RecordingUploadScheduler;
