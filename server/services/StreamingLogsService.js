const { db, runAsync, getAsync, allAsync } = require('../database/database');
const { v4: uuidv4 } = require('uuid');

const logger = require('../bootstrap/logger').child({ svc: 'StreamingLogsService' });
class StreamingLogsService {
  constructor() {
    this.activeSessions = new Map(); // Map of streamerId to session data
    // Clean up orphaned sessions on startup
    this.cleanupOrphanedSessions();
  }

  /**
   * Clean up sessions that were left active due to server restart
   */
  async cleanupOrphanedSessions() {
    try {
      const endedAt = new Date().toISOString();

      // Find and close all orphaned sessions (active sessions not in memory)
      const result = await runAsync(`
        UPDATE streaming_logs
        SET ended_at = ?,
            duration = CAST((julianday(?) - julianday(started_at)) * 86400 AS INTEGER),
            disconnect_reason = 'server_restart'
        WHERE ended_at IS NULL
      `, [endedAt, endedAt]);

      logger.debug(`🧹 STREAMING LOGS: Cleaned up orphaned sessions on startup`);
      return { success: true };
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to cleanup orphaned sessions:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Start a new streaming session log
   */
  async startSession(streamerId, streamerName, userId, ipAddress, userAgent, streamType, isViewbot = false) {
    try {
      // Check if there's already an active session for this streamer
      const existingSession = this.activeSessions.get(streamerId);
      if (existingSession) {
        logger.debug(`⚠️ STREAMING LOGS: Session already exists for ${streamerId}, skipping duplicate`);
        return { success: true, sessionId: existingSession.sessionId, duplicate: true };
      }

      const sessionId = uuidv4();
      const startedAt = new Date().toISOString();

      // Store in active sessions
      this.activeSessions.set(streamerId, {
        sessionId,
        startedAt,
        viewerPeak: 0
      });

      // Insert into database
      await runAsync(`
        INSERT INTO streaming_logs
        (session_id, streamer_id, streamer_name, user_id, ip_address, user_agent, stream_type, is_viewbot, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [sessionId, streamerId, streamerName, userId, ipAddress, userAgent, streamType, isViewbot ? 1 : 0, startedAt]);

      logger.debug(`📝 STREAMING LOGS: Session started for ${streamerName || streamerId} (${ipAddress}) - ViewBot: ${isViewbot}`);

      return { success: true, sessionId };
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to start session:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * End a streaming session and calculate duration
   */
  async endSession(streamerId, disconnectReason = 'normal') {
    try {
      const session = this.activeSessions.get(streamerId);
      const endedAt = new Date().toISOString();

      if (!session) {
        // Fallback: Try to end session directly in DB even if not in memory
        // This handles edge cases like rapid reconnects or missed events
        logger.debug(`⚠️ STREAMING LOGS: No in-memory session for ${streamerId}, trying DB fallback`);

        const result = await runAsync(`
          UPDATE streaming_logs
          SET ended_at = ?,
              duration = CAST((julianday(?) - julianday(started_at)) * 86400 AS INTEGER),
              disconnect_reason = ?
          WHERE streamer_id = ? AND ended_at IS NULL
        `, [endedAt, endedAt, disconnectReason, streamerId]);

        logger.debug(`📝 STREAMING LOGS: DB fallback completed for ${streamerId}`);
        return { success: true, duration: 0, fallback: true };
      }

      // Calculate duration
      const startTime = new Date(session.startedAt);
      const endTime = new Date(endedAt);
      const duration = Math.floor((endTime - startTime) / 1000); // in seconds

      // Update database
      await runAsync(`
        UPDATE streaming_logs
        SET ended_at = ?,
            duration = ?,
            viewer_peak = ?,
            disconnect_reason = ?
        WHERE session_id = ?
      `, [endedAt, duration, session.viewerPeak, disconnectReason, session.sessionId]);

      // Remove from active sessions
      this.activeSessions.delete(streamerId);

      logger.debug(`📝 STREAMING LOGS: Session ended for ${streamerId} - Duration: ${duration}s`);

      return { success: true, duration };
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to end session:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update viewer peak for active session
   */
  async updateViewerPeak(streamerId, viewerCount) {
    try {
      const session = this.activeSessions.get(streamerId);
      if (!session) return;
      
      if (viewerCount > session.viewerPeak) {
        session.viewerPeak = viewerCount;
        
        // Update in database
        await runAsync(`
          UPDATE streaming_logs 
          SET viewer_peak = ?
          WHERE session_id = ?
        `, [viewerCount, session.sessionId]);
      }
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to update viewer peak:', error);
    }
  }

  /**
   * Mark a session's IP as banned
   */
  async markSessionBanned(ipAddress) {
    try {
      await runAsync(`
        UPDATE streaming_logs 
        SET is_banned = 1
        WHERE ip_address = ? AND ended_at IS NULL
      `, [ipAddress]);
      
      logger.debug(`📝 STREAMING LOGS: Marked active sessions from ${ipAddress} as banned`);
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to mark session as banned:', error);
    }
  }

  /**
   * Get streaming logs with filters
   */
  async getLogs(filters = {}) {
    try {
      let query = `
        SELECT 
          sl.*,
          u.username,
          u.email,
          CASE 
            WHEN sl.ended_at IS NULL THEN 'active'
            ELSE 'ended'
          END as status,
          CASE 
            WHEN sl.ended_at IS NULL THEN 
              CAST((julianday('now') - julianday(sl.started_at)) * 86400 AS INTEGER)
            ELSE sl.duration
          END as current_duration
        FROM streaming_logs sl
        LEFT JOIN users u ON sl.user_id = u.id
        WHERE 1=1
      `;
      
      const params = [];
      
      // Apply filters
      // Always exclude localhost IPs
      query += ` AND sl.ip_address NOT IN ('127.0.0.1', '::1', 'localhost')`;
      
      if (filters.excludeViewbots !== false) {
        query += ` AND sl.is_viewbot = 0`;
      }
      
      if (filters.ipAddress) {
        query += ` AND sl.ip_address = ?`;
        params.push(filters.ipAddress);
      }
      
      if (filters.userId) {
        query += ` AND sl.user_id = ?`;
        params.push(filters.userId);
      }
      
      if (filters.activeOnly) {
        query += ` AND sl.ended_at IS NULL`;
      }
      
      if (filters.startDate) {
        query += ` AND sl.started_at >= ?`;
        params.push(filters.startDate);
      }
      
      if (filters.endDate) {
        query += ` AND sl.started_at <= ?`;
        params.push(filters.endDate);
      }
      
      // Sorting
      query += ` ORDER BY sl.started_at DESC`;
      
      // Pagination
      if (filters.limit) {
        query += ` LIMIT ?`;
        params.push(filters.limit);
        
        if (filters.offset) {
          query += ` OFFSET ?`;
          params.push(filters.offset);
        }
      }
      
      const logs = await allAsync(query, params);
      
      // Get total count
      let countQuery = `
        SELECT COUNT(*) as total
        FROM streaming_logs sl
        WHERE 1=1
        AND sl.ip_address NOT IN ('127.0.0.1', '::1', 'localhost')
      `;
      
      const countParams = [];
      
      if (filters.excludeViewbots !== false) {
        countQuery += ` AND sl.is_viewbot = 0`;
      }
      
      if (filters.ipAddress) {
        countQuery += ` AND sl.ip_address = ?`;
        countParams.push(filters.ipAddress);
      }
      
      if (filters.userId) {
        countQuery += ` AND sl.user_id = ?`;
        countParams.push(filters.userId);
      }
      
      if (filters.activeOnly) {
        countQuery += ` AND sl.ended_at IS NULL`;
      }
      
      const countResult = await getAsync(countQuery, countParams);
      
      return {
        success: true,
        logs,
        total: countResult.total,
        active: this.activeSessions.size
      };
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to get logs:', error);
      return {
        success: false,
        error: error.message,
        logs: [],
        total: 0
      };
    }
  }

  /**
   * Get statistics for streaming logs
   */
  async getStats() {
    try {
      const stats = await getAsync(`
        SELECT 
          COUNT(*) as total_sessions,
          COUNT(DISTINCT ip_address) as unique_ips,
          COUNT(DISTINCT user_id) as unique_users,
          AVG(CASE WHEN duration IS NOT NULL THEN duration ELSE 0 END) as avg_duration,
          MAX(viewer_peak) as max_viewers,
          SUM(CASE WHEN is_banned = 1 THEN 1 ELSE 0 END) as banned_sessions,
          SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) as active_sessions
        FROM streaming_logs
        WHERE is_viewbot = 0
        AND ip_address NOT IN ('127.0.0.1', '::1', 'localhost')
      `);
      
      return {
        success: true,
        stats
      };
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to get stats:', error);
      return {
        success: false,
        error: error.message,
        stats: null
      };
    }
  }

  /**
   * Clean up old logs (optional retention policy)
   */
  async cleanupOldLogs(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      
      const result = await runAsync(`
        DELETE FROM streaming_logs
        WHERE started_at < ? AND is_viewbot = 1
      `, [cutoffDate.toISOString()]);
      
      logger.debug(`🧹 STREAMING LOGS: Cleaned up old viewbot logs older than ${daysToKeep} days`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ STREAMING LOGS: Failed to cleanup old logs:', error);
      return { success: false, error: error.message };
    }
  }
}

// Create singleton instance
const streamingLogsService = new StreamingLogsService();

// Schedule periodic cleanup. unref() so this background timer never holds
// the process open on its own — the server's listeners own the event loop,
// and jest workers / one-off scripts must be able to exit (audit B6).
const cleanupTimer = setInterval(() => {
  streamingLogsService.cleanupOldLogs(7); // Keep viewbot logs for 7 days only
}, 24 * 60 * 60 * 1000); // Daily cleanup
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
streamingLogsService._cleanupTimer = cleanupTimer;

module.exports = streamingLogsService;
