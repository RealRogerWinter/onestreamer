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
//   (webrtcService is built in server/index.js because it branches on
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
//
//   ── PR-I2 additions (recording/transcription/game/effects clusters) ──
//   clipStorageService         ──  no deps
//   clipProcessorService       ──  clipStorageService
//   continuousRecordingService ──  config bag (env-derived)
//   clipService                ──  database, clipStorageService,
//                                  clipProcessorService, continuousRecordingService
//   sessionChatCaptureService  ──  config bag (env-derived)
//   recordingUploadScheduler   ──  config bag
//   recordingCleanupScheduler  ──  no deps
//   transcriptionService       ──  database, webrtcService
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
// ── PR-I4: late ViewBot stack (separate export, not part of createServices) ──
// The named ViewBot services (ViewbotService, ViewBotLiveKitService) are
// constructed by the
// dedicated `createViewBotServices` factory exported alongside the main
// one. They live in their own function (rather than being folded into
// createServices) because:
//   (1) they depend on `webrtcService.initialize()` having completed
//       successfully — that only happens inside startServer()'s try block,
//       well after the synchronous service bag is built;
//   (2) they branch on `livekitService` which is derived from
//       `global.webrtcAdapter._backend` at runtime (USE_WEBRTC_ADAPTER +
//       WEBRTC_BACKEND=livekit), and isn't part of the main services bag;
//   (3) ViewBotLiveKitService requires `await initialize()` before any of
//       its setters fire.
//
// The auxiliary orchestration that surrounded those constructors — URL
// stream services (ViewBotURLService + URLStreamHealthService + their
// event handlers), RandomStreamRotationService, SimpleViewBotRotation
// setter wiring, ViewBotManager / UnifiedViewBotRotation, PortMonitorService,
// route mounting (/api/url-stream, /api/random-stream), and delayed
// auto-start setTimeouts — STAYS INLINE in server/index.js. That code is
// orchestration (event handlers, route mounting, scheduling) rather than
// service construction, and lifting it would obscure the conditional shape
// without simplifying anything. See ADR-0002 (LiveKit dormant) and the
// PR-I3 deferral note for context.
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
const GameMechanicsService = require('../services/GameMechanicsService');
const BuffDebuffService = require('../services/BuffDebuffService');
const CanvasFxService = require('../services/CanvasFxService');
const SoundFxService = require('../services/SoundFxService');
const StreamNotifier = require('../services/StreamNotifier');
const ViewerCountNotifier = require('../services/ViewerCountNotifier');
const BuffNotifier = require('../services/BuffNotifier');
const ModerationNotifier = require('../services/ModerationNotifier');

const logger = require('./logger').child({ svc: 'services' });
// PR-I2 additions
const ClipStorageService = require('../services/ClipStorageService');
const ClipProcessorService = require('../services/ClipProcessorService');
const ContinuousRecordingService = require('../services/ContinuousRecordingService');
const EgressFrameCaptureService = require('../services/EgressFrameCaptureService');
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
// VisionBot — sibling of MovieBot. Frame source is egressFrameCaptureService;
// trigger is BotEventBus 'moviebot-transcription-complete' (when MovieBot is
// also enabled) and/or its own scheduler.
const VisionBotService = require('../services/VisionBotService');
// PR 1.3: shared event bus that decouples ChatBot from MovieBot.
const BotEventBus = require('../services/BotEventBus');

// PR 4.2: deferred-work registry.
const LifecycleManager = require('../services/LifecycleManager');

// PR 8.3 (Phase 8): ProcessManager singleton — registry for ViewBot
// ffmpeg / chrome child PIDs. Exposes a stoppable.stop() that reaps
// any tracked PIDs not already cleaned up by their owning service's
// stop() path. See ADR-0011 (lifecycle contract) and the runbook
// `viewbot-fleet-misbehaving.md` for the orphan-process hazard this
// closes.
const processManager = require('../services/ProcessManager');

// PR-I4: late ViewBot stack — see createViewBotServices below.
const ViewbotService = require('../services/ViewbotService');
const ViewBotLiveKitService = require('../services/ViewBotLiveKitService');

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
 * @param {object}  deps.webrtcService  Pre-built mediasoup service
 *                                     (adapter or direct — server/index.js
 *                                     picks based on USE_WEBRTC_ADAPTER).
 * @param {Map}     deps.userBonusCooldowns  Shared Map<userId, lastClaimEpochMs>
 *                                     for /claim-chat-bonus + /bonus-status.
 *                                     Created in server/index.js and exposed
 *                                     on app.locals so the read-only route
 *                                     can read the same Map this service
 *                                     mutates. Passed by reference (same
 *                                     pattern as `lastEmittedStreamReady`).
 * @returns {object} Service bag — keys match the variable names used
 *                   throughout server/index.js so destructuring is a 1:1
 *                   substitute for the previous inline `new XService(...)`
 *                   block.
 */
