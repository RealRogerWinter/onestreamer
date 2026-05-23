// server/bootstrap/services.js
//
// Composition root for the "early-instantiation core" services that the bulk
// of OneStreamer's routes and socket handlers reach into. Previously these
// were instantiated inline in server/index.js (lines 439-478) interleaved
// with other setup code; centralizing them here gives extracted route/socket
// modules a single canonical bag to destructure from (via
// `req.app.locals.services`).
//
// ── Dependency graph (instantiation order matters; each line consumes only
//     things defined above it) ──────────────────────────────────────────────
//
//   streamService              ──  no deps
//   sessionService             ──  no deps
//   takeoverService            ──  redisClient, sessionService
//   testStreamService          ──  no deps
//   mediaStreamService         ──  no deps
//   (mediasoupService is built in server/index.js because it branches on
//    USE_WEBRTC_ADAPTER env flag and assigns to globals; it's PASSED IN here)
//   audioOptimizationService   ──  no deps
//   resourceMonitor            ──  no deps
//   accountService             ──  no deps
//   timeTrackingService        ──  no deps
//   itemService                ──  no deps
//   inventoryService           ──  itemService
//   shopService                ──  itemService, inventoryService, accountService, io
//   buffDebuffService          ──  io, streamService, timeTrackingService, sessionService
//   canvasFxService            ──  io, itemService, buffDebuffService
//   soundFxService             ──  no deps
//   plainTransportService      ──  mediasoupService
//
// ── Scope of this PR (PR-I) ──────────────────────────────────────────────
// Only the services above are migrated in this pilot. The later-instantiated
// services in server/index.js (StreamInterceptorService, VisualFxService,
// ChatBotService, RecordingService and friends, MovieBotService, GameService,
// ViewBot* services) stay inline for now. PR-I2 will absorb those once this
// factory pattern is proven against the existing extracted routers in
// server/routes/ (audio.js, buffs.js, tutorial.js, etc.).
//
// authService is also intentionally NOT here: it's instantiated early in
// server/index.js (~line 324) so passport strategies can register against
// it before the auth router mounts, and PR-G's extracted routes/tutorial.js
// reads it as a module-scope singleton.

const StreamService = require('../services/StreamService');
const SessionService = require('../services/SessionService');
const TakeoverService = require('../services/TakeoverService');
const TestStreamService = require('../services/TestStreamService');
const SimpleMediaStreamService = require('../services/SimpleMediaStreamService');
const AudioOptimizationService = require('../services/AudioOptimizationService');
const ResourceMonitor = require('../services/ResourceMonitor');
const AccountService = require('../services/AccountService');
const TimeTrackingService = require('../services/TimeTrackingService');
const ItemService = require('../services/ItemService');
const InventoryService = require('../services/InventoryService');
const ShopService = require('../services/ShopService');
const BuffDebuffService = require('../services/BuffDebuffService');
const CanvasFxService = require('../services/CanvasFxService');
const SoundFxService = require('../services/SoundFxService');
const MediasoupPlainTransportService = require('../services/MediasoupPlainTransportService');

/**
 * Build the early-core service bag.
 *
 * @param {object}  deps
 * @param {object}  deps.io            Socket.IO server instance
 * @param {object?} deps.redisClient   Connected redis client, or null if
 *                                     Redis isn't configured (TakeoverService
 *                                     handles the null case internally).
 * @param {object}  deps.database      SQLite database wrapper (not consumed
 *                                     by this batch but accepted for parity
 *                                     with PR-I2 services that will need it).
 * @param {object}  deps.env           process.env (or a subset thereof).
 * @param {object}  deps.mediasoupService  Pre-built mediasoup service
 *                                     (adapter or direct — server/index.js
 *                                     picks based on USE_WEBRTC_ADAPTER).
 * @returns {object} Service bag — keys match the variable names used
 *                   throughout server/index.js so destructuring is a 1:1
 *                   substitute for the previous inline `new XService(...)`
 *                   block.
 */
module.exports = function createServices({ io, redisClient, database, env, mediasoupService }) {
  // No-dep singletons first.
  const streamService = new StreamService();
  const sessionService = new SessionService();

  // Depends on redisClient + sessionService.
  const takeoverService = new TakeoverService(redisClient, sessionService);

  const testStreamService = new TestStreamService();
  const mediaStreamService = new SimpleMediaStreamService();

  const audioOptimizationService = new AudioOptimizationService();
  const resourceMonitor = new ResourceMonitor();
  const accountService = new AccountService();
  const timeTrackingService = new TimeTrackingService();

  // Item/inventory/shop chain.
  const itemService = new ItemService();
  const inventoryService = new InventoryService(itemService);
  const shopService = new ShopService(itemService, inventoryService, accountService, io);

  // Buff/visual/audio fx — buffDebuffService is a fan-in point.
  const buffDebuffService = new BuffDebuffService(io, streamService, timeTrackingService, sessionService);
  const canvasFxService = new CanvasFxService(io, itemService, buffDebuffService);
  const soundFxService = new SoundFxService();

  // Plain RTP transport sits on top of the pre-built mediasoup service.
  const plainTransportService = new MediasoupPlainTransportService(mediasoupService);

  return {
    streamService,
    sessionService,
    takeoverService,
    testStreamService,
    mediaStreamService,
    audioOptimizationService,
    resourceMonitor,
    accountService,
    timeTrackingService,
    itemService,
    inventoryService,
    shopService,
    buffDebuffService,
    canvasFxService,
    soundFxService,
    plainTransportService,
  };
};
