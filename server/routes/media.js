// server/routes/media.js
//
// Companion to routes/mediasoup.js — covers the rest of the /api/* media /
// streaming surface that PR-G3 extracts from server/index.js:
//
//   /api/media/start-ingestion
//   /api/media/stop-ingestion
//   /api/media/info
//   /api/stream/status
//   /api/stream/active        (admin-gated)
//   /api/webrtc/backend
//   /api/livekit/token
//
// Mounted at /api so each handler keeps the original path. Routes live in
// the same file because they share infrastructure (mediasoupService +
// streamService + the adapter / TURN credential plumbing) and none of the
// sub-trees has enough mass to warrant its own file.
//
// Service access:
//   - streamService / sessionService / mediaStreamService come from
//     req.app.locals.services (PR-I factory bag).
//   - mediasoupService is read off req.app.locals.mediasoupService (lives
//     at module scope in server/index.js because it branches on
//     USE_WEBRTC_ADAPTER).
//   - usingAdapter + global.webrtcAdapter: usingAdapter is exposed on
//     app.locals; global.webrtcAdapter is the actual adapter instance
//     (set in server/index.js when USE_WEBRTC_ADAPTER=true).
//   - generateTurnCredentials is exposed on app.locals so we don't
//     duplicate the HMAC / TURN_SECRET wiring here.
//   - database is required directly (singleton module).

const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'media' });

const router = express.Router();

const database = require('../database/database');
const { authenticateAdmin } = require('../middleware/auth');

function getMediasoup(req, res) {
  const service = req.app.locals.mediasoupService;
  if (!service) {
    res.status(500).json({ error: 'mediasoupService not initialized' });
    return null;
  }
  return service;
}

// ── /api/stream/* ───────────────────────────────────────────────────────────

router.get('/stream/status', (req, res) => {
  const { streamService, mediaStreamService } = req.app.locals.services;
  const mediasoupService = req.app.locals.mediasoupService;
  const status = streamService.getStreamStatus();
  const mediaInfo = mediaStreamService.getStreamInfo();

  // Add MediaSoup producer info if available
  let producerInfo = null;
  if (mediasoupService && mediasoupService.currentStreamer) {
    const producers = mediasoupService.producers.get(mediasoupService.currentStreamer);
    if (producers) {
      producerInfo = {
        videoProducerId: producers.get('video')?.id || null,
        audioProducerId: producers.get('audio')?.id || null
      };
    }
  }

  res.json({
    ...status,
    mediaStream: mediaInfo,
    producers: producerInfo
  });
});

router.get('/stream/active', authenticateAdmin, async (req, res) => {
  try {
    const { streamService, sessionService } = req.app.locals.services;
    const currentStreamer = streamService.getCurrentStreamer();
    const streamType = streamService.getStreamType();

    if (currentStreamer) {
      // Get user info if available
      let streamerInfo = null;
      if (sessionService) {
        const userId = sessionService.getUserIdBySocketId(currentStreamer);
        if (userId && userId > 0) {
          // Only try to get username for real users (positive IDs)
          try {
            const userQuery = `SELECT username FROM users WHERE id = ?`;
            streamerInfo = await new Promise((resolve, reject) => {
              database.all(userQuery, [userId], (err, rows) => {
                if (err || !rows || rows.length === 0) resolve(null);
                else resolve(rows[0].username);
              });
            });
          } catch (dbError) {
            logger.debug('Could not fetch username from database:', dbError.message);
          }
        }
      }

      res.json({
        currentStreamer: streamerInfo || currentStreamer,
        streamerId: currentStreamer,
        streamType: streamType,
        isActive: true
      });
    } else {
      res.json({
        currentStreamer: null,
        streamerId: null,
        streamType: null,
        isActive: false
      });
    }
  } catch (error) {
    logger.error('Error fetching active stream:', error);
    res.status(500).json({ error: 'Failed to fetch active stream' });
  }
});

// ── /api/media/* (Simple Media Ingestion API — temporary mock) ──────────────

router.post('/media/start-ingestion', async (req, res) => {
  const { mediaStreamService } = req.app.locals.services;
  const { streamerId } = req.body;

  if (!streamerId) {
    return res.status(400).json({ error: 'streamerId is required' });
  }

  try {
    const result = await mediaStreamService.startIngestion(streamerId);
    res.json(result);
  } catch (error) {
    logger.error('Media ingestion start failed:', error);
    res.status(500).json({ error: 'Failed to start media ingestion' });
  }
});

router.post('/media/stop-ingestion', (req, res) => {
  const { mediaStreamService } = req.app.locals.services;
  mediaStreamService.stopIngestion();
  res.json({ success: true });
});

router.get('/media/info', (req, res) => {
  const { mediaStreamService } = req.app.locals.services;
  const info = mediaStreamService.getStreamInfo();
  res.json(info);
});

// ── /api/webrtc/* — Backend management (only meaningful when adapter on) ────

router.get('/webrtc/backend', (req, res) => {
  const usingAdapter = !!req.app.locals.usingAdapter;
  if (!usingAdapter) {
    return res.json({
      backend: 'mediasoup',
      adapterEnabled: false,
      message: 'Backend switching not available. Set USE_WEBRTC_ADAPTER=true to enable.'
    });
  }

  const mediasoupService = getMediasoup(req, res);
  if (!mediasoupService) return;

  const adapter = global.webrtcAdapter;
  res.json({
    backend: adapter.getBackendType(),
    adapterEnabled: true,
    info: adapter.getBackendInfo(),
    stats: mediasoupService.getStats()
  });
});

// ── /api/livekit/token — Token endpoint (for testing) ───────────────────────

router.get('/livekit/token', async (req, res) => {
  const usingAdapter = !!req.app.locals.usingAdapter;
  if (!usingAdapter || !global.webrtcAdapter || global.webrtcAdapter.getBackendType() !== 'livekit') {
    return res.status(400).json({
      error: 'LiveKit backend not active',
      hint: 'Enable with: USE_WEBRTC_ADAPTER=true WEBRTC_BACKEND=livekit'
    });
  }

  const generateTurnCredentials = req.app.locals.generateTurnCredentials;
  if (typeof generateTurnCredentials !== 'function') {
    return res.status(500).json({ error: 'generateTurnCredentials not initialized' });
  }

  const identity = req.query.identity || `user-${Date.now()}`;
  const roomName = req.query.room || 'onestreamer-main';

  try {
    // Get the LiveKit service through the adapter's backend
    const livekitService = global.webrtcAdapter._backend;
    const token = await livekitService.generateToken(identity, {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    // Generate TURN credentials for clients behind NAT (especially iOS Safari)
    const turnCreds = generateTurnCredentials(identity);

    res.json({
      token: token,
      url: livekitService.config.wsUrl,
      roomName: roomName,
      identity: identity,
      turnServers: {
        // CRITICAL: Use direct IP to bypass Cloudflare proxy (doesn't forward TURN/UDP)
        urls: [
          'stun:<SERVER_IP>:3478',
          'turn:<SERVER_IP>:3478?transport=udp',
          'turn:<SERVER_IP>:3478?transport=tcp',
          'turns:<SERVER_IP>:5349?transport=tcp'
        ],
        username: turnCreds.username,
        credential: turnCreds.credential,
        ttl: turnCreds.ttl
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
