/**
 * ViewBot rotation-system sub-router, extracted from the monolithic
 * server/routes/viewbot-admin.js parent. Covers the three rotation surfaces:
 *
 *   ViewBotClientService rotation (viewBotAuth):
 *     POST /admin/viewbot-client/rotation/toggle
 *     GET  /admin/viewbot-client/rotation/status
 *     POST /admin/viewbot-client/rotation/probability
 *     POST /admin/viewbot-client/rotation/interval
 *     POST /admin/viewbot-client/rotation/force
 *     POST /admin/viewbot-client/real-streamer-status
 *
 *   global.viewBotRotation simple-rotation (viewBotAuth):
 *     GET/POST /admin/simple-rotation/{status,start,stop,force,settings}
 *
 *   global.viewBotRotation modern rotation (viewBotAuth):
 *     GET/POST /admin/viewbot/rotation/{status,force,enable,disable}
 *
 *   Unauthenticated / key-checked diagnostics:
 *     GET /debug/rotation-status        (no auth)
 *     GET /admin/test-rotation-auth     (inline X-Admin-Key check)
 *
 * Handler bodies are VERBATIM from the parent. global.viewBotRotation,
 * global.portMonitor, and the lazy ViewBotClientService getter keep their
 * original access forms.
 */

const express = require('express');

function createRotationRouter(deps) {
    const {
        viewBotAuth,
        ADMIN_KEY,
        logger,
        getViewBotClientService,
    } = deps;

    const router = express.Router();

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

    return router;
}

module.exports = createRotationRouter;
