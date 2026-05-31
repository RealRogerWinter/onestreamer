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
 *   Unauthenticated / key-checked diagnostics:
 *     GET /debug/rotation-status        (no auth)
 *     GET /admin/test-rotation-auth     (inline X-Admin-Key check)
 *
 * Handler bodies are VERBATIM from the parent; the lazy ViewBotClientService
 * getter keeps its original access form. (The dead global.viewBotRotation
 * simple-rotation / modern-rotation routes were removed with the viewbot
 * graveyard.)
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

    return router;
}

module.exports = createRotationRouter;
