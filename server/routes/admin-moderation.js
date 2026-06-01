/**
 * Admin moderation HTTP surface — extracted from `server/index.js` as
 * part of Phase 15B.3.c. 16 routes spanning the chat-moderation +
 * stream-admin + IP-ban + streaming-logs clusters. The pre-PR routes
 * lived in two non-contiguous blocks in `server/index.js`; both
 * blocks land in this one router because they share auth
 * (`authenticateModerator`) and the same dep surface
 * (`IPBanService`, `streamService`, `streamingLogsService`,
 * `mediasoupService`, `streamNotifier`, `io`, `axios`, `https`,
 * `logger`, `express.json()` middleware on the chat-mod POSTs).
 *
 * Routes:
 *   GET    /api/admin/moderation         — proxy to chat-service moderation list
 *   POST   /api/admin/ban                — proxy to chat-service ban
 *   POST   /api/admin/unban              — proxy to chat-service unban
 *   POST   /api/admin/timeout            — proxy to chat-service timeout
 *   POST   /api/admin/remove-timeout     — proxy to chat-service remove-timeout
 *   GET    /api/admin/verify             — JWT verification probe
 *   GET    /api/admin/stream-details/:streamerId
 *   POST   /api/admin/stream/disconnect  — kick a streamer
 *   POST   /api/admin/stream/ban-ip      — kick + ban IP from streaming
 *   GET    /api/admin/banned-ips        — list banned IPs
 *   POST   /api/admin/unban-ip
 *   POST   /api/admin/ban-ip-manual
 *   GET    /api/admin/streamer-connections
 *   GET    /api/admin/streaming-logs
 *   GET    /api/admin/streaming-logs/stats
 *   POST   /api/admin/streaming-logs/ban-ip
 *
 * Auth: `authenticateModerator` (JWT) on every route. The five chat-
 * moderation POSTs additionally use `express.json()` as a per-route
 * middleware (kept inline for behaviour-equivalence; redundant with
 * the global `app.use(express.json())` but preserved verbatim).
 *
 * All deps are eager. Body byte-equivalent except for `app.X(...)` →
 * `router.X(...)` at line starts.
 */

const express = require('express');