function createServices({ io, redisClient, database, env, webrtcService, userBonusCooldowns }) {
  // No-dep singletons first.
  const streamService = new StreamService();
  const sessionService = new SessionService();

  // PR 4.2: registry for one-shot `setTimeout`-style deferred work. Closes
  // the hazard in `docs/architecture/background-work.md` where the 7 prior
  // `setTimeout` callsites in `server/index.js` (and 2 inside
  // `server/sockets/DisconnectHandler.js`) had no per-handle reference, so
  // SIGTERM during a delay window fired the callback against torn-down
  // state. Constructed early — no deps — and threaded through every
  // callsite that previously called `setTimeout` directly. Added to
  // `stoppables` so the shutdown loop drains pending work via `stop()`.
  const lifecycleManager = new LifecycleManager();

  // PR 3.1: single emit chokepoint for `stream-ended`. Constructed early so
  // every downstream service that previously called io.emit('stream-ended', …)
  // directly can be threaded with this notifier instead.
  const streamNotifier = new StreamNotifier(io);

  // PR 3.2: single emit chokepoint for `viewer-count-update`. Owns both the
  // emit and the count derivation (from sessionService.getUniqueViewerCount).
  // The 13 callsites this replaces all literally called the same helper +
  // emitted the same payload; the chokepoint removes the duplication and
  // closes off the historical foot-gun of using streamService.getViewerCount()
  // (raw socket count, multi-tab counts twice) by accident.
  const viewerCountNotifier = new ViewerCountNotifier(io, sessionService);

  // PR 3.3: single emit chokepoint for the buff/inventory event cluster —
  // `streamer-buffs-update`, `inventory-updated`, `buff-error`. Three methods
  // because the cluster has three target scopes: broadcast (or per-socket
  // response for the query variant), per-socketId targeted (inventory),
  // per-calling-socket (errors). Constructed BEFORE buffDebuffService so
  // the latter can take it via its options bag.
  const buffNotifier = new BuffNotifier(io);

  // PR-M1 (ADR-0013): single chokepoint for AI-moderation socket events
  // (`moderation-event-created`, `moderation-action-taken`,
  // `moderation-streamer-banner`, `moderation-bot-output-dropped`). Admin-
  // facing emits go to the `'admin'` room; the streamer-banner emit targets
  // the banned streamer's socket by id, set by ModerationActionArbiter
  // (PR-M3). Constructed here for symmetry with the other three notifiers;
  // ModerationService itself is constructed inline in server/index.js
  // because its initialize() is async (verifies seed integrity, applies
  // schema, upserts terms, subscribes to transcription-chunk events).
  const moderationNotifier = new ModerationNotifier(io);

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

  // PR 16.1: game-mechanic primitives for the chat-economy money-flow
  // endpoints (/gamble, /slots, /claim-chat-bonus, /transfer-points,
  // /bonus-status). Stub-only in PR 16.1; method bodies land in PR 16.2.
  // userBonusCooldowns is the Map shared by reference with
  // app.locals.userBonusCooldowns (created in server/index.js).
  const gameMechanicsService = new GameMechanicsService({
    accountService,
    userBonusCooldowns,
  });

  // Buff/visual/audio fx — buffDebuffService is a fan-in point.
  // PR 3.3: buffNotifier threaded via the options bag (5th positional arg)
  // so the 4 internal `this.io.emit('streamer-buffs-update', …)` callsites
  // can be routed through the chokepoint. The 5th-arg shape is preserved
  // (existing slot for `{ itemRepository }`); this PR just adds another key.
  const buffDebuffService = new BuffDebuffService(io, streamService, timeTrackingService, sessionService, { buffNotifier });
  const canvasFxService = new CanvasFxService(io, itemService, buffDebuffService);
  const soundFxService = new SoundFxService();

  // ── PR-I2: recording cluster ────────────────────────────────────────────
  // The MediaSoup-era RecordingService / RecordingStorageService /
  // FileCompressionService cluster was retired with ADR-0024 (LiveKit-only).
  // Live recording is the LiveKit egress path (continuousRecordingService +
  // the recordingUpload/Cleanup schedulers over the recording_sessions table).

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

  // VisionBot frame source. Reads HLS segments produced by the egress
  // recorder and extracts a single JPEG aligned to a transcription window.
  // No-op when egress isn't running. Construction order: after
  // continuousRecordingService (its dep), before visionBotService (lands
  // in a follow-up PR).
  const egressFrameCaptureService = new EgressFrameCaptureService({
    continuousRecordingService,
  });

  // Admin Recording Review services.
  const sessionChatCaptureService = new SessionChatCaptureService({
    chatServiceUrl: (env && env.CHAT_SERVICE_URL) || 'https://127.0.0.1:8444',
  });

  const recordingUploadScheduler = new RecordingUploadScheduler({
    localBufferHours: 2,
  });

  const recordingCleanupScheduler = new RecordingCleanupScheduler();

  // ── PR-I2: transcription ─────────────────────────────────────────────────
  // The legacy recordingService 3rd arg was never used by TranscriptionService
  // (it pulls audio from the egress path); dropped with the RecordingService
  // retirement (ADR-0024).
  const transcriptionService = new TranscriptionService(database, webrtcService);

  // ── PR-I2: game cluster ─────────────────────────────────────────────────
  const gameService = new GameService(io, database);
  // PR 2.5b: streamService threaded as 4th arg so GameStreamService can
  // bump streamGeneration on its custom-payload emits (the start/stop
  // emits don't go through streamService.getStreamStatus, so they need
  // an explicit bump to stay monotonic with the rest of the system).
  const gameStreamService = new GameStreamService(io, gameService, takeoverService, streamService);

  // ── PR-I3 / PR-1.3: bot cluster ─────────────────────────────────────────
  // PR 1.3 introduced BotEventBus to break the circular ChatBot ↔ MovieBot
  // dependency. Previously chatBotService.setMovieBotService(movieBotService)
  // wired a direct reference *after* MovieBotService was constructed; now
  // both services receive the same shared bus at construction and the only
  // cross-service call (chat-message broadcast) goes through it.
  //
  // The remaining ChatBotService and StreamBotService setters (setIoInstance,
  // setChatBotService, setChatBotLLMService) are still post-construction
  // because they wire in things constructed in this factory body, not
  // because of a circular dep. Sequence:
  //   1. construct botEventBus (no deps)
  //   2. construct chatBotService ({ botEventBus }) + streamBotService(database)
  //   3. construct movieBotService(..., botEventBus); subscribes to bus in ctor
  //   4. chatBotService.setIoInstance(io)
  //   5. streamBotService.setChatBotService(chatBotService)
  //   6. streamBotService.setChatBotLLMService(chatBotService.llmService)
  const botEventBus = new BotEventBus();

  // movieBotService is forward-declared (let, not const) so the closure below
  // can capture it by reference. ChatBotService calls
  // getMoviePromptTemplate() at request time (createTemporaryBot) — by then
  // movieBotService is constructed and has loaded config from DB. This
  // preserves the admin-editable prompt template feature without
  // re-introducing a construction-time circular dep.
  let movieBotService;
  const chatBotService = new ChatBotService({
    botEventBus,
    getMoviePromptTemplate: () => movieBotService?.config?.moviePromptTemplate,
  });
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
        logger.error('Error getting recent messages:', error);
        return [];
      }
    },
  };

  movieBotService = new MovieBotService(
    transcriptionService,
    chatBotService,
    chatServiceWrapper,
    database,
    botEventBus
  );

  // VisionBot subscribes to MovieBot's bus event ('moviebot-transcription-
  // complete') AND runs its own scheduler — dedup catches doubles. Must
  // be constructed AFTER movieBotService so the listener attaches before
  // the first scheduled MovieBot cycle fires.
  const visionBotService = new VisionBotService({
    transcriptionService,
    chatBotService,
    chatService: chatServiceWrapper,
    database,
    botEventBus,
    frameCaptureService: egressFrameCaptureService,
    streamService,
    continuousRecordingService,
  });

  // Post-construction wiring. setMovieBotService was removed in PR 1.3
  // (replaced by the bus); the rest remain because they pass forward-
  // declared instances, not because of a cycle.
  chatBotService.setIoInstance(io);
  streamBotService.setChatBotService(chatBotService);
  streamBotService.setChatBotLLMService(chatBotService.llmService);

  const services = {
    streamService,
    sessionService,
    streamNotifier,
    viewerCountNotifier,
    buffNotifier,
    moderationNotifier,
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
    gameMechanicsService,
    buffDebuffService,
    canvasFxService,
    soundFxService,
    // PR-I2:
    clipStorageService,
    clipProcessorService,
    continuousRecordingService,
    egressFrameCaptureService,
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
    // VisionBot phase:
    visionBotService,
    // PR 1.3:
    botEventBus,
    // PR 4.2:
    lifecycleManager,
  };

  // PR 1.2: stoppables in construction order. server/index.js's SIGINT
  // handler iterates this in reverse with a per-stop timeout. Only includes
  // services that actually expose stop() today — pure-data services
  // (StreamService, SessionService, etc.) don't need one, and services
  // with leaked anonymous intervals (chatBotService,
  // movieBotService, transcriptionService) are deferred to later PRs
  // that store their handles before adding stop(). PR 1.3 covers
  // ChatBot/MovieBot via the BotEventBus; Phase 2 covers VisualFx /
  // Transcription. Including them with svc.stop?.() no-op fallback would
  // log inflated "Stopping N services" counts and mask the gap.
  const stoppables = [
    audioOptimizationService,
    resourceMonitor,
    timeTrackingService,
    buffDebuffService,
    canvasFxService,
    recordingUploadScheduler,
    recordingCleanupScheduler,
    continuousRecordingService,
    egressFrameCaptureService,
    visionBotService,
    streamBotService,
    // PR 8.3 (Phase 8): ProcessManager runs LATE in the shutdown order
    // (early in the array → late in reverse-iteration) so the per-bot
    // stop() paths on ViewBot services — which already call
    // `processManager.killBotProcesses(botId)` and `onBotStopped` — have
    // a chance to clean their tracked PIDs FIRST. By the time the reaper
    // runs, the registry is near-empty in the happy path; the reaper
    // exists to catch the case where a service died unexpectedly with a
    // registered PID still in the map.
    processManager,
    // PR 4.2: drained last (reverse-iterated first by the shutdown loop) so
    // any in-flight deferred work the other services have scheduled is
    // cancelled BEFORE those services tear down their own state.
    // INVARIANT (asserted in services.test.js): lifecycleManager MUST remain
    // the last entry in this array. If you add a new stoppable, add it
    // ABOVE this line, not below — a new stoppable below lifecycleManager
    // would tear down BEFORE its deferred work is cancelled, which is the
    // exact failure mode PR 4.2 was closing.
    lifecycleManager,
  ];

  return { services, stoppables };
}

