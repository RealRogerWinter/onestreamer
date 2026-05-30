/**
 * Admin Recording Review API Routes (parent)
 *
 * Thin parent router that mounts the cohesive sub-route modules under
 * ./admin-recordings/. Behavior, paths, methods, and the authenticateAdmin
 * gate are identical to the previous single-file implementation — the
 * handlers were moved verbatim into the sub-modules, which share singletons
 * and runtime services through ./admin-recordings/context.
 *
 * Sub-route groups:
 * - recordings.js — session list/detail, video URL, local HLS stream,
 *   per-session chat, delete, force-upload, raw segment serving
 * - clips.js      — clip creation from a recording session
 * - settings.js   — review-system settings (GET/PUT) + overall status
 * - continuous.js — timeline, unified playback, master-stream, chat-stream
 *
 * Mounted by server/index.js at base path `/admin/review`; setServices() is
 * still called there to inject the upload/cleanup/chat-capture/clip services.
 */

const express = require('express');

const context = require('./admin-recordings/context');
const recordingsRouter = require('./admin-recordings/recordings');
const clipsRouter = require('./admin-recordings/clips');
const settingsRouter = require('./admin-recordings/settings');
const continuousRouter = require('./admin-recordings/continuous');

const router = express.Router();

router.use(recordingsRouter);
router.use(clipsRouter);
router.use(settingsRouter);
router.use(continuousRouter);

/**
 * Set service references (called from server/index.js)
 */
router.setServices = function(services) {
    context.setServices(services);
};

module.exports = router;
