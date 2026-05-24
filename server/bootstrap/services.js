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
//   ── PR-I3 additions (bot cluster — uses post-construction setters) ──
//   chatBotService             ──  no constructor deps; setIoInstance(io) +
//                                  setMovieBotService(movieBotService) wired
//                                  in factory body after movieBotService is
//                                  constructed.
//   streamBotService           ──  database (ctor); setChatBotService and
//                                  setChatBotLLMService wired in factory
//                                  body once chatBotService exists.
//   movieBotService            ──  transcriptionService, chatBotService,
//                                  chatServiceWrapper (closure over database),
//                                  database. chatServiceWrapper is a literal
//                                  defined inline in the factory.
//
// ── Intentionally deferred (still inline in server/index.js) ─────────────
// viewbotService and the rest of the viewbot stack: their dep webs reach
// into module-level globals (notifiedStreamers Set, createViewBotProducer
// closure, mediasoup transports/producers map mutation, etc.) and would
// require a larger refactor to lift cleanly.
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

// PR-I3 additions
const ChatBotService = require('../services/ChatBotService');
const StreamBotService = require('../services/StreamBotService');
const MovieBotService = require('../services/MovieBotService');

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

  // ── PR-I3: bot cluster ──────────────────────────────────────────────────
  // ChatBotService and StreamBotService use post-construction setters that
  // wire in sibling services (and in the case of ChatBot, the io instance).
  // The inline-original sequence in server/index.js was:
  //   1. construct chatBotService + streamBotService
  //   2. construct movieBotService (consumes chatBotService + a chatService
  //      wrapper closure over database.allAsync)
  //   3. chatBotService.setIoInstance(io)
  //   4. chatBotService.setMovieBotService(movieBotService)
  //   5. streamBotService.setChatBotService(chatBotService)
  //   6. streamBotService.setChatBotLLMService(chatBotService.llmService)
  // We preserve that exact order here.
  const chatBotService = new ChatBotService();
  const streamBotService = new StreamBotService(database);

  // chatServiceWrapper: minimal adapter exposing getRecentMessages(limit)
  // backed by the SQLite `messages` table. Defined as a literal so the
  // closure is bound to `database` from this factory's scope.
  const chatServiceWrapper = {
    getRecentMessages: async (limit) => {
      try {
        const messages = await database.allAsync(
          `SELECT username, message, created_at
             FROM messages
            ORDER BY created_at DESC
            LIMIT ?`,
          [limit]
        );
        return messages.reverse(); // chronological order
      } catch (error) {
        console.error('Error getting recent messages:', error);
        return [];
      }
    },
  };

  const movieBotService = new MovieBotService(
    transcriptionService,
    chatBotService,
    chatServiceWrapper,
    database
  );

  // Post-construction wiring. Order matches the inline original.
  chatBotService.setIoInstance(io);
  chatBotService.setMovieBotService(movieBotService);
  streamBotService.setChatBotService(chatBotService);
  streamBotService.setChatBotLLMService(chatBotService.llmService);

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
    // PR-I3:
    chatBotService,
    streamBotService,
    movieBotService,
  };
};
