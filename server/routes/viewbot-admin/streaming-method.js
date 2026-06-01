/**
 * ViewBot streaming-method sub-router, extracted from the monolithic
 * server/routes/viewbot-admin.js parent. Covers (all viewBotAuth):
 *
 *   GET  /admin/viewbot-client/streaming-method
 *   POST /admin/viewbot-client/streaming-method
 *
 * Handler bodies are VERBATIM from the parent. The lazy ViewBotClientService is
 * reached through its getter, resolved at request time.
 */

const express = require('express');

function createStreamingMethodRouter(deps) {
    const {
        viewBotAuth,
        logger,
        getViewBotClientService,
    } = deps;

    const router = express.Router();

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

      if (method !== 'ffmpeg') {
        return res.status(400).json({
          error: 'Invalid streaming method. Must be "ffmpeg"'
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

    return router;
}

module.exports = createStreamingMethodRouter;
