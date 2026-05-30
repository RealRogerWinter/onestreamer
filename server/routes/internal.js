// server/routes/internal.js
//
// /api/internal/* router. These endpoints are the HTTP surface that the
// chat microservice (and a few authenticated client features like gift,
// gamble, slots, admin point grants, leaderboard) call back into the main
// server with. Extracted from server/index.js in PR-G2.
//
// This parent router was decomposed into cohesive sub-route modules under
// server/routes/internal/. Each sub-module is an express.Router() factory and
// is mounted here at the SAME base path ('/') so that — once this router is
// itself mounted at '/api/internal' in server/index.js — every path, method,
// middleware/auth order, and handler body is byte-for-byte identical to the
// prior monolithic router. Sub-modules:
//   - callbacks.js — chat-service callbacks, viewbot test, public reads
//                    (leaderboard / uptime / user-stats / admin-status checks).
//   - points.js    — point economy + game mechanics (award/transfer points,
//                    gamble, slots, chat-bonus, bonus-status, admin grant/revoke).
//   - gift.js      — item gift surface (gift-item, giftable-items).
//
// Service access (unchanged from the monolith):
//   - Early-core services come from `req.app.locals.services` (the PR-I
//     factory bag): sessionService, timeTrackingService, accountService,
//     itemService, inventoryService, gameMechanicsService.
//   - viewbotService is built later in server/index.js (it depends on the
//     mediasoup adapter being selected first); it's read off
//     `req.app.locals.viewbotService` at request time so it can be null
//     before the viewbot subsystem comes online.
//   - viewbotUsernameCache / viewbotSocketIds and getStreamerDisplayName
//     (helper closure that consults sessionService + authService) are
//     exposed on app.locals from server/index.js once they exist.
//   - userBonusCooldowns is a Map of userId -> last-claim epoch ms, hoisted
//     into app.locals so /claim-chat-bonus and /bonus-status/:userId (via
//     gameMechanicsService) share it.
//
// AuthService is module-scope (stateless wrt session-shared state — same
// pattern as routes/tutorial.js) and is injected into each sub-module so a
// single instance verifies all inline Bearer tokens.

const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'internal' });

const router = express.Router();

const AuthService = require('../services/AuthService');

const authService = new AuthService();

const createCallbacksRouter = require('./internal/callbacks');
const createPointsRouter = require('./internal/points');
const createGiftRouter = require('./internal/gift');

router.use(createCallbacksRouter({ logger, authService }));
router.use(createPointsRouter({ logger, authService }));
router.use(createGiftRouter({ logger, authService }));

module.exports = router;
