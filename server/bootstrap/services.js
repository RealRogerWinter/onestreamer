// server/bootstrap/services.js
//
// Composition root for OneStreamer's core services that the bulk of routes
// and socket handlers reach into. Previously these were instantiated inline
// in server/index.js interleaved with other setup code; centralizing them
// here gives extracted route/socket modules a single canonical bag to
// destructure from (via `req.app.locals.services`).
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
//   ── PR-I2 additions (recording/transcription/game/effects clusters) ──
//   streamInterceptorService   ──  mediasoupService, plainTransportService
//   visualFxService            ──  mediasoupService, buffDebuffService,
//                                  streamInterceptorService
//   recordingStorageService    ──  database
//   fileCompressionService     ──  database
//   recordingService           ──  database, mediasoupService,
//                                  recordingStorageService
//   clipStorageService         ──  no deps
//   clipProcessorService       ──  clipStorageService
//   continuousRecordingService ──  config bag (env-derived)
//   clipService                ──  database, clipStorageService,
//                                  clipProcessorService, continuousRecordingService
//   sessionChatCaptureService  ──  config bag (env-derived)
//   recordingUploadScheduler   ──  config bag
//   recordingCleanupScheduler  ──  no deps
//   transcriptionService       ──  database, mediasoupService, recordingService
//   gameService                ──  io, database
//   gameStreamService          ──  io, gameService, takeoverService
//
// ── Intentionally deferred (still inline in server/index.js) ─────────────
// ChatBotService, StreamBotService, MovieBotService, viewbotService and
// the rest of the viewbot stack: their dep webs reach into module-level
// globals, run async init wiring that the inline original was relying on,
// or are interleaved with viewbot-specific setup code (notifiedStreamers
// Set, createViewBotProducer closure, etc.). PR-I3 will address those.
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

// PR-I2 additions
const StreamInterceptorService = require('../services/StreamInterceptorService');
const VisualFxService = require('../services/VisualFxService');
const RecordingStorageService = require('../services/RecordingStorageService');
const FileCompressionService = require('../services/FileCompressionService');
const RecordingService = require('../services/RecordingService');
const ClipStorageService = require('../services/ClipStorageService');
const ClipProcessorService = require('../services/ClipProcessorService');
const ContinuousRecordingService = require('../services/ContinuousRecordingService');
const ClipService = require('../services/ClipService');
const SessionChatCaptureService = require('../services/SessionChatCaptureService');
const RecordingUploadScheduler = require('../services/RecordingUploadScheduler');
const RecordingCleanupScheduler = require('../services/RecordingCleanupScheduler');
const TranscriptionService = require('../services/TranscriptionService');
const { GameService, GameStreamService } = require('../services/game');

/**
 * Build the core service bag.
 *
 * @param {object}  deps
 * @param {object}  deps.io            Socket.IO server instance
 * @param {object?} deps.redisClient   Connected redis client, or null if
 *                                     Redis isn't configured (TakeoverService
 *                                     handles the null case internally).
 * @param {object}  deps.database      SQLite database wrapper.
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

  // ── PR-I2: stream-interception + visual fx chain ────────────────────────
  const streamInterceptorService = new StreamInterceptorService(mediasoupService, plainTransportService);
  const visualFxService = new VisualFxService(mediasoupService, buffDebuffService, streamInterceptorService);

  // ── PR-I2: recording cluster ────────────────────────────────────────────
  const recordingStorageService = new RecordingStorageService(database);
  const fileCompressionService = new FileCompressionService(database);
  const recordingService = new RecordingService(database, mediasoupService, recordingStorageService);

  // Clip cluster.
  const clipStorageService = new ClipStorageService();
  const clipProcessorService = new ClipProcessorService(clipStorageService);

  // Continuous recording (LiveKit Egress). Constructor reads env-derived
  // config and kicks off async init internally; behavior matches the
  // previous inline instantiation.
  const continuousRecordingService = new ContinuousRecordingService({
    livekitHost: (env && env.LIVEKIT_HOST) || 'http://127.0.0.1:7882',
    apiKey: env && env.LIVEKIT_API_KEY,
    apiSecret: env && env.LIVEKIT_API_SECRET,
    roomName: (env && env.LIVEKIT_ROOM_NAME) || 'onestreamer-main',
    outputDir: '/root/onestreamer/egress-recordings',
    retentionMinutes: 10, // keep last 10 minutes for clipping
  });

  const clipService = new ClipService(
    database,
    clipStorageService,
    clipProcessorService,
    continuousRecordingService
  );

  // Admin Recording Review services.
  const sessionChatCaptureService = new SessionChatCaptureService({
    chatServiceUrl: (env && env.CHAT_SERVICE_URL) || 'https://127.0.0.1:8444',
  });

  const recordingUploadScheduler = new RecordingUploadScheduler({
    localBufferHours: 2,
  });

  const recordingCleanupScheduler = new RecordingCleanupScheduler();

  // ── PR-I2: transcription (depends on recordingService) ──────────────────
  const transcriptionService = new TranscriptionService(database, mediasoupService, recordingService);

  // ── PR-I2: game cluster ─────────────────────────────────────────────────
  const gameService = new GameService(io, database);
  const gameStreamService = new GameStreamService(io, gameService, takeoverService);

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
    // PR-I2:
    streamInterceptorService,
    visualFxService,
    recordingStorageService,
    fileCompressionService,
    recordingService,
    clipStorageService,
    clipProcessorService,
    continuousRecordingService,
    clipService,
    sessionChatCaptureService,
    recordingUploadScheduler,
    recordingCleanupScheduler,
    transcriptionService,
    gameService,
    gameStreamService,
  };
};
