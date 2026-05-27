/**
 * Health / root / WebRTC backend-config endpoints.
 *
 * Extracted from `server/index.js` as part of Phase 15B.3.a (the natural
 * opener for the route-extraction sub-PRs — three handlers, the smallest
 * cluster from the PR-15B.1 inventory). Cluster-internal cohesion:
 * `GET /` and `GET /health` are the orchestrator's externally-visible
 * liveness surface; `GET /api/admin/webrtc/config` reports the same kind
 * of orchestrator-level config (which WebRTC backend is wired and which
 * env vars chose it). All three are pure read endpoints with no state
 * mutation; they need module-scope orchestrator state via `req.app.locals`.
 *
 * State deps:
 *   - `req.app.locals.usingAdapter`   set at index.js module-load
 *   - `req.app.locals.webrtcAdapter`  set at index.js module-load (mirrors
 *                                     global.webrtcAdapter — the existing
 *                                     pattern is to also expose on app.locals
 *                                     so route modules don't reach into
 *                                     `global`)
 *   - `req.app.locals.adminKey`       set at index.js module-load
 */

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.json({
        message: 'OneStreamer API Server',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            streamStatus: '/api/stream/status',
            frontend: process.env.CLIENT_URL || 'https://onestreamer.live:3443',
        },
    });
});

router.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

router.get('/api/admin/webrtc/config', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
    const correctKey = req.app.locals.adminKey;

    if (adminKey !== correctKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const usingAdapter = req.app.locals.usingAdapter;
    const adapter = req.app.locals.webrtcAdapter;

    res.json({
        adapterEnabled: usingAdapter,
        currentBackend: usingAdapter && adapter ? adapter.getBackendType() : 'mediasoup',
        availableBackends: ['mediasoup', 'livekit'],
        environmentVariables: {
            USE_WEBRTC_ADAPTER: process.env.USE_WEBRTC_ADAPTER || 'false',
            WEBRTC_BACKEND: process.env.WEBRTC_BACKEND || 'mediasoup',
        },
    });
});

module.exports = router;
