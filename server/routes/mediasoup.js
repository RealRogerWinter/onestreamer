// server/routes/mediasoup.js
//
// /api/mediasoup/* router. WebRTC transport / producer / consumer endpoints
// the streamer + viewer clients hit during a session. Extracted from
// server/index.js in PR-G3.
//
// Service access:
//   - mediasoupService lives at module scope in server/index.js (it branches
//     on USE_WEBRTC_ADAPTER before the service factory runs), so it's
//     exposed on app.locals and read via `req.app.locals.mediasoupService`
//     at request time. Each handler short-circuits with a JSON 500 if the
//     service isn't initialized.

const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'mediasoup' });

const router = express.Router();

function getMediasoup(req, res) {
  const service = req.app.locals.mediasoupService;
  if (!service) {
    res.status(500).json({ error: 'mediasoupService not initialized' });
    return null;
  }
  return service;
}

router.get('/router-capabilities', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    // CRITICAL iOS FIX: Use optimized method that handles iOS-specific codec filtering
    const preferH264 = req.query.preferH264 === 'true';
    const rtpCapabilities = await mediasoupService.getRouterRtpCapabilities(preferH264);

    if (preferH264) {
      logger.debug('📱 MEDIASOUP: Sent iOS-optimized RTP capabilities (H264 Baseline only)');
    }

    res.json({ rtpCapabilities });
  } catch (error) {
    logger.error('❌ Failed to get router capabilities:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/create-transport', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, isMobile } = req.body;
    logger.debug(`📡 API: Creating transport for ${socketId} (mobile: ${isMobile}) (current streamer: ${mediasoupService.getCurrentStreamer()})`);
    const transportOptions = await mediasoupService.createWebRtcTransport(socketId, isMobile);
    logger.debug(`✅ API: Transport created successfully for ${socketId}`);
    res.json(transportOptions);
  } catch (error) {
    logger.error(`❌ API: Failed to create transport for ${req.body && req.body.socketId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/connect-transport', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, dtlsParameters } = req.body;
    await mediasoupService.connectTransport(socketId, dtlsParameters);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Failed to connect transport:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/produce', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, kind, rtpParameters, appData } = req.body;

    // Comprehensive logging for debugging MID issues
    logger.debug('=== PRODUCE REQUEST DEBUG ===');
    logger.debug(`📡 MEDIASOUP: Produce request from ${socketId} for ${kind}`);
    logger.debug('RTP Parameters MID:', rtpParameters?.mid);
    logger.debug('RTP Codecs:', JSON.stringify(rtpParameters?.codecs?.map(c => ({ mimeType: c.mimeType, payloadType: c.payloadType })), null, 2));
    logger.debug('Socket ID:', socketId);
    logger.debug('Kind:', kind);
    logger.debug('App Data:', JSON.stringify(appData, null, 2));

    // Log current router state
    try {
      const router = mediasoupService.getRouter();
      if (router && router._producers) {
        logger.debug('ROUTER - Active producers:', router._producers.size);
        let midConflict = false;
        router._producers.forEach((producer, id) => {
          const producerMid = producer.rtpParameters?.mid;
          logger.debug(`  Producer ${id}: MID=${producerMid}, kind=${producer.kind}, closed=${producer.closed}`);
          if (producerMid === rtpParameters?.mid && !producer.closed) {
            logger.error(`⚠️ MID CONFLICT DETECTED! MID ${producerMid} already taken by producer ${id}`);
            midConflict = true;
          }
        });

        // Emergency MID override for real users if conflict detected
        if (midConflict && rtpParameters?.mid === '0') {
          const newMid = '100';  // Use different range for real users
          logger.debug(`🔄 OVERRIDING MID from ${rtpParameters.mid} to ${newMid} to avoid conflict`);
          rtpParameters.mid = newMid;
        }
      }
    } catch (routerError) {
      logger.error('Could not inspect router state:', routerError.message);
    }

    if (!socketId || !kind || !rtpParameters) {
      logger.error('Missing required parameters:', { socketId: !!socketId, kind: !!kind, rtpParameters: !!rtpParameters });
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    logger.debug('Calling mediasoupService.produce with MID:', rtpParameters.mid);
    const producerId = await mediasoupService.produce(socketId, kind, rtpParameters, appData);
    logger.debug(`✅ MEDIASOUP: Producer created for ${socketId}: ${producerId} with MID ${rtpParameters.mid}`);

    res.json({ success: true, producerId });
  } catch (error) {
    logger.error('❌ MEDIASOUP: Failed to produce:', error);
    logger.error('Full error stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

router.post('/consume', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, producerId, rtpCapabilities } = req.body;
    logger.debug(`📡 MEDIASOUP: Consume request from ${socketId} for producer ${producerId}`);

    if (!socketId || !producerId || !rtpCapabilities) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const consumer = await mediasoupService.consume(socketId, producerId, rtpCapabilities);

    if (!consumer) {
      return res.status(404).json({ error: 'Producer not found or cannot consume' });
    }

    logger.debug(`✅ MEDIASOUP: Consumer created for ${socketId}: ${consumer.id}`);

    res.json({
      success: true,
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    });
  } catch (error) {
    logger.error('❌ MEDIASOUP: Failed to consume:', error);
    res.status(500).json({ error: error.message });
  }
});

// ICE restart endpoint for handling network changes (WiFi to 5G, etc)
router.post('/restart-ice', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, transportId } = req.body;

    if (!socketId || !transportId) {
      return res.status(400).json({ error: 'Socket ID and Transport ID required' });
    }

    const iceParameters = await mediasoupService.restartTransportIce(socketId, transportId);
    logger.debug(`🔄 ICE restart for ${socketId}`);
    res.json({ success: true, iceParameters });
  } catch (error) {
    logger.error('❌ ICE restart failed:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  const stats = mediasoupService.getStats();
  res.json(stats);
});

module.exports = router;
