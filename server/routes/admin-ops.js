/**
 * Admin operations bundle — extracted from `server/index.js` as part of
 * Phase 15B.3.f+g (combined per "admin-ops bundle" maintainer call —
 * stream control + cooldowns + debug + system metrics + uploaded videos
 * all share authenticateAdmin/adminKeyAuth auth and most service deps,
 * so they land in one router).
 *
 * 15 routes spanning:
 *   Stream control:
 *     POST /admin/{force-disconnect,send-message,clear-stream}
 *     GET  /admin/connections
 *   Cooldowns:
 *     POST /admin/{remove-cooldown,reset-cooldowns}
 *     GET  /admin/cooldowns
 *   Debug + system:
 *     GET  /debug/server-state                  (no auth — debug surface)
 *     GET  /admin/{system-metrics,system-health,performance-stats}
 *     POST /admin/clear-alerts
 *   Uploaded videos:
 *     POST   /admin/upload-video                (adminKeyAuth)
 *     GET    /admin/uploaded-videos             (adminKeyAuth)
 *     DELETE /admin/uploaded-videos/:filename   (adminKeyAuth)
 *
 * Auth: mostly `authenticateAdmin` (JWT); the upload-video trio uses
 * `adminKeyAuth` (legacy X-Admin-Key); `/debug/server-state` is unauth'd
 * by design (debugging surface, gated by the production reverse-proxy
 * rather than at this layer).
 *
 * All deps are eager. Body byte-equivalent except for `app.X(...)` →
 * `router.X(...)` at line starts.
 */

const express = require('express');

