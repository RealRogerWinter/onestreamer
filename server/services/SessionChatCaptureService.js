/**
 * SessionChatCaptureService - Captures chat messages during recording sessions
 *
 * Polls the chat service to capture messages and stores them in the database
 * with relative timestamps for synchronized playback with video recordings.
 */

const axios = require('axios');
const { runAsync, getAsync, allAsync } = require('../database/database');

const logger = require('../bootstrap/logger').child({ svc: 'SessionChatCaptureService' });
class SessionChatCaptureService {
    constructor(config = {}) {
        this.chatServiceUrl = config.chatServiceUrl || process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';
        this.pollIntervalMs = config.pollIntervalMs || 5000; // Poll every 5 seconds
        this.contextWindowMs = config.contextWindowMs || 30000; // 30 seconds of context

        // Track active capture sessions
        this.activeSessions = new Map(); // sessionId -> { startTimeMs, lastCapturedTime, intervalId }

        logger.debug(`[SessionChatCapture] Initialized with chat service: ${this.chatServiceUrl}`);
    }

    /**
     * Start capturing chat for a recording session
     * @param {string} sessionId - Recording session ID
     * @param {number} startTimeMs - Session start time in milliseconds
     */
    startCapturing(sessionId, startTimeMs) {
        if (this.activeSessions.has(sessionId)) {
            logger.debug(`[SessionChatCapture] Already capturing session ${sessionId}`);
            return;
        }

        logger.debug(`[SessionChatCapture] Starting capture for session ${sessionId}`);

        const sessionData = {
            startTimeMs,
            lastCapturedTime: startTimeMs - this.contextWindowMs, // Start capturing from context window before
            intervalId: null,
            messageIds: new Set() // Track captured message IDs to avoid duplicates
        };

        // Capture immediately
        this.captureMessages(sessionId, sessionData);

        // Then poll periodically
        sessionData.intervalId = setInterval(() => {
            this.captureMessages(sessionId, sessionData);
        }, this.pollIntervalMs);

        this.activeSessions.set(sessionId, sessionData);
    }

    /**
     * Stop capturing chat for a recording session
     * @param {string} sessionId - Recording session ID
     */
    async stopCapturing(sessionId) {
        const sessionData = this.activeSessions.get(sessionId);
        if (!sessionData) {
            logger.debug(`[SessionChatCapture] Session ${sessionId} not found in active captures`);
            return;
        }

        logger.debug(`[SessionChatCapture] Stopping capture for session ${sessionId}`);

        // Clear the polling interval
        if (sessionData.intervalId) {
            clearInterval(sessionData.intervalId);
        }

        // Do a final capture pass
        await this.captureMessages(sessionId, sessionData);

        // Update the chat message count in the recording session
        await this.updateSessionChatCount(sessionId);

        this.activeSessions.delete(sessionId);
    }

    /**
     * Capture messages from chat service and store in database
     * @param {string} sessionId - Recording session ID
     * @param {object} sessionData - Session tracking data
     */
    async captureMessages(sessionId, sessionData) {
        try {
            // Fetch messages from chat service
            const response = await axios.get(`${this.chatServiceUrl}/api/chat-history`, {
                params: {
                    since: sessionData.lastCapturedTime,
                    until: Date.now(),
                    contextMs: 0 // We handle context ourselves
                },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
                timeout: 5000
            });

            if (!response.data.success || !response.data.messages) {
                return;
            }

            const messages = response.data.messages;
            let newMessageCount = 0;

            for (const msg of messages) {
                // Skip if we've already captured this message (by timestamp + username + message hash)
                const msgKey = `${msg.timestampMs || msg.timestamp}_${msg.username}_${msg.message?.slice(0, 50)}`;
                if (sessionData.messageIds.has(msgKey)) {
                    continue;
                }

                const absoluteTimeMs = msg.timestampMs || new Date(msg.timestamp).getTime();
                const relativeTimeMs = absoluteTimeMs - sessionData.startTimeMs;

                // Store message in database
                try {
                    await runAsync(`
                        INSERT INTO session_chat_messages
                        (session_id, username, message, color, absolute_time_ms, relative_time_ms, is_system, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    `, [
                        sessionId,
                        msg.username || 'Anonymous',
                        msg.message || '',
                        msg.color || null,
                        absoluteTimeMs,
                        relativeTimeMs,
                        msg.isSystem ? 1 : 0
                    ]);

                    sessionData.messageIds.add(msgKey);
                    newMessageCount++;
                } catch (insertError) {
                    // Ignore duplicate key errors
                    if (!insertError.message.includes('UNIQUE constraint')) {
                        logger.error(`[SessionChatCapture] Error inserting message:`, insertError.message);
                    }
                }
            }

            if (newMessageCount > 0) {
                logger.debug(`[SessionChatCapture] Captured ${newMessageCount} new messages for session ${sessionId}`);
            }

            // Update last captured time
            if (messages.length > 0) {
                const latestMsg = messages[messages.length - 1];
                sessionData.lastCapturedTime = latestMsg.timestampMs || new Date(latestMsg.timestamp).getTime();
            }

        } catch (error) {
            // Don't log connection errors repeatedly
            if (!error.message.includes('ECONNREFUSED')) {
                logger.error(`[SessionChatCapture] Error capturing messages:`, error.message);
            }
        }
    }

