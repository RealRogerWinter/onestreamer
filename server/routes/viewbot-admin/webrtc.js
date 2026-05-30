/**
 * ViewBotWebRTCService sub-router (mobile 5G/TURN support), extracted from the
 * monolithic server/routes/viewbot-admin.js parent. Covers:
 *
 *   POST /admin/viewbot-webrtc/create        (viewBotAuth)
 *   POST /admin/viewbot-webrtc/:botId/start  (viewBotAuth)
 *   POST /admin/viewbot-webrtc/:botId/stop   (viewBotAuth)
 *   GET  /admin/viewbot-webrtc/status        (viewBotAuth)
 *
 * Handler bodies are VERBATIM from the parent. The lazy ViewBotWebRTCService is
 * reached through its getter, resolved at request time.
 */

const express = require('express');

function createWebRTCRouter(deps) {
    const {
        viewBotAuth,
        getViewBotWebRTCService,
    } = deps;

    const router = express.Router();

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

    return router;
}

module.exports = createWebRTCRouter;