function createAdminOpsRouter(deps) {
    const {
        authenticateAdmin,
        adminKeyAuth,
        sessionService,
        streamService,
        takeoverService,
        accountService,
        itemService,
        timeTrackingService,
        webrtcService,
        resourceMonitor,
        streamNotifier,
        viewerCountNotifier,
        database,
        io,
        fs,
        path,
        upload,
        uploadsDir,
        logger,
    } = deps;

    const router = express.Router();

    router.post('/admin/force-disconnect', authenticateAdmin, (req, res) => {
      const { socketId } = req.body;
  
      if (!socketId) {
        return res.status(400).json({ error: 'socketId is required' });
      }
  
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.disconnect(true);
        res.json({ success: true, message: `Disconnected socket ${socketId}` });
      } else {
        res.status(404).json({ error: 'Socket not found' });
      }
    });

    router.post('/admin/send-message', authenticateAdmin, (req, res) => {
      const { socketId, message } = req.body;
  
      if (!socketId || !message) {
        return res.status(400).json({ error: 'socketId and message are required' });
      }
  
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('admin-notification', {
          message: message,
          timestamp: Date.now(),
          type: 'info'
        });
        res.json({ success: true, message: `Message sent to socket ${socketId}` });
      } else {
        res.status(404).json({ error: 'Socket not found' });
      }
    });

    router.post('/admin/clear-stream', authenticateAdmin, (req, res) => {
      const clearedStreamer = streamService.clearStreamer();
      webrtcService.currentStreamer = null;
      logger.info(`🧹 ADMIN CLEAR: Cleared ${clearedStreamer} from both services`);

      streamNotifier.streamEnded({ reason: 'admin_clear', previousStreamer: clearedStreamer });
      viewerCountNotifier.broadcast();

      res.json({
        success: true,
        message: 'Stream cleared',
        previousStreamer: clearedStreamer
      });
    });

    router.get('/admin/connections', authenticateAdmin, async (req, res) => {
      // Get ONLY currently connected sockets
      const connectedSockets = Array.from(io.sockets.sockets.values());
      const connectedSocketIds = new Set(connectedSockets.map(s => s.id));
  
      const sockets = connectedSockets.map(socket => ({
        id: socket.id,
        connected: socket.connected,
        rooms: Array.from(socket.rooms),
        handshake: {
          address: socket.handshake.address,
          time: socket.handshake.time,
          headers: socket.handshake.headers['user-agent']
        }
      }));
  
      // Get session data from SessionService but filter to only connected sockets
      const allSessions = sessionService.getAllSessions();
      const sessions = allSessions.filter(session => connectedSocketIds.has(session.socketId));
      const uniqueViewerCount = sessionService.getUniqueViewerCount();
      const activeSessions = sessionService.getActiveSessions();
  
      // accountService is the bootstrap-built instance from line ~462 (createServices).
      // A prior inline `new AccountService()` here was a leftover from before the
      // services factory; the class isn't imported in this file, which silently
      // hung the request via an un-caught async ReferenceError.

      // Enhance session data with additional information
      const enhancedSessions = await Promise.all(sessions.map(async (session) => {
        // Get chat username if available
        const chatInfo = sessionService.getChatUsername(session.ipAddress);
    
        // Get user details and stats if authenticated (skip negative IDs as they are ViewBots)
        let userDetails = null;
        let userStats = null;
        if (session.userId && session.userId > 0) {
          try {
            userDetails = await accountService.getUserById(session.userId);
            // Get real-time stats from database
            userStats = await accountService.getUserStats(session.userId);
          } catch (err) {
            logger.info({ err }, `Could not fetch user details for ${session.userId}`);
          }
        }
    
        // Calculate real-time view time for active sessions
        let currentViewTime = session.stats?.viewTime || 0;
        if (session.isActive && timeTrackingService.viewingSessions.has(session.socketId)) {
          const viewingSession = timeTrackingService.viewingSessions.get(session.socketId);
          if (viewingSession && viewingSession.startTime) {
            currentViewTime = Date.now() - viewingSession.startTime;
          }
        }
    
        return {
          ...session,
          chatUsername: chatInfo?.username || session.userAgent || 'Anonymous',
          chatColor: chatInfo?.color || '#718096',
          authenticatedUser: userDetails ? {
            id: userDetails.id,
            username: userDetails.username,
            email: userDetails.email
          } : null,
          stats: {
            chatMessageCount: userStats?.chat_message_count || session.stats?.chatMessageCount || 0,
            streamTime: userStats?.total_stream_time || session.stats?.streamTime || 0,
            viewTime: currentViewTime || userStats?.total_view_time || session.stats?.viewTime || 0,
            streamCount: userStats?.stream_count || session.stats?.streamCount || 0,
            lastStreamAt: userStats?.last_stream_at || session.stats?.lastStreamAt || null
          }
        };
      }));
  
      // Count unique IPs from connected sessions only
      const uniqueIPs = new Set(sessions.map(s => s.ipAddress)).size;
  
      res.json({
        totalConnections: sessions.length,  // Use filtered sessions count
        uniqueIPs: uniqueIPs,
        connections: sockets,
        sessions: enhancedSessions,
        uniqueViewers: uniqueViewerCount,
        activeSessions: activeSessions.length,
        streamStatus: streamService.getStreamStatus(),
        stats: sessionService.getStats()
      });
    });

    // Admin cooldown management endpoints
    router.post('/admin/remove-cooldown', authenticateAdmin, async (req, res) => {
      try {
        const { socketId } = req.body;
    
        if (!socketId) {
          return res.status(400).json({ error: 'socketId is required' });
        }

        const result = await takeoverService.removeCooldown(socketId);
    
        if (result) {
          logger.info(`🔥 ADMIN: Cooldown removed for ${socketId}`);
          res.json({ success: true, message: `Cooldown removed for ${socketId}` });
        } else {
          res.status(404).json({ error: 'No cooldown found for this socket' });
        }
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to remove cooldown');
        res.status(500).json({ error: 'Failed to remove cooldown' });
      }
    });

    router.post('/admin/reset-cooldowns', authenticateAdmin, async (req, res) => {
      try {
        // Reset TakeoverService cooldowns (global system cooldowns)
        const takeoverCount = await takeoverService.resetAllCooldowns();
        logger.info(`🔥 ADMIN: Reset ${takeoverCount} takeover cooldowns`);
    
        // Reset ItemService cooldowns (item usage cooldowns)
        const itemCount = await itemService.resetAllItemCooldowns();
        logger.info(`🔥 ADMIN: Reset ${itemCount} item usage cooldowns`);
    
        const totalCount = takeoverCount + itemCount;
        logger.info(`🔥 ADMIN: Total cooldowns reset: ${totalCount}`);
    
        res.json({ 
          success: true, 
          message: `Reset ${totalCount} cooldowns (${takeoverCount} system + ${itemCount} item usage)`,
          count: totalCount,
          breakdown: {
            takeoverCooldowns: takeoverCount,
            itemCooldowns: itemCount
          }
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to reset cooldowns');
        res.status(500).json({ error: 'Failed to reset cooldowns' });
      }
    });

    router.get('/admin/cooldowns', authenticateAdmin, async (req, res) => {
      try {
        const cooldowns = await takeoverService.getAllCooldowns();
    
        // Format cooldowns for backward compatibility with client
        const formattedCooldowns = cooldowns.map(cooldown => ({
          socketId: cooldown.identifier, // For client compatibility
          identifier: cooldown.identifier, // New field for IP tracking
          remaining: cooldown.remaining,
          reason: cooldown.reason,
          duration: cooldown.duration
        }));
    
        res.json({ cooldowns: formattedCooldowns });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get cooldowns');
        res.status(500).json({ error: 'Failed to get cooldowns' });
      }
    });

    router.get('/debug/server-state', (req, res) => {
      try {
        const currentStreamer = webrtcService.getCurrentStreamer();
        const producers = {};
        const notifiedList = Array.from(notifiedStreamers);
    
        // Get producer info for all streamers
        for (const [socketId, producerMap] of webrtcService.producers.entries()) {
          producers[socketId] = {
            count: producerMap.size,
            types: Array.from(producerMap.keys())
          };
        }
    
        res.json({
          currentStreamer,
          producers,
          notifiedStreamers: notifiedList,
          streamService: {
            currentStreamer: streamService.getCurrentStreamer()
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Resource monitoring endpoints
    router.get('/admin/system-metrics', authenticateAdmin, (req, res) => {
      try {
        const metrics = resourceMonitor.getFormattedMetrics();
        const alerts = resourceMonitor.getAlerts(10);
    
        res.json({
          metrics,
          alerts,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get system metrics');
        res.status(500).json({ error: 'Failed to get system metrics' });
      }
    });

    router.get('/admin/system-health', authenticateAdmin, (req, res) => {
      try {
        const healthSummary = resourceMonitor.getHealthSummary();
        res.json(healthSummary);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get system health');
        res.status(500).json({ error: 'Failed to get system health' });
      }
    });

    router.post('/admin/clear-alerts', authenticateAdmin, (req, res) => {
      try {
        resourceMonitor.clearAlerts();
        res.json({ success: true, message: 'System alerts cleared' });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to clear alerts');
        res.status(500).json({ error: 'Failed to clear alerts' });
      }
    });

    router.get('/admin/performance-stats', authenticateAdmin, (req, res) => {
      try {
        // Get socket statistics
        const socketStats = {
          total: io.sockets.sockets.size,
          active: io.sockets.sockets.size,
          streamers: streamService.getCurrentStreamer() ? 1 : 0,
          viewers: streamService.getViewerCount()
        };

        // Get mediasoup statistics
        const mediasoupStats = webrtcService.getStats();

        // Update resource monitor with current stats
        resourceMonitor.updateConnectionMetrics(socketStats);
        resourceMonitor.updateMediasoupMetrics(mediasoupStats);

        const performanceStats = {
          sockets: socketStats,
          mediasoup: mediasoupStats,
          resources: resourceMonitor.getMetrics(),
          health: resourceMonitor.getHealthSummary().status
        };

        res.json(performanceStats);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get performance stats');
        res.status(500).json({ error: 'Failed to get performance stats' });
      }
    });


    // Video file upload endpoint for ViewBot
    router.post('/admin/upload-video', adminKeyAuth, upload.single('video'), (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ 
            success: false, 
            error: 'No video file uploaded' 
          });
        }

        const filePath = path.join(uploadsDir, req.file.filename);
    
        // Check if file was actually saved
        if (!fs.existsSync(filePath)) {
          return res.status(500).json({ 
            success: false, 
            error: 'File upload failed - file not saved' 
          });
        }

        logger.info(`📁 ADMIN: Video uploaded - ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

        res.json({
          success: true,
          message: 'Video uploaded successfully',
          filename: req.file.filename,
          originalName: req.file.originalname,
          filePath: filePath,
          size: req.file.size,
          mimeType: req.file.mimetype
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Video upload error');
        res.status(500).json({ 
          success: false, 
          error: 'Upload failed: ' + error.message 
        });
      }
    });

    // List uploaded videos endpoint
    router.get('/admin/uploaded-videos', adminKeyAuth, (req, res) => {
      try {
        if (!fs.existsSync(uploadsDir)) {
          return res.json({ videos: [] });
        }

        const files = fs.readdirSync(uploadsDir);
        const videoFiles = files.filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'].includes(ext);
        }).map(file => {
          const filePath = path.join(uploadsDir, file);
          const stats = fs.statSync(filePath);
      
          return {
            filename: file,
            filePath: filePath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
          };
        });

        res.json({ 
          videos: videoFiles.sort((a, b) => b.created - a.created) 
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to list uploaded videos');
        res.status(500).json({ error: 'Failed to list videos' });
      }
    });

    // Delete uploaded video endpoint
    router.delete('/admin/uploaded-videos/:filename', adminKeyAuth, (req, res) => {
      try {
        const { filename } = req.params;
        const filePath = path.join(uploadsDir, filename);
    
        // Security check - ensure filename doesn't contain path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
          return res.status(400).json({ error: 'Invalid filename' });
        }

        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'Video file not found' });
        }

        fs.unlinkSync(filePath);
        logger.info(`🗑️ ADMIN: Deleted uploaded video - ${filename}`);
    
        res.json({ 
          success: true, 
          message: `Video ${filename} deleted successfully` 
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to delete video');
        res.status(500).json({ error: 'Failed to delete video' });
      }
    });

    return router;
}

module.exports = createAdminOpsRouter;
