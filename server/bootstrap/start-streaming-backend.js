/**
 * Streaming-backend orchestration helper.
 *
 * Extracted from `server/index.js` `startServer()`: the block that builds the
 * URL-relay / random-rotation / moderation-arbiter orchestration around the
 * LiveKit backend (the sole WebRTC backend, ADR-0024).
 *
 * Behaviour-equivalent to the inline original: same construction order, same
 * setter sequence, same logs, same lifecycleManager schedule name
 * (`'random-rotation-autostart'`), same stoppables push, same globals +
 * app.locals writes.
 *
 * Side effects:
 *   - Constructs `ViewBotURLService`, `URLStreamHealthService`,
 *     `RandomStreamRotationService`, and (conditionally) `ModerationActionArbiter`
 *     + `WhitelistEnforcer`.
 *   - Sets `global.viewBotURLService`, `global.urlStreamHealthService`,
 *     `global.randomStreamRotationService`, `global.whitelistEnforcer` (if
 *     whitelist service is present), `global.viewBotLiveKitService`.
 *   - Sets `app.locals.moderationActionArbiter` (if moderation service is
 *     present) and `app.locals.whitelistEnforcer` (if whitelist service is
 *     present).
 *   - Mounts `/api/url-stream` and `/api/random-stream` on `app`.
 *   - Pushes `whitelistEnforcer` to `stoppables` when constructed.
 *   - Schedules `random-rotation-autostart` via `lifecycleManager`.
 *   - Wires `SimpleViewBotRotation.setURLViewBotService` +
 *     `setLiveKitService`, `viewBotURLService.setLiveKitService/setSocketIO/
 *     setStreamNotifier`, `viewBotLiveKitService.setURLViewBotService`, and
 *     starts the LiveKit streamer health-check.
 *
 * `deps`:
 *   - streamService           Required. Real-streamer protection.
 *   - SimpleViewBotRotation   Required. Module-scope singleton.
 *   - whitelistService        Optional (may be `null`). When present,
 *                             `WhitelistEnforcer` is constructed.
 *   - io                      Required. Socket.IO server.
 *   - streamNotifier          Required. Stream-event chokepoint.
 *   - moderationService       Optional (may be `null`). When present,
 *                             `ModerationActionArbiter` is constructed and
 *                             wired via `moderationService.setActionArbiter`.
 *   - sessionService          Required. Stale-session detection in the arbiter.
 *   - moderationNotifier      Required. Moderation-event surface.
 *   - database                Required. Threaded into `UserRepository`.
 *   - lifecycleManager        Required. Owns the deferred autostart.
 *   - app                     Required. Express app (route mounts +
 *                             `app.locals.*`).
 *   - stoppables              Required. Array mutated by push when
 *                             `WhitelistEnforcer` is constructed.
 *   - livekitService          Required. The LiveKit backend.
 *   - viewBotLiveKitService   Required. The LiveKit RTMP-ingress viewbot.
 */
const ViewBotURLService = require('../services/ViewBotURLService');
const URLStreamHealthService = require('../services/URLStreamHealthService');
const RandomStreamRotationService = require('../services/RandomStreamRotationService');
const WhitelistEnforcer = require('../services/WhitelistEnforcer');
const ModerationActionArbiter = require('../services/ModerationActionArbiter');
const UserRepository = require('../database/repository/UserRepository');
const urlStreamRoutesFactory = require('../routes/url-stream');
const randomStreamRoutesFactory = require('../routes/random-stream');
const { makeStreamControlAuth } = require('../middleware/streamControlAuth');

