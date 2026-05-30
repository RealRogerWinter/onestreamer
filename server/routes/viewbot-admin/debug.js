/**
 * ViewBotClientService debug / manual-control sub-router, extracted from the
 * monolithic server/routes/viewbot-admin.js parent. Covers (all viewBotAuth):
 *
 *   POST /admin/viewbot-client/rotation/manual-takeover
 *   POST /admin/viewbot-client/debug/simulate-streamer
 *   POST /admin/viewbot-client/debug/check-presence
 *   POST /admin/viewbot-client/debug/clear-real-streamer
 *
 * Handler bodies are VERBATIM from the parent. The lazy ViewBotClientService
 * and ViewbotService getters, plus streamService/sessionService, keep their
 * original reference forms.
 */

const express = require('express');

function createDebugRouter(deps) {
    const {
        viewBotAuth,
        streamService,
        sessionService,
        logger,
        getViewbotService,
        getViewBotClientService,
    } = deps;

    const router = express.Router();

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

    return router;
}

module.exports = createDebugRouter;
