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
 * Handler bodies are VERBATIM from the parent, all backed by the legacy
 * TestStreamService (client-side pattern generation).
 */

const express = require('express');

function createTestStreamRouter(deps) {
    const {
        adminKeyAuth,
        streamService,
        webrtcService,
        testStreamService,
        mediaStreamService,
        streamNotifier,
        viewerCountNotifier,
        broadcastGlobalCooldown,
        notifyViewersStreamEnded,
        io,
        logger,
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

      // NOTE: the prior ViewbotService.stopViewbot() short-circuit here was
      // removed with the ViewbotService creation half — live viewbots are
      // never started through it under LiveKit, so this endpoint now only
      // stops the legacy TestStreamService pattern.
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