const logger = require('./logger').child({ svc: 'start-streaming-backend' });
module.exports = function startStreamingBackend({
  streamService,
  SimpleViewBotRotation,
  whitelistService,
  io,
  streamNotifier,
  moderationService,
  sessionService,
  moderationNotifier,
  database,
  lifecycleManager,
  app,
  stoppables,
  livekitService,
  viewBotLiveKitService,
  authenticateAdmin,
}) {
  // Initialize URL Stream ViewBot Service.
  const viewBotURLService = new ViewBotURLService();
  viewBotURLService.setStreamService(streamService);
  viewBotURLService.setViewBotRotation(SimpleViewBotRotation); // For stopping/resuming viewbots
  if (whitelistService) viewBotURLService.setWhitelistService(whitelistService);
  const urlStreamHealthService = new URLStreamHealthService(viewBotURLService);
  urlStreamHealthService.start();

  // Handle health service events for automatic recovery
  urlStreamHealthService.on('source-offline', async ({ urlId, sourceUrl }) => {
    logger.debug(`🏥 HEALTH: Source offline detected for ${urlId}, triggering reconnect...`);
    const stream = viewBotURLService.activeStreams.get(urlId);
    if (stream) {
      viewBotURLService._handleStreamError(urlId, 'health-check', new Error('Source stream went offline'));
    }
  });

  urlStreamHealthService.on('stream-stale', async ({ urlId }) => {
    logger.debug(`🏥 HEALTH: Stale stream detected for ${urlId}, triggering reconnect...`);
    const stream = viewBotURLService.activeStreams.get(urlId);
    if (stream) {
      viewBotURLService._handleStreamError(urlId, 'health-check', new Error('Stream became stale - no progress'));
    }
  });

  logger.debug('✅ URL STREAM: ViewBotURLService initialized');

  // Register URL ViewBot service with rotation for protection
  SimpleViewBotRotation.setURLViewBotService(viewBotURLService);
  logger.debug('✅ URL STREAM: Registered with SimpleViewBotRotation for URL stream protection');

  // Store globally for API routes
  global.viewBotURLService = viewBotURLService;
  global.urlStreamHealthService = urlStreamHealthService;

  // Auth gate for the stream-control + URL-ingestion routes (historically
  // unauthenticated). Permissive until ENFORCE_STREAM_CONTROL_AUTH=true; see
  // middleware/streamControlAuth.js for the rollout rationale.
  const streamControlAuth = makeStreamControlAuth(authenticateAdmin, logger);

  // Initialize URL Stream API routes
  app.use('/api/url-stream', streamControlAuth, urlStreamRoutesFactory(viewBotURLService, urlStreamHealthService));
  logger.debug('✅ URL STREAM: API routes initialized at /api/url-stream');

  // Initialize Random Stream Rotation Service.
  const randomStreamRotationService = new RandomStreamRotationService();
  randomStreamRotationService.setViewBotURLService(viewBotURLService);
  randomStreamRotationService.setViewBotRotation(SimpleViewBotRotation);
  randomStreamRotationService.setSocketIO(io);
  randomStreamRotationService.setStreamNotifier(streamNotifier);
  if (whitelistService) randomStreamRotationService.setWhitelistService(whitelistService);
  global.randomStreamRotationService = randomStreamRotationService;
  logger.debug('✅ RANDOM STREAM: RandomStreamRotationService initialized');

  // PR-M3: wire the AI moderation ActionArbiter now that the rotation
  // service is built. The arbiter is what turns a 2-of-2 HIGH agreement
  // verdict into an actual ban/skip + rotation. Behind the
  // AI_MODERATION_ENFORCE env flag (default false in M3, flipped true in
  // M6) — when false, the arbiter still runs the stale-session check
  // but downgrades all verdicts to admin_review.
  if (moderationService) {
    const userRepositoryInstance = new UserRepository(database);
    const actionArbiter = new ModerationActionArbiter({
      userRepository: userRepositoryInstance,
      sessionService,
      streamService,
      randomStreamRotationService,
      whitelistService,
      // Audit M3: lets _actUrlRelay resolve the offending relay's
      // platform/login from the live stream when the event carries none
      // (transcript/vision events never populate external_*).
      viewBotURLService,
      moderationNotifier,
      // Initial value (paranoid fallback). The authoritative source is
      // the DB-backed `moderation_global_config.enforce` row, which
      // `moderationService.setActionArbiter()` immediately syncs into
      // the arbiter via its `setEnforce()` method. The env flag is
      // honored ONCE at first install (when the DB row is still the
      // 'seed' default) so an upgrading operator's env=true persists.
      enforce: process.env.AI_MODERATION_ENFORCE === 'true',
    });
    moderationService.setActionArbiter(actionArbiter);
    app.locals.moderationActionArbiter = actionArbiter;
  }

  // PR-W4: drift enforcer. Polls the active relay every drift_check_seconds
  // and stops it if the streamer drifted out of policy mid-broadcast.
  if (whitelistService) {
    const whitelistEnforcer = new WhitelistEnforcer({
      viewBotURLService,
      whitelistService,
      twitchService: randomStreamRotationService.twitchService,
      kickService: randomStreamRotationService.kickService,
      io,
    });
    whitelistEnforcer.start();
    app.locals.whitelistEnforcer = whitelistEnforcer;
    global.whitelistEnforcer = whitelistEnforcer;
    // Register with shutdown loop so SIGTERM stops the interval before
    // viewBotURLService is drained — without this an in-flight tick can
    // call stopURLStream against a service that's already mid-teardown.
    stoppables.push(whitelistEnforcer);
  }

  // Initialize Random Stream API routes
  app.use('/api/random-stream', streamControlAuth, randomStreamRoutesFactory(randomStreamRotationService));
  logger.debug('✅ RANDOM STREAM: API routes initialized at /api/random-stream');

  // Auto-start random rotation if it was enabled before restart.
  // PR 4.2: routed through LifecycleManager so SIGTERM during the 5 s
  // grace window cancels the autostart attempt against a torn-down
  // rotation service.
  lifecycleManager.schedule('random-rotation-autostart', async () => {
    try {
      await randomStreamRotationService.autoStartIfEnabled();
    } catch (error) {
      logger.error('❌ RANDOM STREAM: Auto-start failed:', error.message);
    }
  }, 5000);

  // ── LiveKit wires (LiveKit is the sole WebRTC backend, ADR-0024) ──────────
  // Rotation + LiveKit-service cross-wires.
  // Register with rotation systems so they can use RTMP viewbots.
  SimpleViewBotRotation.setLiveKitService(viewBotLiveKitService);
  logger.debug('✅ VIEWBOT: Registered LiveKit service with SimpleViewBotRotation');

  // ViewBotURLService relays via livekit-ingress (RTMP).
  viewBotURLService.setLiveKitService(viewBotLiveKitService);

  // CRITICAL: Register URL ViewBot service with LiveKit ViewBot service for protection
  // This prevents viewbot creation when URL stream is active
  viewBotLiveKitService.setURLViewBotService(viewBotURLService);
  logger.debug('✅ URL STREAM: Registered with ViewBotLiveKitService for URL stream protection');

  // Wire the URL-relay socket-emit paths. `ViewBotURLService._handleStreamEnd`
  // and `stopURLStream` check `if (this.io)` / `if (this.streamNotifier)`, so
  // these setters are what activate the viewer-notify emits when a URL relay
  // starts/ends.
  viewBotURLService.setSocketIO(io); // For notifying viewers when URL stream starts
  viewBotURLService.setStreamNotifier(streamNotifier);

  // LiveKit-process lifecycle.
  // Store for later registration with ViewBotRotationService
  global.viewBotLiveKitService = viewBotLiveKitService;

  // Start LiveKit streamer health check to detect stale streamers (WebRTC dropped but socket alive).
  // The interval is cleared by livekitService.stop() (verified via
  // LiveKitService.stopStreamerHealthCheck on the stoppables-shutdown path).
  livekitService.startStreamerHealthCheck(streamService, io, 10000); // Check every 10 seconds
  logger.debug('✅ LIVEKIT: Started streamer health check for stale connection detection');
};
