/**
 * ViewBot HTTP admin bridge — extracted from `server/index.js` as part of
 * Phase 15B.3.e, then decomposed into cohesive sub-route modules under
 * `server/routes/viewbot-admin/`. This file is now a THIN PARENT: it accepts
 * the same factory `deps` bag as before and mounts each sub-router at the SAME
 * base path ('/'), so once mounted at the app root in `server/index.js` every
 * path, method, middleware/auth order, and handler body is byte-for-byte
 * identical to the prior monolithic router.
 *
 * Route families and the sub-module each lives in:
 *
 *   viewbots.js          /admin/viewbot/{start,stop,status,config,spawn,
 *                          :viewbotId,health}, /admin/viewbot-manager/toggle-mode
 *   test-stream.js       /admin/test-stream/{start,stop,status,config,frame}
 *   webrtc.js            /admin/viewbot-webrtc/{create,:botId/start,:botId/stop,
 *                          status}
 *
 * NOTE: the admin viewbot-CLIENT fleet sub-routers (viewbot-client.js,
 * rotation.js, debug.js, streaming-method.js) and the standalone
 * viewbot-api.js / viewbot-diagnostics.js were deleted along with
 * ViewBotClientService — that fleet is dead under LiveKit. The LIVE
 * viewbot path (ViewBotURLService + SimpleViewBotRotation +
 * ViewBotLiveKitService + RandomStreamRotationService) is unaffected.
 *
 * Auth: a mix of `adminKeyAuth` (legacy X-Admin-Key), `viewBotAuth`
 * (combined JWT-or-key), and `authenticateAdmin` (JWT only). All three
 * middleware functions are passed in via the factory's deps bag — they
 * are defined inline in `server/index.js` and shared across the rest
 * of the admin surface that hasn't been extracted yet.
 *
 * Lazy services (`viewbotService`, `viewBotWebRTCService`) are assigned
 * inside `startServer()`. The factory accepts getter functions for each
 * and the sub-routers inline `getX()` at every original reference site.
 */

const express = require('express');

const createViewbotsRouter = require('./viewbot-admin/viewbots');
const createTestStreamRouter = require('./viewbot-admin/test-stream');
const createWebRTCRouter = require('./viewbot-admin/webrtc');

function createViewBotAdminRouter(deps) {
    const router = express.Router();

    // Mounted at the SAME base path ('/') so every path/method/auth is
    // identical once the parent is mounted at the app root in index.js.
    router.use(createViewbotsRouter(deps));
    router.use(createTestStreamRouter(deps));
    router.use(createWebRTCRouter(deps));

    return router;
}

module.exports = createViewBotAdminRouter;
