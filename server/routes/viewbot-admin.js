/**
 * ViewBot HTTP admin bridge — extracted from `server/index.js` as part of
 * Phase 15B.3.e. Covers ~52 routes across the following path families:
 *
 *   /admin/viewbot/{start,stop,status,config,spawn,:viewbotId,health}
 *   /admin/test-stream/{start,stop,status,config,frame}
 *   /admin/viewbot-manager/toggle-mode
 *   /admin/viewbot-webrtc/{create,:botId/start,:botId/stop,status}
 *   /admin/viewbot-client/{create,create-streamer,:botId/start,:botId/stop,
 *                          all,:botId,status,:botId/status,:botId/config,
 *                          :botId/name,upload-video,health,rotation/*,
 *                          real-streamer-status,debug/*,streaming-method}
 *   /admin/simple-rotation/{status,start,stop,force,settings}
 *   /admin/viewbot/rotation/{status,force,enable,disable}
 *   /debug/rotation-status
 *   /admin/test-rotation-auth
 *
 * Auth: a mix of `adminKeyAuth` (legacy X-Admin-Key), `viewBotAuth`
 * (combined JWT-or-key), and `authenticateAdmin` (JWT only). All three
 * middleware functions are passed in via the factory's deps bag — they
 * are defined inline in `server/index.js` and shared across the rest
 * of the admin surface that hasn't been extracted yet.
 *
 * Lazy services (`viewbotService`, `viewBotClientService`,
 * `viewBotWebRTCService`) are assigned inside `startServer()`. The
 * factory below accepts getter functions for each and inlines
 * `getX()` at every original reference site — mirrors the pattern
 * `bootstrap/register-socket-handlers.js` established in PR 15B.5.
 * The pre-PR body used direct module-scope refs (closure-resolved at
 * request-handler time, which is always after startServer); the
 * post-PR getter form preserves the same runtime resolution while
 * making the lazy-service dependency explicit.
 *
 * Body byte-equivalent except for:
 *   - `app.X(...)` → `router.X(...)` at the line starts
 *   - `viewbotService` / `viewBotClientService` / `viewBotWebRTCService`
 *     → `getViewbotService()` / `getViewBotClientService()` /
 *     `getViewBotWebRTCService()` at each reference site (string
 *     literals and member-access positions preserved)
 *
 * Every other dep (`streamService`, `mediasoupService`, `sessionService`,
 * `testStreamService`, `mediaStreamService`, `buffNotifier`, `streamNotifier`,
 * `viewerCountNotifier`, `cleanupViewbotUsername`, `broadcastGlobalCooldown`,
 * `notifyViewersStreamEnded`, `io`, `ADMIN_KEY`, `upload`, `uploadsDir`,
 * `path`, `logger`) is destructured from the factory args bag and used
 * verbatim. Globals (`global.viewBotManager`, `global.viewBotRotation`,
 * `global.portMonitor`) keep their `global.X` access in-body so this
 * module doesn't need a re-export shim.
 */

const express = require('express');

