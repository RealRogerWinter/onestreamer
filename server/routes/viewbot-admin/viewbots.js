/**
 * ViewbotService CRUD + ViewBotManager mode toggle sub-router, extracted from
 * the monolithic server/routes/viewbot-admin.js parent. Covers:
 *
 *   POST   /admin/viewbot/start            (adminKeyAuth)
 *   POST   /admin/viewbot/stop             (adminKeyAuth)
 *   GET    /admin/viewbot/status           (adminKeyAuth)
 *   POST   /admin/viewbot/config           (adminKeyAuth)
 *   POST   /admin/viewbot/spawn            (adminKeyAuth)
 *   DELETE /admin/viewbot/:viewbotId       (adminKeyAuth)
 *   GET    /admin/viewbot/health           (adminKeyAuth)
 *   POST   /admin/viewbot-manager/toggle-mode (viewBotAuth)
 *
 * Handler bodies are VERBATIM from the parent. Deps arrive via the factory bag;
 * lazy services are reached through getter functions resolved at request time.
 */

const express = require('express');

function createViewbotsRouter(deps) {
    const {
        adminKeyAuth,
        viewBotAuth,
        streamService,
        webrtcService,
        sessionService,
        buffNotifier,
        streamNotifier,
        viewerCountNotifier,
        cleanupViewbotUsername,
        broadcastGlobalCooldown,
        notifyViewersStreamEnded,
        io,
        logger,
        getViewbotService,
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
          webrtcService.currentStreamer = null;
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

    router.get('/admin/viewbot/status', adminKeyAuth, (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }

      const status = getViewbotService().getViewbotStatus();
      const metrics = getViewbotService().getViewbotMetrics();
      const health = getViewbotService().isHealthy();
      res.json({ status, metrics, health });
    });

    router.post('/admin/viewbot/config', adminKeyAuth, (req, res) => {
      if (!getViewbotService()) {
        return res.status(503).json({ error: 'ViewbotService not initialized' });
      }

      const result = getViewbotService().updateViewbotConfig(req.body);
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

    return router;
}

module.exports = createViewbotsRouter;
