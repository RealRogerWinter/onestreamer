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
 *   viewbot-client.js    /admin/viewbot-client core CRUD + status/config/name/
 *                          upload/health + /admin/viewbot-diagnostics mount
 *   rotation.js          /admin/viewbot-client/rotation/*, real-streamer-status,
 *                          /admin/simple-rotation/*, /admin/viewbot/rotation/*,
 *                          /debug/rotation-status, /admin/test-rotation-auth
 *   debug.js             /admin/viewbot-client/rotation/manual-takeover,
 *                          /admin/viewbot-client/debug/*
 *   streaming-method.js  /admin/viewbot-client/streaming-method (GET/POST)
 *
 * MOUNT-ORDER NOTE (behavior-preserving): in the original monolith the
 * `GET /admin/viewbot-client/:botId/status` route (authenticateAdmin) is
 * registered BEFORE `GET /admin/viewbot-client/rotation/status`, so Express
 * resolves a GET to `.../rotation/status` against the `:botId/status` handler
 * (botId='rotation'). To preserve that exact resolution, `viewbot-client.js`
 * (which owns `:botId/status`) is mounted BEFORE `rotation.js` below — keeping
 * the same effective registration order as the monolith.
 *
 * Auth: a mix of `adminKeyAuth` (legacy X-Admin-Key), `viewBotAuth`
 * (combined JWT-or-key), and `authenticateAdmin` (JWT only). All three
 * middleware functions are passed in via the factory's deps bag — they
 * are defined inline in `server/index.js` and shared across the rest
 * of the admin surface that hasn't been extracted yet.
 *
 * Lazy services (`viewbotService`, `viewBotClientService`,
 * `viewBotWebRTCService`) are assigned inside `startServer()`. The
 * factory accepts getter functions for each and the sub-routers inline
 * `getX()` at every original reference site.
 */

const express = require('express');

const createViewbotsRouter = require('./viewbot-admin/viewbots');
const createTestStreamRouter = require('./viewbot-admin/test-stream');
const createWebRTCRouter = require('./viewbot-admin/webrtc');
const createViewBotClientRouter = require('./viewbot-admin/viewbot-client');
const createRotationRouter = require('./viewbot-admin/rotation');
const createDebugRouter = require('./viewbot-admin/debug');
const createStreamingMethodRouter = require('./viewbot-admin/streaming-method');

function createViewBotAdminRouter(deps) {
    const router = express.Router();

    // Mounted at the SAME base path ('/') so every path/method/auth is
    // identical once the parent is mounted at the app root in index.js.
    // Order matters: viewbot-client (owns :botId/status) before rotation
    // (see MOUNT-ORDER NOTE above).
    router.use(createViewbotsRouter(deps));
    router.use(createTestStreamRouter(deps));
    router.use(createWebRTCRouter(deps));
    router.use(createViewBotClientRouter(deps));
    router.use(createRotationRouter(deps));
    router.use(createDebugRouter(deps));
    router.use(createStreamingMethodRouter(deps));

    return router;
}

module.exports = createViewBotAdminRouter;
