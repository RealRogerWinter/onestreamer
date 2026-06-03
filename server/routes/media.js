// server/routes/media.js
//
// Covers the /api/* media / streaming surface that PR-G3 extracts from
// server/index.js:
//
//   /api/stream/status
//   /api/stream/active        (admin-gated)
//   /api/webrtc/backend
//   /api/livekit/token
//
// Mounted at /api so each handler keeps the original path. Routes live in
// the same file because they share infrastructure (webrtcService +
// streamService + the LiveKit token / TURN credential plumbing) and none of
// the sub-trees has enough mass to warrant its own file.
//
// Service access:
//   - streamService / sessionService / mediaStreamService come from
//     req.app.locals.services (PR-I factory bag).
//   - webrtcService is read off req.app.locals.webrtcService (the
//     LiveKit backend; lives at module scope in server/index.js because the
//     services factory consumes it).
//   - generateTurnCredentials is exposed on app.locals so we don't
//     duplicate the HMAC / TURN_SECRET wiring here.
//   - database is required directly (singleton module).

const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'media' });

const router = express.Router();

const database = require('../database/database');
const { authenticateAdmin } = require('../middleware/auth');

function getWebrtcService(req, res) {
  const service = req.app.locals.webrtcService;
  if (!service) {
    res.status(500).json({ error: 'webrtcService not initialized' });
    return null;
  }
  return service;
}

// ── /api/stream/* ───────────────────────────────────────────────────────────

router.get('/stream/status', (req, res) => {
  const { streamService, mediaStreamService } = req.app.locals.services;
  const status = streamService.getStreamStatus();
  const mediaInfo = mediaStreamService.getStreamInfo();

  res.json({
    ...status,
    mediaStream: mediaInfo
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

// ── /api/webrtc/* — Backend info (LiveKit is the sole backend, ADR-0024) ────

router.get('/webrtc/backend', (req, res) => {
  const webrtcService = getWebrtcService(req, res);
  if (!webrtcService) return;

  res.json({
    backend: 'livekit',
    adapterEnabled: false,
    info: webrtcService.getBackendInfo(),
    stats: webrtcService.getStats(),
  });
});

// ── /api/livekit/token — Token endpoint (for testing) ───────────────────────

router.get('/livekit/token', async (req, res) => {
  const livekitService = getWebrtcService(req, res);
  if (!livekitService) return;

  const generateTurnCredentials = req.app.locals.generateTurnCredentials;
  if (typeof generateTurnCredentials !== 'function') {
    return res.status(500).json({ error: 'generateTurnCredentials not initialized' });
  }

  const identity = req.query.identity || `user-${Date.now()}`;
  const roomName = req.query.room || 'onestreamer-main';

  try {
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
        // CRITICAL: Use direct IP to bypass Cloudflare proxy (doesn't forward TURN/UDP).
        // Set TURN_PUBLIC_IP to the TURN server's public IP in the environment.
        urls: (() => {
          const turnIp = process.env.TURN_PUBLIC_IP || '127.0.0.1';
          return [
            `stun:${turnIp}:3478`,
            `turn:${turnIp}:3478?transport=udp`,
            `turn:${turnIp}:3478?transport=tcp`,
            `turns:${turnIp}:5349?transport=tcp`
          ];
        })(),
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
