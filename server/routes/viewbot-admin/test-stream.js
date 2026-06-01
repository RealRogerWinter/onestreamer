/**
 * Test-stream (client-side pattern) sub-router, extracted from the monolithic
 * server/routes/viewbot-admin.js parent. Covers:
 *
 *   POST /admin/test-stream/start   (adminKeyAuth)
 *   POST /admin/test-stream/stop    (adminKeyAuth)
 *   GET  /admin/test-stream/status  (adminKeyAuth)
 *   POST /admin/test-stream/config  (adminKeyAuth)
 *   GET  /admin/test-stream/frame   (adminKeyAuth)
 *
 * Handler bodies are VERBATIM from the parent. The /stop handler also reaches
 * the lazy ViewbotService (legacy fallback) through its getter.
 */

const express = require('express');

function createTestStreamRouter(deps) {
    const {
        adminKeyAuth,
        streamService,
        webrtcService,
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
        logger,
        getViewbotService,
    } = deps;

    const router = express.Router();

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
              webrtcService.currentStreamer = null;
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
          webrtcService.currentStreamer = null;
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

    router.get('/admin/test-stream/status', adminKeyAuth, (req, res) => {
      const status = testStreamService.getTestStreamStatus();
      const metrics = testStreamService.getTestStreamMetrics();
      res.json({ status, metrics });
    });

    router.post('/admin/test-stream/config', adminKeyAuth, (req, res) => {
      const result = testStreamService.updateTestStreamConfig(req.body);
      res.json(result);
    });

    router.get('/admin/test-stream/frame', adminKeyAuth, (req, res) => {
      if (!testStreamService.getTestStreamStatus().isActive) {
        return res.status(400).json({ error: 'Test stream is not active' });
      }

      const frame = testStreamService.generateTestFrame();
      res.json(frame);
    });

    return router;
}

module.exports = createTestStreamRouter;
