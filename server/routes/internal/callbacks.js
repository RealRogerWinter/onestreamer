// server/routes/internal/callbacks.js
//
// Sub-route module of the /api/internal/* router. Holds the chat-service
// callbacks and the public read endpoints (leaderboard, stream uptime,
// user-stats, admin-status checks). Handler bodies are VERBATIM from the
// former monolithic server/routes/internal.js; the parent mounts this at the
// SAME base path so every path/method/auth order is byte-for-byte identical.

const express = require('express');

const AccountService = require('../../services/AccountService');

/**
 * @param {{ logger: import('pino').Logger }} deps
 */
module.exports = function createCallbacksRouter({ logger }) {
  const router = express.Router();

  // API endpoint for chat service to track messages
  router.post('/track-chat-message', express.json(), async (req, res) => {
    try {
      const { sessionService, timeTrackingService } = req.app.locals.services;
      const { userId, ip } = req.body;
      logger.debug(`💬 API: Received chat message tracking request - userId: ${userId}, ip: ${ip}`);

      if (!userId && !ip) {
        logger.debug(`❌ API: No userId or ip provided`);
        return res.status(400).json({ error: 'userId or ip required' });
      }

      // If only IP is provided, try to find the user ID
      let actualUserId = userId;
      if (!actualUserId && ip) {
        const session = sessionService.getSessionByIp(ip);
        actualUserId = session?.userId;
        logger.debug(`💬 API: Looking up user by IP ${ip} - found session:`, !!session, 'userId:', actualUserId);
      }

      if (actualUserId) {
        logger.debug(`✅ API: Tracking chat message for user ${actualUserId}`);
        await timeTrackingService.trackChatMessage(actualUserId);
        res.json({ success: true, userId: actualUserId });
      } else {
        logger.debug(`❌ API: User not found - userId: ${userId}, ip: ${ip}, session: ${sessionService.getSessionByIp(ip) ? 'exists but no userId' : 'not found'}`);
        res.json({ success: false, message: 'User not authenticated' });
      }
    } catch (error) {
      logger.error('❌ API: Error tracking chat message:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // API endpoint for chat service to sync usernames
  router.post('/sync-chat-username', express.json(), async (req, res) => {
    try {
      const { sessionService } = req.app.locals.services;
      const { ip, username, color } = req.body;
      logger.debug(`💬 API: Received chat username sync request - ip: ${ip}, username: ${username}, color: ${color}`);

      if (!ip || !username) {
        logger.debug(`❌ API: Missing required fields - ip: ${ip}, username: ${username}`);
        return res.status(400).json({ error: 'ip and username required' });
      }

      // Update the session service with the chat username
      sessionService.setChatUsername(ip, username, color);
      logger.debug(`✅ API: Synced chat username for IP ${ip}: ${username} (${color})`);

      res.json({ success: true, ip, username, color });
    } catch (error) {
      logger.error('❌ API: Error syncing chat username:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // API endpoint to get leaderboard
  router.get('/leaderboard', async (req, res) => {
    try {
      const accountService = new AccountService();
      const db = require('../../database/database');

      const leaderboard = await db.allAsync(
        `SELECT u.username, MAX(us.points_balance) as points_balance
         FROM user_stats us
         JOIN users u ON us.user_id = u.id
         WHERE us.points_balance > 0
         GROUP BY u.id, u.username
         ORDER BY points_balance DESC
         LIMIT 10`
      );

      res.json({
        success: true,
        leaderboard
      });
    } catch (error) {
      logger.error('❌ LEADERBOARD: Error fetching leaderboard:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch leaderboard'
      });
    }
  });

  // API endpoint to get stream uptime
  router.get('/stream-uptime', async (req, res) => {
    try {
      const io = req.app.get('io');
      // Check if any stream is live
      const streamingSockets = io.sockets.sockets;
      let isLive = false;
      let streamerUsername = null;
      let streamStartTime = null;

      // Find active streamer
      for (const [socketId, socket] of streamingSockets) {
        if (socket.data?.isStreaming) {
          isLive = true;
          streamerUsername = socket.data.username || 'Unknown';
          streamStartTime = socket.data.streamStartTime || Date.now();
          break;
        }
      }

      if (isLive && streamStartTime) {
        const uptime = Math.floor((Date.now() - streamStartTime) / 1000);
        res.json({
          success: true,
          isLive: true,
          uptime,
          streamer: streamerUsername
        });
      } else {
        res.json({
          success: true,
          isLive: false,
          uptime: 0
        });
      }
    } catch (error) {
      logger.error('❌ UPTIME: Error fetching stream uptime:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch stream uptime'
      });
    }
  });

  // Endpoint to get user stats by username
  router.get('/user-stats/:username', async (req, res) => {
    try {
      const { username } = req.params;

      if (!username) {
        return res.status(400).json({
          success: false,
          error: 'Username is required'
        });
      }

      const accountService = new AccountService();

      // Find the user by username
      const user = await accountService.getUserByUsername(username);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: `User '${username}' not found`
        });
      }

      // Get user stats
      const stats = await accountService.getUserStats(user.id);

      if (!stats) {
        // Return default stats if none exist
        return res.json({
          success: true,
          stats: {
            points_balance: 0,
            total_view_time: 0,
            total_stream_time: 0,
            chat_message_count: 0,
            stream_count: 0
          }
        });
      }

      res.json({
        success: true,
        stats: {
          points_balance: stats.points_balance || 0,
          total_view_time: stats.total_view_time || 0,
          total_stream_time: stats.total_stream_time || 0,
          chat_message_count: stats.chat_message_count || 0,
          stream_count: stats.stream_count || 0
        }
      });
    } catch (error) {
      logger.error('❌ STATS: Error fetching user stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch user stats'
      });
    }
  });

  // API endpoint for chat service to get user admin status
  router.get('/user/:userId/admin-status', express.json(), async (req, res) => {
    try {
      const { userId } = req.params;
      logger.debug(`💬 API: Received admin status request for user ${userId}`);

      if (!userId) {
        logger.debug(`❌ API: No userId provided`);
        return res.status(400).json({ error: 'userId required' });
      }

      const accountService = new AccountService();
      const user = await accountService.getUserById(userId);

      if (!user) {
        logger.debug(`❌ API: User ${userId} not found`);
        return res.status(404).json({ error: 'User not found' });
      }

      const isAdmin = !!user.is_admin;
      logger.debug(`✅ API: User ${userId} admin status: ${isAdmin}`);

      res.json({
        success: true,
        userId,
        isAdmin,
        username: user.username
      });
    } catch (error) {
      logger.error('❌ API: Error checking admin status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