function createViewBotAdminRouter(deps) {
    const {
        adminKeyAuth,
        viewBotAuth,
        authenticateAdmin,
        streamService,
        mediasoupService,
        sessionService,
        testStreamService,
        mediaStreamService,
        buffNotifier,
        streamNotifier,
        viewerCountNotifier,
        cleanupViewbotUsername,
        broadcastGlobalCooldown,
        notifyViewersStreamEnded,
        io,
        ADMIN_KEY,
        upload,
        uploadsDir,
        path,
        logger,
        // Lazy-service getters (resolved at request-handler time):
        getViewbotService,
        getViewBotClientService,
        getViewBotWebRTCService,
    } = deps;

    const router = express.Router();

    router.post('/admin/viewbot/start', adminKeyAuth, async (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }
  
      const result = await getViewbotService().startViewbot(req.body);
  
      if (result.success) {
        // Set viewbot as the active streamer
        streamService.setStreamer(result.streamId, 'viewbot');
    
        // Create synthetic user ID for viewbot to enable buff/debuff support
        const syntheticUserId = -Math.abs(result.streamId.hashCode ? result.streamId.hashCode() : result.streamId.split('-')[1].slice(0, 8).split('').reduce((a, b) => (a * 31 + b.charCodeAt(0)) & 0x7fffffff, 0));
        logger.info(`🎭 BUFF: Created synthetic user ID ${syntheticUserId} for viewbot ${result.streamId}`);
    
        // Link synthetic user ID to viewbot socket ID for buff system compatibility
        sessionService.linkUserToSocket(result.streamId, syntheticUserId);
        logger.info(`🎭 BUFF: Linked viewbot ${result.streamId} to synthetic user ${syntheticUserId} for buff system`);
    
        io.emit('new-streamer', { 
          streamerId: result.streamId, 
          newStreamId: result.streamId,
          isViewbot: true, 
          hasRealStream: result.hasRealStream,
          streamType: 'viewbot' 
        });
        viewerCountNotifier.broadcast();
    
        // Broadcast global cooldown to all users
        await broadcastGlobalCooldown(result.streamId);
      }
  
      res.json(result);
    });

    // Test stream endpoint - client-side pattern generation approach
    router.post('/admin/test-stream/start', adminKeyAuth, async (req, res) => {
      logger.info('🧪 TEST: Starting client-side test pattern stream');
  
      const result = testStreamService.startTestStream(req.body);
  
      if (result.success) {
        // Set test stream as the active streamer
        streamService.setStreamer(result.streamId, 'test');
    
        logger.info('🧪 TEST: Test stream started, notifying viewers to generate client-side pattern');
    
        // Instead of creating fake MediaSoup producers, signal viewers to generate test pattern
        io.emit('test-pattern-stream', { 
          streamerId: result.streamId, 
          newStreamId: result.streamId,
          isTestStream: true, 
          hasRealStream: false, // No real MediaSoup stream
          streamType: 'test-pattern',
          testConfig: {
            pattern: req.body.content || 'color-bars',
            resolution: `${req.body.width || 1280}x${req.body.height || 720}`,
            frameRate: req.body.frameRate || 30
          }
        });
        viewerCountNotifier.broadcast();
    
        // Broadcast global cooldown to all users
        await broadcastGlobalCooldown(result.streamId);
      }
  
      res.json({
        success: result.success,
        message: result.success ? 'Test pattern stream started (client-side generation)' : result.message,
        streamId: result.streamId,
        isTestStream: true,
        hasRealStream: false, // Indicate this is a client-generated pattern
        streamType: 'test-pattern'
      });
    });

    router.post('/admin/viewbot/stop', adminKeyAuth, async (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }
  
      const result = await getViewbotService().stopViewbot();
  
      if (result.success) {
        // Clean up viewbot username cache
        cleanupViewbotUsername(result.streamId);
    
        // Clean up synthetic user mapping for viewbot
        sessionService.linkUserToSocket(result.streamId, null);
        logger.info(`🎭 BUFF: Cleaned up synthetic user mapping for stopped viewbot ${result.streamId}`);
    
        // Clear the viewbot from active streamer
        if (streamService.getCurrentStreamer() === result.streamId) {
          streamService.clearStreamer();
          mediasoupService.currentStreamer = null;
          logger.info(`🧹 VIEWBOT STOP: Cleared ${result.streamId} from both services`);
      
          // Clear streamer buff display when viewbot streaming ends
          logger.info(`🎭 BUFF: Clearing streamer buffs display (viewbot ended)`);
          buffNotifier.streamerBuffsUpdate({ buffs: [] });
      
          streamNotifier.streamEnded({ reason: 'viewbot_stopped' });
          notifyViewersStreamEnded();
          notifyViewersStreamEnded();
          viewerCountNotifier.broadcast();
        }
      }

      res.json(result);
    });

    router.post('/admin/test-stream/stop', adminKeyAuth, async (req, res) => {
      logger.info('🧪 LEGACY TEST: Stopping test stream');
  
      // Try to stop ViewbotService first (if it was used for the test stream)
      if (getViewbotService()) {
        const currentStreamer = streamService.getCurrentStreamer();
        if (currentStreamer && getViewbotService().isViewbotStream(currentStreamer)) {
          logger.info('🧪 LEGACY TEST: Stopping ViewbotService test stream');
          const viewbotResult = await getViewbotService().stopViewbot();
      
          if (viewbotResult.success) {
            // Clean up viewbot username cache
            cleanupViewbotUsername(viewbotResult.streamId);
        
            // Clean up synthetic user mapping for viewbot
            sessionService.linkUserToSocket(viewbotResult.streamId, null);
            logger.info(`🎭 BUFF: Cleaned up synthetic user mapping for legacy stopped viewbot ${viewbotResult.streamId}`);
        
            if (streamService.getCurrentStreamer() === viewbotResult.streamId) {
              streamService.clearStreamer();
              mediasoupService.currentStreamer = null;
              logger.info(`🧹 VIEWBOT LEGACY STOP: Cleared ${viewbotResult.streamId} from both services`);
          
              // Clear streamer buff display when viewbot streaming ends
              logger.info(`🎭 BUFF: Clearing streamer buffs display (viewbot legacy ended)`);
              buffNotifier.streamerBuffsUpdate({ buffs: [] });
          
              streamNotifier.streamEnded({ reason: 'viewbot_legacy_stopped' });
          notifyViewersStreamEnded();
              viewerCountNotifier.broadcast();
            }
          }

          return res.json({
            success: viewbotResult.success,
            message: 'Test stream (ViewbotService) stopped',
            streamId: viewbotResult.streamId
          });
        }
      }

      // Fallback to legacy test stream service
      const result = testStreamService.stopTestStream();

      if (result.success) {
        // Clear the test stream from active streamer
        if (streamService.getCurrentStreamer() === result.streamId) {
          streamService.clearStreamer();
          mediasoupService.currentStreamer = null;
          logger.info(`🧹 TEST STREAM STOP: Cleared ${result.streamId} from both services`);

          // Also stop media ingestion
          mediaStreamService.stopIngestion();

          streamNotifier.streamEnded({ reason: 'test_stream_stopped' });
          notifyViewersStreamEnded();
          notifyViewersStreamEnded();
          viewerCountNotifier.broadcast();
        }
      }
  
      res.json(result);
    });

    router.get('/admin/viewbot/status', adminKeyAuth, (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }
  
      const status = getViewbotService().getViewbotStatus();
      const metrics = getViewbotService().getViewbotMetrics();
      const health = getViewbotService().isHealthy();
      res.json({ status, metrics, health });
    });

    router.get('/admin/test-stream/status', adminKeyAuth, (req, res) => {
      const status = testStreamService.getTestStreamStatus();
      const metrics = testStreamService.getTestStreamMetrics();
      res.json({ status, metrics });
    });

    router.post('/admin/viewbot/config', adminKeyAuth, (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }
  
      const result = getViewbotService().updateViewbotConfig(req.body);
      res.json(result);
    });

    router.post('/admin/test-stream/config', adminKeyAuth, (req, res) => {
      const result = testStreamService.updateTestStreamConfig(req.body);
      res.json(result);
    });

    // Additional viewbot management endpoints
    router.post('/admin/viewbot/spawn', adminKeyAuth, async (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }
  
      const result = await getViewbotService().spawnAdditionalViewbot(req.body);
      res.json(result);
    });

    router.delete('/admin/viewbot/:viewbotId', adminKeyAuth, async (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }
  
      const { viewbotId } = req.params;
      const result = await getViewbotService().removeViewbot(viewbotId);
      res.json(result);
    });

    router.get('/admin/viewbot/health', adminKeyAuth, (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }
  
      const health = getViewbotService().isHealthy();
      res.json(health);
    });

    // ViewBotWebRTCService endpoints (for mobile 5G/TURN support)
    // ViewBotManager mode toggle endpoint
    router.post('/admin/viewbot-manager/toggle-mode', viewBotAuth, async (req, res) => {
      if (!global.viewBotManager) {
        return res.status(503).json({ error: 'ViewBot Manager not initialized' });
      }
  
      try {
        const { useWebRTC } = req.body;
        const result = await global.viewBotManager.toggleMode(useWebRTC);
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, 'Error toggling viewbot mode');
        res.status(500).json({ error: 'Failed to toggle mode' });
      }
    });

    router.post('/admin/viewbot-webrtc/create', viewBotAuth, async (req, res) => {
      if (!getViewBotWebRTCService()) {
        return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
      }
  
      const config = req.body.config || req.body;
      config.useWebRTC = true; // Force WebRTC for TURN support
  
      const result = await getViewBotWebRTCService().createViewBot(config);
      res.json(result);
    });

    router.post('/admin/viewbot-webrtc/:botId/start', viewBotAuth, async (req, res) => {
      if (!getViewBotWebRTCService()) {
        return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
      }
  
      const { botId } = req.params;
      const result = await getViewBotWebRTCService().startViewBot(botId);
      res.json(result);
    });

    router.post('/admin/viewbot-webrtc/:botId/stop', viewBotAuth, async (req, res) => {
      if (!getViewBotWebRTCService()) {
        return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
      }
  
      const { botId } = req.params;
      const result = await getViewBotWebRTCService().stopViewBot(botId);
      res.json(result);
    });

    router.get('/admin/viewbot-webrtc/status', viewBotAuth, async (req, res) => {
      if (!getViewBotWebRTCService()) {
        return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
      }
  
      const status = getViewBotWebRTCService().listViewBots();
      res.json({ viewbots: status });
    });

    // ViewBotClientService endpoints
    router.post('/admin/viewbot-client/create', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      // Handle both config formats:
      // 1. { config: { contentType: 'videoFile', ... } } - nested format  
      // 2. { contentType: 'videoFile', autoStart: true, ... } - flat format from UI
      const config = req.body.config || req.body;
  
      const result = await getViewBotClientService().createBot(config);
      res.json(result);
    });

    router.post('/admin/viewbot-client/create-streamer', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      // Handle both config formats:
      // 1. { config: { contentType: 'videoFile', ... } } - nested format
      // 2. { contentType: 'videoFile', autoStart: true, ... } - flat format from UI
      const config = req.body.config || req.body;
  
      logger.info({ config }, '📋 SERVER: Creating ViewBot with config');
  
      const result = await getViewBotClientService().createStreamerBot(config);
      res.json(result);
    });

    router.post('/admin/viewbot-client/:botId/start', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { botId } = req.params;
      logger.info(`📡 API: Starting ViewBot ${botId} via HTTP endpoint`);
      const result = await getViewBotClientService().startBotStreaming(botId);
      logger.info({ result }, `📡 API: ViewBot ${botId} start result`);
      res.json(result);
    });

    router.post('/admin/viewbot-client/:botId/stop', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { botId } = req.params;
      const result = await getViewBotClientService().stopBotStreaming(botId);
      res.json(result);
    });

    // Destroy all ViewBots (must come before /:botId route)
    router.delete('/admin/viewbot-client/all', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const result = await getViewBotClientService().destroyAllBots();
      res.json(result);
    });

    // Destroy specific ViewBot
    router.delete('/admin/viewbot-client/:botId', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { botId } = req.params;
      const result = await getViewBotClientService().destroyBot(botId);
      res.json(result);
    });

    router.get('/admin/viewbot-client/status', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      try {
        const status = await getViewBotClientService().getAllBotsStatus();
        res.json(status);
      } catch (error) {
        logger.error({ err: error }, 'Failed to get ViewBot status');
        res.status(500).json({ error: 'Failed to get ViewBot status' });
      }
    });

    router.get('/admin/viewbot-client/:botId/status', authenticateAdmin, (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { botId } = req.params;
      const status = getViewBotClientService().getBotStatus(botId);
      res.json(status);
    });

    router.put('/admin/viewbot-client/:botId/config', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { botId } = req.params;
      const result = await getViewBotClientService().updateBotConfig(botId, req.body);
      res.json(result);
    });

    router.put('/admin/viewbot-client/:botId/name', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { botId } = req.params;
      const { name } = req.body;
  
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Valid name is required' });
      }
  
      try {
        const result = await getViewBotClientService().updateBotName(botId, name.trim());
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, `Failed to update ViewBot name for ${botId}`);
        res.status(500).json({ error: 'Failed to update ViewBot name' });
      }
    });

    // Video upload endpoint for ViewBot
    router.post('/admin/viewbot-client/upload-video', viewBotAuth, upload.single('video'), async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'No video file provided' });
        }

        // Return the absolute file path where the file is actually stored
        const filePath = path.join(uploadsDir, req.file.filename);
    
        logger.info({
          originalName: req.file.originalname,
          filename: req.file.filename,
          size: req.file.size,
          path: filePath,
          absolutePath: filePath
        }, 'ViewBot video uploaded');

        res.json({ 
          success: true, 
          filePath: filePath,
          filename: req.file.filename,
          originalName: req.file.originalname,
          size: req.file.size
        });
      } catch (error) {
        logger.error({ err: error }, 'Error uploading ViewBot video');
        res.status(500).json({ error: 'Failed to upload video file' });
      }
    });

    router.get('/admin/viewbot-client/health', viewBotAuth, (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      // Validate real streamer status before returning health data
      getViewBotClientService().validateRealStreamerStatus();
  
      const health = getViewBotClientService().getHealthStatus();
      res.json(health);
    });

    // ViewBot Diagnostics Routes (mounted on specific path to avoid conflicts)
    const viewBotDiagnostics = require('./viewbot-diagnostics');
    router.use('/admin/viewbot-diagnostics', viewBotDiagnostics);

    // ViewBot Rotation System Endpoints
    router.post('/admin/viewbot-client/rotation/toggle', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
  
      try {
        const result = await getViewBotClientService().toggleRotation(enabled);
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, 'Error toggling ViewBot rotation');
        res.status(500).json({ error: 'Failed to toggle rotation system' });
      }
    });

    router.post('/admin/viewbot-client/real-streamer-status', viewBotAuth, (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { isActive } = req.body;
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be a boolean' });
      }
  
      // Run validation before setting status to ensure consistency
      getViewBotClientService().validateRealStreamerStatus();
  
      const result = getViewBotClientService().setRealStreamerStatus(isActive);
      res.json(result);
    });

    // Temporary debug endpoint without auth
    router.get('/debug/rotation-status', (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const status = getViewBotClientService().getRotationStatus();
  
      // Add debug info
      if (status.currentLiveBot && getViewBotClientService().activeBots) {
        const currentBot = getViewBotClientService().activeBots.get(status.currentLiveBot);
        if (currentBot) {
          status.debug = {
            botExists: true,
            streaming: currentBot.streaming,
            timeAllotment: currentBot.timeAllotment,
            timeRemaining: currentBot.timeRemaining,
            hasTimer: !!currentBot.allotmentTimer
          };
        } else {
          status.debug = { botExists: false, currentLiveBot: status.currentLiveBot };
        }
      }
  
      res.json(status);
    });

    // Test endpoint with simple auth check
    router.get('/admin/test-rotation-auth', (req, res) => {
      const adminKey = req.headers['x-admin-key'];
      logger.info({ adminKey: !!adminKey }, '🔍 Test rotation auth - admin key present');
      if (adminKey === ADMIN_KEY) {
        if (!getViewBotClientService()) {
          return res.status(503).json({ error: 'ViewBotClientService not initialized' });
        }
        const status = getViewBotClientService().getRotationStatus();
        return res.json({ success: true, status });
      }
      return res.status(401).json({ error: 'Admin key required' });
    });

    router.get('/admin/viewbot-client/rotation/status', viewBotAuth, (req, res) => {
      logger.info('📊 Rotation status endpoint hit');
  
      if (!getViewBotClientService()) {
        logger.info('❌ ViewBotClientService not initialized');
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const status = getViewBotClientService().getRotationStatus();
      logger.info({ status }, '📊 Rotation status');
  
      // Add debug info to help diagnose the issue
      if (status.currentLiveBot && getViewBotClientService().activeBots) {
        const currentBot = getViewBotClientService().activeBots.get(status.currentLiveBot);
        if (currentBot) {
          status.debug = {
            botExists: true,
            streaming: currentBot.streaming,
            timeAllotment: currentBot.timeAllotment,
            timeRemaining: currentBot.timeRemaining,
            hasTimer: !!currentBot.allotmentTimer
          };
        } else {
          status.debug = { botExists: false, currentLiveBot: status.currentLiveBot };
        }
      }
  
      res.json(status);
    });

    router.post('/admin/viewbot-client/rotation/probability', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { probability } = req.body;
      const result = getViewBotClientService().updateRotationProbability(probability);
      res.json(result);
    });

    router.post('/admin/viewbot-client/rotation/interval', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { minInterval, maxInterval } = req.body;
      const result = getViewBotClientService().updateRotationInterval(minInterval, maxInterval);
      res.json(result);
    });

    router.post('/admin/viewbot-client/rotation/force', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      // Use the new forceRotation method
      const result = await getViewBotClientService().forceRotation();
      res.json(result);
    });

    // ViewBot Rotation endpoints (new Socket.IO-based system)
    router.get('/admin/simple-rotation/status', viewBotAuth, (req, res) => {
      // Use new rotation service
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      res.json(global.viewBotRotation.getStatus());
    });

    router.post('/admin/simple-rotation/start', viewBotAuth, async (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      await global.viewBotRotation.startRotation();
      res.json({ success: true, message: 'ViewBot rotation started' });
    });

    router.post('/admin/simple-rotation/stop', viewBotAuth, async (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      await global.viewBotRotation.stopRotation();
      res.json({ success: true, message: 'ViewBot rotation stopped' });
    });

    router.post('/admin/simple-rotation/force', viewBotAuth, async (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      await global.viewBotRotation.forceRotation();
      res.json({ success: true, message: 'Rotation forced' });
    });

    router.post('/admin/simple-rotation/settings', viewBotAuth, (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      global.viewBotRotation.updateSettings(req.body);
      res.json({ success: true, settings: global.viewBotRotation.settings });
    });

    // Modern ViewBot rotation endpoints (used by UI)
    router.get('/admin/viewbot/rotation/status', viewBotAuth, async (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      const status = global.viewBotRotation.getStatus();
  
      // Add port monitor status if available
      let portStatus = null;
      if (global.portMonitor) {
        portStatus = await global.portMonitor.getStatus();
      }
  
      res.json({ 
        success: true, 
        status: {
          ...status,
          totalVideos: global.viewBotRotation.bots.length,
          nextRotationIn: 60000, // Placeholder
          portMonitor: portStatus
        }
      });
    });

    router.post('/admin/viewbot/rotation/force', viewBotAuth, async (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      await global.viewBotRotation.forceRotation();
      res.json({ success: true, message: 'Forced rotation to next video' });
    });

    router.post('/admin/viewbot/rotation/enable', viewBotAuth, async (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      await global.viewBotRotation.startRotation();
      res.json({ success: true, message: 'ViewBot rotation enabled' });
    });

    router.post('/admin/viewbot/rotation/disable', viewBotAuth, async (req, res) => {
      if (!global.viewBotRotation) {
        return res.status(503).json({ error: 'ViewBot rotation not initialized' });
      }
      await global.viewBotRotation.stopRotation();
      res.json({ success: true, message: 'ViewBot rotation disabled' });
    });

    router.post('/admin/viewbot-client/rotation/manual-takeover', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      // Manually trigger a ViewBot takeover (useful when automatic takeover fails)
      const result = await getViewBotClientService().manualTriggerTakeover();
      res.json(result);
    });

    // Debug endpoint to simulate real streamer connect/disconnect
    router.post('/admin/viewbot-client/debug/simulate-streamer', viewBotAuth, (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { action } = req.body; // 'connect' or 'disconnect'
  
      if (action === 'connect') {
        logger.info('🔧 DEBUG: Simulating real streamer connect');
        getViewBotClientService().setRealStreamerStatus(true);
        res.json({ success: true, message: 'Simulated real streamer connect', realStreamerActive: true });
      } else if (action === 'disconnect') {
        logger.info('🔧 DEBUG: Simulating real streamer disconnect');
        getViewBotClientService().setRealStreamerStatus(false);
        res.json({ success: true, message: 'Simulated real streamer disconnect', realStreamerActive: false });
      } else {
        res.status(400).json({ error: 'Invalid action. Use "connect" or "disconnect"' });
      }
    });

    // Debug endpoint to manually trigger presence maintenance
    router.post('/admin/viewbot-client/debug/check-presence', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      logger.info('🔧 DEBUG: Manually triggering presence check');
      await getViewBotClientService().maintainViewBotPresence();
  
      const status = getViewBotClientService().getRotationStatus();
      res.json({ 
        success: true, 
        message: 'Presence check completed',
        currentStatus: status
      });
    });

    // Debug endpoint to clear stuck real streamer status
    router.post('/admin/viewbot-client/debug/clear-real-streamer', viewBotAuth, (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      try {
        // Force clear real streamer status and validate
        logger.info('🔧 DEBUG: Manually clearing real streamer status');
        getViewBotClientService().setRealStreamerStatus(false);
        getViewBotClientService().validateRealStreamerStatus();
    
        const currentStreamer = streamService.getCurrentStreamer();
        logger.info(`🔧 DEBUG: Current streamer: ${currentStreamer || 'None'}`);
    
        if (currentStreamer) {
          // Enhanced ViewBot detection for debug
          const isOldViewBot = getViewbotService() && getViewbotService().isViewbotStream(currentStreamer);
          const userId = sessionService.getUserIdBySocketId(currentStreamer);
          const isNewViewBot = userId && userId < 0;
          const isViewbot = isOldViewBot || isNewViewBot;
      
          logger.info(`🔧 DEBUG: Current streamer analysis:`);
          logger.info(`   Socket: ${currentStreamer}`);
          logger.info(`   User ID: ${userId}`);
          logger.info(`   Old ViewBot: ${isOldViewBot}`);
          logger.info(`   New ViewBot: ${isNewViewBot}`);
          logger.info(`   Is ViewBot: ${isViewbot}`);
        }
    
        res.json({ 
          success: true, 
          message: 'Real streamer status cleared and validated',
          currentStreamer: currentStreamer,
          realStreamerActive: getViewBotClientService().realStreamerActive
        });
      } catch (error) {
        logger.error({ err: error }, 'Error clearing real streamer status');
        res.status(500).json({ error: 'Failed to clear real streamer status' });
      }
    });

    // Streaming Method endpoints for ViewBot
    router.get('/admin/viewbot-client/streaming-method', viewBotAuth, (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      try {
        const result = getViewBotClientService().getStreamingMethod();
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, 'Error getting streaming method');
        res.status(500).json({ error: 'Failed to get streaming method' });
      }
    });

    router.post('/admin/viewbot-client/streaming-method', viewBotAuth, async (req, res) => {
      if (!getViewBotClientService()) {
        return res.status(503).json({ error: 'ViewBotClientService not initialized' });
      }
  
      const { method } = req.body;
  
      if (!method || (method !== 'ffmpeg' && method !== 'gstreamer')) {
        return res.status(400).json({ 
          error: 'Invalid streaming method. Must be "ffmpeg" or "gstreamer"' 
        });
      }
  
      try {
        const result = await getViewBotClientService().setStreamingMethod(method);
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, 'Error setting streaming method');
        res.status(500).json({ error: error.message || 'Failed to set streaming method' });
      }
    });

    router.get('/admin/test-stream/frame', adminKeyAuth, (req, res) => {
      if (!testStreamService.getTestStreamStatus().isActive) {
        return res.status(400).json({ error: 'Test stream is not active' });
      }
  
      const frame = testStreamService.generateTestFrame();
      res.json(frame);
    });

    // ViewBot Diagnostics Routes (mounted on specific path to avoid conflicts).
    // Kept here at its original position in the cluster — it's already an
    // extracted route file (routes/viewbot-diagnostics) and just needs to be
    // mounted at the same path inside this router.
    // NOTE: the original inline call was `app.use('/admin/viewbot-diagnostics',
    // viewBotDiagnostics)` — that path is preserved relative to the router
    // mount point (the parent in index.js mounts this router at the app root).

    return router;
}

module.exports = createViewBotAdminRouter;
