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
      console.log('📱 MEDIASOUP: Sent iOS-optimized RTP capabilities (H264 Baseline only)');
    }

    res.json({ rtpCapabilities });
  } catch (error) {
    console.error('❌ Failed to get router capabilities:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/create-transport', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, isMobile } = req.body;
    console.log(`📡 API: Creating transport for ${socketId} (mobile: ${isMobile}) (current streamer: ${mediasoupService.getCurrentStreamer()})`);
    const transportOptions = await mediasoupService.createWebRtcTransport(socketId, isMobile);
    console.log(`✅ API: Transport created successfully for ${socketId}`);
    res.json(transportOptions);
  } catch (error) {
    console.error(`❌ API: Failed to create transport for ${req.body && req.body.socketId}:`, error);
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
    console.error('❌ Failed to connect transport:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/produce', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, kind, rtpParameters, appData } = req.body;

    // Comprehensive logging for debugging MID issues
    console.log('=== PRODUCE REQUEST DEBUG ===');
    console.log(`📡 MEDIASOUP: Produce request from ${socketId} for ${kind}`);
    console.log('RTP Parameters MID:', rtpParameters?.mid);
    console.log('RTP Codecs:', JSON.stringify(rtpParameters?.codecs?.map(c => ({ mimeType: c.mimeType, payloadType: c.payloadType })), null, 2));
    console.log('Socket ID:', socketId);
    console.log('Kind:', kind);
    console.log('App Data:', JSON.stringify(appData, null, 2));

    // Log current router state
    try {
      const router = mediasoupService.getRouter();
      if (router && router._producers) {
        console.log('ROUTER - Active producers:', router._producers.size);
        let midConflict = false;
        router._producers.forEach((producer, id) => {
          const producerMid = producer.rtpParameters?.mid;
          console.log(`  Producer ${id}: MID=${producerMid}, kind=${producer.kind}, closed=${producer.closed}`);
          if (producerMid === rtpParameters?.mid && !producer.closed) {
            console.error(`⚠️ MID CONFLICT DETECTED! MID ${producerMid} already taken by producer ${id}`);
            midConflict = true;
          }
        });

        // Emergency MID override for real users if conflict detected
        if (midConflict && rtpParameters?.mid === '0') {
          const newMid = '100';  // Use different range for real users
          console.log(`🔄 OVERRIDING MID from ${rtpParameters.mid} to ${newMid} to avoid conflict`);
          rtpParameters.mid = newMid;
        }
      }
    } catch (routerError) {
      console.error('Could not inspect router state:', routerError.message);
    }

    if (!socketId || !kind || !rtpParameters) {
      console.error('Missing required parameters:', { socketId: !!socketId, kind: !!kind, rtpParameters: !!rtpParameters });
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    console.log('Calling mediasoupService.produce with MID:', rtpParameters.mid);
    const producerId = await mediasoupService.produce(socketId, kind, rtpParameters, appData);
    console.log(`✅ MEDIASOUP: Producer created for ${socketId}: ${producerId} with MID ${rtpParameters.mid}`);

    res.json({ success: true, producerId });
  } catch (error) {
    console.error('❌ MEDIASOUP: Failed to produce:', error);
    console.error('Full error stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

router.post('/consume', async (req, res) => {
  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;
  try {
    const { socketId, producerId, rtpCapabilities } = req.body;
    console.log(`📡 MEDIASOUP: Consume request from ${socketId} for producer ${producerId}`);

    if (!socketId || !producerId || !rtpCapabilities) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const consumer = await mediasoupService.consume(socketId, producerId, rtpCapabilities);

    if (!consumer) {
      return res.status(404).json({ error: 'Producer not found or cannot consume' });
    }

    console.log(`✅ MEDIASOUP: Consumer created for ${socketId}: ${consumer.id}`);

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
    console.error('❌ MEDIASOUP: Failed to consume:', error);
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
    console.log(`🔄 ICE restart for ${socketId}`);
    res.json({ success: true, iceParameters });
  } catch (error) {
    console.error('❌ ICE restart failed:', error);
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
