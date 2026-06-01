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
 *   test-stream.js       /admin/test-stream/{start,stop,status,config,frame}
 *
 * NOTE: the admin viewbot-CLIENT fleet sub-routers (viewbot-client.js,
 * rotation.js, debug.js, streaming-method.js) and the standalone
 * viewbot-api.js / viewbot-diagnostics.js were deleted along with
 * ViewBotClientService — that fleet is dead under LiveKit. The ViewbotService
 * CREATION/STREAMING half (the viewbots.js sub-router:
 * start/stop/status/config/spawn/health) and the ViewBotWebRTCService backend
 * (webrtc.js sub-router) were likewise removed — live viewbots run via
 * SimpleViewBotRotation → ViewBotLiveKitService, never through
 * ViewbotService.startViewbot. The LIVE viewbot path (ViewBotURLService +
 * SimpleViewBotRotation + ViewBotLiveKitService + RandomStreamRotationService)
 * is unaffected.
 *
 * Auth: the surviving test-stream routes use `adminKeyAuth` (legacy
 * X-Admin-Key), defined inline in `server/index.js` and passed via the
 * factory's deps bag.
 */

const express = require('express');

const createTestStreamRouter = require('./viewbot-admin/test-stream');

function createViewBotAdminRouter(deps) {
    const router = express.Router();

    // Mounted at the base path ('/') so once the parent is mounted at the app
    // root in index.js the paths/methods/auth are identical to the original.
    router.use(createTestStreamRouter(deps));

    return router;
}

module.exports = createViewBotAdminRouter;