/**
 * Build the late ViewBot service stack (PR-I4).
 *
 * Called from server/index.js inside startServer() AFTER
 * webrtcService.initialize() has resolved, because every service in this
 * stack reaches into the live mediasoup worker (transports/producers maps)
 * or — on the LiveKit branch — depends on the adapter's resolved backend.
 *
 * Behavior:
 *   - viewbotService is ALWAYS constructed. Under LiveKit it provides only the
 *     stateless `isViewbotStream` predicate (its creation/streaming half and
 *     the ViewBotWebRTCService backend were removed — see ViewbotService.js).
 *   - viewBotLiveKitService is constructed ONLY when livekitService IS
 *     present (the production path), then awaited via initialize(), then
 *     handed a streamService reference for real-streamer protection.
 *
 * NOT handled here (kept inline in server/index.js because each item is
 * orchestration rather than service construction — see the deferred-list
 * note above): ViewBotURLService, URLStreamHealthService, the URL stream
 * /random stream route mounts, SimpleViewBotRotation setter wiring,
 * ViewBotManager / UnifiedViewBotRotation, PortMonitorService,
 * ViewBotRotationService, and the various setTimeout-driven autostarts.
 *
 * @param {object}  deps
 * @param {object}  deps.webrtcService  Already-initialized mediasoup
 *                                         service (or adapter forwarding to
 *                                         one). Required.
 * @param {object?} deps.livekitService    LiveKit backend instance (the
 *                                         production path; null only in a
 *                                         no-LiveKit fallback).
 * @param {object}  deps.streamService     For ViewBotLiveKitService's real-
 *                                         streamer-protection wiring.
 * @returns {Promise<object>} ViewBot service bag:
 *                            {
 *                              viewbotService,
 *                              viewBotLiveKitService, // null without LiveKit
 *                            }
 */
async function createViewBotServices({ webrtcService, livekitService, streamService }) {
  // ViewbotService is now stateless (only isViewbotStream); the constructor
  // signature is retained for call-site compatibility but the args are unused.
  const viewbotService = new ViewbotService(webrtcService, livekitService);

  let viewBotLiveKitService = null;

  if (livekitService) {
    // LiveKit branch (production) — needs RTMP-ingress viewbot.
    viewBotLiveKitService = new ViewBotLiveKitService(livekitService);
    await viewBotLiveKitService.initialize();
    // Real-streamer protection. The inline original also called this; the
    // ordering (after initialize, before any setter from SimpleViewBotRotation)
    // is preserved.
    viewBotLiveKitService.setStreamService(streamService);
  }

  const services = {
    viewbotService,
    viewBotLiveKitService,
  };

  // The ViewBot bag owns no background work that needs draining at shutdown:
  // viewbotService is stateless, and viewBotLiveKitService has no graceful
  // stop() (its only lifecycle method is initialize()).
  const stoppables = [];

  return { services, stoppables };
}

module.exports = createServices;
module.exports.createViewBotServices = createViewBotServices;