    /**
     * Update the chat message count in the recording session record
     * @param {string} sessionId - Recording session ID
     */
    async updateSessionChatCount(sessionId) {
        try {
            const result = await getAsync(
                'SELECT COUNT(*) as count FROM session_chat_messages WHERE session_id = ?',
                [sessionId]
            );
            const count = result?.count || 0;

            await runAsync(
                'UPDATE recording_sessions SET chat_message_count = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                [count, sessionId]
            );

            logger.debug(`[SessionChatCapture] Updated session ${sessionId} chat count: ${count}`);
        } catch (error) {
            logger.error(`[SessionChatCapture] Error updating chat count:`, error.message);
        }
    }

    /**
     * Get chat messages for a session with optional time range
     * @param {string} sessionId - Recording session ID
     * @param {number} fromMs - Optional start time (relative to session start)
     * @param {number} toMs - Optional end time (relative to session start)
     * @returns {Promise<Array>} Array of chat messages
     */
    async getSessionChat(sessionId, fromMs = null, toMs = null) {
        try {
            let sql = 'SELECT * FROM session_chat_messages WHERE session_id = ?';
            const params = [sessionId];

            if (fromMs !== null) {
                sql += ' AND relative_time_ms >= ?';
                params.push(fromMs);
            }

            if (toMs !== null) {
                sql += ' AND relative_time_ms <= ?';
                params.push(toMs);
            }

            sql += ' ORDER BY relative_time_ms ASC';

            const messages = await allAsync(sql, params);

            return messages.map(msg => ({
                id: msg.id,
                username: msg.username,
                message: msg.message,
                color: msg.color,
                relative_time_ms: msg.relative_time_ms,
                absolute_time_ms: msg.absolute_time_ms,
                isSystem: msg.is_system === 1,
                isContext: msg.relative_time_ms < 0
            }));
        } catch (error) {
            logger.error(`[SessionChatCapture] Error getting session chat:`, error.message);
            return [];
        }
    }

    /**
     * Delete chat messages for a session (when session is deleted)
     * @param {string} sessionId - Recording session ID
     */
    async deleteSessionChat(sessionId) {
        try {
            await runAsync('DELETE FROM session_chat_messages WHERE session_id = ?', [sessionId]);
            logger.debug(`[SessionChatCapture] Deleted chat for session ${sessionId}`);
        } catch (error) {
            logger.error(`[SessionChatCapture] Error deleting session chat:`, error.message);
        }
    }

    /**
     * Get capture status
     */
    getStatus() {
        return {
            activeSessions: Array.from(this.activeSessions.keys()),
            sessionCount: this.activeSessions.size
        };
    }

    /**
     * Shutdown the service
     */
    shutdown() {
        logger.debug('[SessionChatCapture] Shutting down...');

        // Stop all active captures
        for (const [sessionId, sessionData] of this.activeSessions) {
            if (sessionData.intervalId) {
                clearInterval(sessionData.intervalId);
            }
        }
        this.activeSessions.clear();

        logger.debug('[SessionChatCapture] Shutdown complete');
    }
}

module.exports = SessionChatCaptureService;
