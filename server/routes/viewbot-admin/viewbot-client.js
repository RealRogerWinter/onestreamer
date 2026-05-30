/**
 * ViewBotClientService core CRUD sub-router, extracted from the monolithic
 * server/routes/viewbot-admin.js parent. Covers:
 *
 *   POST   /admin/viewbot-client/create           (viewBotAuth)
 *   POST   /admin/viewbot-client/create-streamer  (viewBotAuth)
 *   POST   /admin/viewbot-client/:botId/start      (viewBotAuth)
 *   POST   /admin/viewbot-client/:botId/stop       (viewBotAuth)
 *   DELETE /admin/viewbot-client/all               (viewBotAuth)
 *   DELETE /admin/viewbot-client/:botId            (viewBotAuth)
 *   GET    /admin/viewbot-client/status            (viewBotAuth)
 *   GET    /admin/viewbot-client/:botId/status     (authenticateAdmin)
 *   PUT    /admin/viewbot-client/:botId/config     (viewBotAuth)
 *   PUT    /admin/viewbot-client/:botId/name       (viewBotAuth)
 *   POST   /admin/viewbot-client/upload-video      (viewBotAuth, upload.single)
 *   GET    /admin/viewbot-client/health            (viewBotAuth)
 *   USE    /admin/viewbot-diagnostics              (viewbot-diagnostics router)
 *
 * Handler bodies are VERBATIM from the parent. The /all DELETE is registered
 * before the /:botId DELETE — preserved here at the same relative order.
 */

const express = require('express');

function createViewBotClientRouter(deps) {
    const {
        viewBotAuth,
        authenticateAdmin,
        upload,
        uploadsDir,
        path,
        logger,
        getViewBotClientService,
    } = deps;

    const router = express.Router();

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
    const viewBotDiagnostics = require('../viewbot-diagnostics');
    router.use('/admin/viewbot-diagnostics', viewBotDiagnostics);

    return router;
}

module.exports = createViewBotClientRouter;