function createAdminModerationRouter(deps) {
    const {
        authenticateModerator,
        authService,
        IPBanService,
        streamService,
        streamingLogsService,
        mediasoupService,
        streamNotifier,
        io,
        axios,
        https,
        logger,
    } = deps;

    const router = express.Router();

    // Chat Moderation API endpoints
    router.get('/api/admin/moderation', authenticateModerator, async (req, res) => {
        try {
            // Send a request to the chat service to get moderation data
            const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/moderation`;
            logger.info(`📊 MAIN SERVER: Fetching moderation data from ${chatServiceUrl}`);
        
            const response = await axios.get(chatServiceUrl, { timeout: 5000 });
        
            logger.info({ data: response.data }, `📊 MAIN SERVER: Received moderation data`);
            res.json(response.data);
        } catch (error) {
            logger.error({ err: error }, 'Error fetching moderation data');
            logger.error({ err: error }, 'Full error');
            res.status(500).json({ 
                error: 'Failed to fetch moderation data',
                bannedUsers: [],
                timedOutUsers: []
            });
        }
    });

    router.post('/api/admin/ban', authenticateModerator, express.json(), async (req, res) => {
        try {
            const { username, reason } = req.body;
            const adminUser = await authService.getUserFromToken(req.headers.authorization?.substring(7));
        
            // Send ban request to chat service
            const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/ban`;
            const response = await axios.post(chatServiceUrl, {
                username,
                reason,
                bannedBy: adminUser.username
            });
        
            res.json(response.data);
        } catch (error) {
            logger.error({ err: error }, 'Error banning user');
            res.status(500).json({ error: 'Failed to ban user' });
        }
    });

    router.post('/api/admin/unban', authenticateModerator, express.json(), async (req, res) => {
        try {
            const { username } = req.body;
        
            // Send unban request to chat service
            const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/unban`;
            const response = await axios.post(chatServiceUrl, { username });
        
            res.json(response.data);
        } catch (error) {
            logger.error({ err: error }, 'Error unbanning user');
            res.status(500).json({ error: 'Failed to unban user' });
        }
    });

    router.post('/api/admin/timeout', authenticateModerator, express.json(), async (req, res) => {
        try {
            const { username, duration, reason } = req.body;
            const adminUser = await authService.getUserFromToken(req.headers.authorization?.substring(7));
        
            // Send timeout request to chat service
            const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/timeout`;
            const response = await axios.post(chatServiceUrl, {
                username,
                duration,
                reason,
                timedOutBy: adminUser.username
            });
        
            res.json(response.data);
        } catch (error) {
            logger.error({ err: error }, 'Error timing out user');
            res.status(500).json({ error: 'Failed to timeout user' });
        }
    });

    router.post('/api/admin/remove-timeout', authenticateModerator, express.json(), async (req, res) => {
        try {
            const { username } = req.body;
        
            // Send remove timeout request to chat service
            const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/remove-timeout`;
            const response = await axios.post(chatServiceUrl, { username });
        
            res.json(response.data);
        } catch (error) {
            logger.error({ err: error }, 'Error removing timeout');
            res.status(500).json({ error: 'Failed to remove timeout' });
        }
    });

    // ==========================================
    // Stream-admin / IP-ban / streaming-logs surfaces
    // (pre-PR: server/index.js lines 2018-2418)
    // ==========================================
    router.get('/api/admin/verify', authenticateModerator, (req, res) => {
      res.json({ success: true, isAdmin: req.userRecord.is_admin === 1, isModerator: req.userRecord.is_moderator === 1 });
    });

    router.get('/api/admin/stream-details/:streamerId', authenticateModerator, (req, res) => {
      try {
        const { streamerId } = req.params;
        const socket = io.sockets.sockets.get(streamerId);
    
        if (!socket) {
          return res.status(404).json({ error: 'Stream not found' });
        }
    
        const ipAddress = IPBanService.getIPFromSocket(socket);
        const startTime = socket.handshake.time || new Date().toISOString();
    
        res.json({
          streamerId,
          ipAddress,
          startTime,
          connectionTime: socket.handshake.time
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get stream details');
        res.status(500).json({ error: 'Failed to get stream details' });
      }
    });

    router.post('/api/admin/stream/disconnect', authenticateModerator, async (req, res) => {
      try {
        const { streamerId } = req.body;
    
        if (!streamerId) {
          return res.status(400).json({ error: 'Streamer ID required' });
        }
    
        const currentStreamer = streamService.getCurrentStreamer();
        if (currentStreamer !== streamerId) {
          return res.status(400).json({ error: 'Specified streamer is not currently streaming' });
        }
    
        // Check if this is a viewbot stream
        const isViewbotStream = (viewbotService && viewbotService.isViewbotStream(streamerId)) || 
                               viewbotSocketIds.has(streamerId);
    
        if (isViewbotStream) {
          // For viewbots, trigger rotation instead of disconnect
          logger.info(`🔨 MODERATION: Admin triggering viewbot rotation for stream ${streamerId}`);
      
          // The admin viewbot-client fleet (ViewBotClientService) was deleted —
          // it was dead under LiveKit. No admin-triggered rotation path remains
          // here; the endpoint still responds with the default result.
          const rotationResult = { success: false, message: 'No rotation service available' };

          res.json({
            success: true, 
            message: 'Viewbot rotation triggered',
            streamerId,
            rotationResult
          });
        } else {
          // For regular users, perform normal disconnect
          logger.info(`🔨 MODERATION: Admin disconnecting regular stream ${streamerId}`);
      
          // Get the socket
          const socket = io.sockets.sockets.get(streamerId);
          if (!socket) {
            return res.status(404).json({ error: 'Streamer socket not found' });
          }
      
          // Clear the streamer
          streamService.clearStreamer();
          mediasoupService.currentStreamer = null;
      
          // Cleanup MediaSoup resources
          mediasoupService.cleanup(streamerId);
      
          // Notify the streamer they've been disconnected
          socket.emit('stream-disconnected-by-admin', { 
            reason: 'Disconnected by administrator',
            timestamp: new Date().toISOString()
          });
      
          // Disconnect the socket
          socket.disconnect(true);
      
          // Notify all viewers
          streamNotifier.streamEnded({ reason: 'admin_disconnect' });
      
          // After disconnecting a regular user, ensure viewbot rotation is enabled
          if (global.viewBotRotation) {
            logger.info(`🤖 ROTATION: Enabling rotation after user disconnect`);
            await global.viewBotRotation.startRotation();
          }
      
          res.json({ 
            success: true, 
            message: 'Stream disconnected successfully',
            streamerId,
            rotationEnabled: true
          });
        }
      } catch (error) {
        logger.error({ err: error }, '❌ MODERATION: Failed to disconnect/rotate stream');
        res.status(500).json({ error: 'Failed to disconnect stream' });
      }
    });

    router.post('/api/admin/stream/ban-ip', authenticateModerator, async (req, res) => {
      try {
        const { streamerId, ip, reason } = req.body;
    
        if (!streamerId) {
          return res.status(400).json({ error: 'Streamer ID required' });
        }
    
        // Get the socket to extract IP if not provided
        const socket = io.sockets.sockets.get(streamerId);
        let ipToBan = ip;
    
        if (!ipToBan && socket) {
          ipToBan = IPBanService.getIPFromSocket(socket);
        }
    
        if (!ipToBan) {
          return res.status(400).json({ error: 'Could not determine IP address to ban' });
        }
    
        // Ban the IP
        const banResult = await IPBanService.banIP(
          ipToBan,
          req.user.id,
          req.userRecord.username,
          reason || 'Banned by admin moderation',
          true // permanent ban
        );
    
        if (!banResult.success) {
          return res.status(500).json({ error: 'Failed to ban IP', details: banResult.error });
        }
    
        logger.info(`🚫 MODERATION: IP ${ipToBan} banned by ${req.userRecord.username}`);
    
        // If the streamer is currently streaming, disconnect them
        const currentStreamer = streamService.getCurrentStreamer();
        if (currentStreamer === streamerId) {
          streamService.clearStreamer();
          mediasoupService.currentStreamer = null;
          mediasoupService.cleanup(streamerId);
      
          if (socket) {
            socket.emit('banned', { 
              reason: reason || 'Your IP has been banned',
              timestamp: new Date().toISOString()
            });
            socket.disconnect(true);
          }
      
          streamNotifier.streamEnded({ reason: 'streamer_banned' });
        }
    
        // Disconnect any other sockets from this IP
        io.sockets.sockets.forEach((otherSocket) => {
          const socketIP = IPBanService.getIPFromSocket(otherSocket);
          if (socketIP === ipToBan) {
            otherSocket.emit('banned', { 
              reason: 'Your IP has been banned',
              timestamp: new Date().toISOString()
            });
            otherSocket.disconnect(true);
          }
        });
    
        res.json({ 
          success: true, 
          message: 'IP banned and connections terminated',
          ip: ipToBan,
          streamerId 
        });
      } catch (error) {
        logger.error({ err: error }, '❌ MODERATION: Failed to ban IP');
        res.status(500).json({ error: 'Failed to ban IP' });
      }
    });

    router.get('/api/admin/banned-ips', authenticateModerator, async (req, res) => {
      try {
        const bannedIPs = await IPBanService.getBannedIPs();
        res.json({ success: true, bannedIPs });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get banned IPs');
        res.status(500).json({ error: 'Failed to get banned IPs' });
      }
    });

    router.post('/api/admin/unban-ip', authenticateModerator, async (req, res) => {
      try {
        const { ip } = req.body;
    
        if (!ip) {
          return res.status(400).json({ error: 'IP address required' });
        }
    
        // Pass the Socket.IO instance to properly notify unbanned clients
        const result = await IPBanService.unbanIP(ip, io);
    
        if (!result.success) {
          return res.status(500).json({ error: 'Failed to unban IP', details: result.error });
        }
    
        logger.info(`✅ MODERATION: IP ${ip} unbanned by ${req.userRecord.username}`);
    
        res.json({ 
          success: true, 
          message: 'IP unbanned successfully',
          ip 
        });
      } catch (error) {
        logger.error({ err: error }, '❌ MODERATION: Failed to unban IP');
        res.status(500).json({ error: 'Failed to unban IP' });
      }
    });

    // Manual IP ban endpoint
    router.post('/api/admin/ban-ip-manual', authenticateModerator, async (req, res) => {
      try {
        const { ip, reason, permanent, expiresAt } = req.body;
    
        if (!ip) {
          return res.status(400).json({ error: 'IP address required' });
        }
    
        // Basic IP validation
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipRegex.test(ip)) {
          return res.status(400).json({ error: 'Invalid IP address format' });
        }
    
        const result = await IPBanService.banIP(
          ip, 
          req.userRecord.id, 
          req.userRecord.username, 
          reason || 'Manual ban by admin',
          permanent !== false, // default to permanent
          expiresAt || null
        );
    
        if (!result.success) {
          return res.status(500).json({ error: 'Failed to ban IP', details: result.error });
        }
    
        logger.info(`🚫 MODERATION: IP ${ip} manually banned by ${req.userRecord.username} - Reason: ${reason}`);
    
        res.json({ 
          success: true, 
          message: 'IP banned successfully',
          ip,
          reason 
        });
      } catch (error) {
        logger.error({ err: error }, '❌ MODERATION: Failed to manually ban IP');
        res.status(500).json({ error: 'Failed to ban IP' });
      }
    });

    // Get streamer connection history
    router.get('/api/admin/streamer-connections', authenticateModerator, async (req, res) => {
      try {
        const { limit = 100, offset = 0, streamerId, ip } = req.query;
    
        let query = `
          SELECT * FROM streamer_connections 
          WHERE 1=1
          AND ip_address NOT IN ('127.0.0.1', '::1', 'localhost')
        `;
        const params = [];
    
        if (streamerId) {
          query += ` AND streamer_id = ?`;
          params.push(streamerId);
        }
    
        if (ip) {
          query += ` AND ip_address = ?`;
          params.push(ip);
        }
    
        query += ` ORDER BY connected_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));
    
        const connections = await allAsync(query, params);
    
        res.json({ 
          success: true, 
          connections,
          count: connections.length 
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get streamer connections');
        res.status(500).json({ error: 'Failed to get streamer connections' });
      }
    });

    // Streaming Logs endpoints
    // (pre-PR had an inline `const streamingLogsService = require('./services/StreamingLogsService')`
    // shadowing the module-scope destructure with a fresh require. Removed during 15B.3.c
    // extraction: (a) the require path was relative to `server/` and would break from
    // `server/routes/`, (b) the factory-arg `streamingLogsService` is the same instance
    // anyway — passed in from index.js's `services` destructure.)

    // Get streaming logs
    router.get('/api/admin/streaming-logs', authenticateModerator, async (req, res) => {
      try {
        const filters = {
          limit: parseInt(req.query.limit) || 100,
          offset: parseInt(req.query.offset) || 0,
          excludeViewbots: req.query.includeViewbots !== 'true',
          ipAddress: req.query.ip,
          userId: req.query.userId ? parseInt(req.query.userId) : undefined,
          activeOnly: req.query.activeOnly === 'true',
          startDate: req.query.startDate,
          endDate: req.query.endDate
        };
    
        const result = await streamingLogsService.getLogs(filters);
    
        if (!result.success) {
          return res.status(500).json({ error: result.error });
        }
    
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get streaming logs');
        res.status(500).json({ error: 'Failed to get streaming logs' });
      }
    });

    // Get streaming logs statistics
    router.get('/api/admin/streaming-logs/stats', authenticateModerator, async (req, res) => {
      try {
        const result = await streamingLogsService.getStats();
    
        if (!result.success) {
          return res.status(500).json({ error: result.error });
        }
    
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get streaming stats');
        res.status(500).json({ error: 'Failed to get streaming stats' });
      }
    });

    // Ban IP from streaming log
    router.post('/api/admin/streaming-logs/ban-ip', authenticateModerator, async (req, res) => {
      try {
        const { ip, sessionId, reason } = req.body;
    
        if (!ip) {
          return res.status(400).json({ error: 'IP address required' });
        }
    
        // Ban the IP
        const result = await IPBanService.banIP(
          ip,
          req.userRecord.id,
          req.userRecord.username,
          reason || `Banned from streaming logs (Session: ${sessionId})`,
          true, // permanent by default
          null
        );
    
        if (!result.success) {
          return res.status(500).json({ error: 'Failed to ban IP', details: result.error });
        }
    
        // Mark session as banned
        await streamingLogsService.markSessionBanned(ip);
    
        logger.info(`🚫 STREAMING LOGS: IP ${ip} banned by ${req.userRecord.username} from logs`);
    
        res.json({ 
          success: true, 
          message: 'IP banned successfully',
          ip
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to ban IP from logs');
        res.status(500).json({ error: 'Failed to ban IP' });
      }
    });

    return router;
}

module.exports = createAdminModerationRouter;
