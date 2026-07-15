// Tests for the service composition root introduced in PR-I and expanded
// in PR-I2.
//
// We use jest.mock(..., factory) to replace each service module with a tiny
// stub class that records the constructor args on the instance (as `_args`).
// That gives us:
//   - cheap isolation from the real services' database/io side effects
//     (BuffDebuffService.initialize(), ContinuousRecordingService.initialize(), etc.)
//   - a way to assert exactly which deps got threaded into each `new X(...)`.
//
// Coverage:
//   1. Factory returns all expected keys (none missing, none extra).
//   2. Each returned value is an instance of the (mocked) class for that key.
//   3. Dep-graph identity checks for representative services:
//        takeoverService, inventoryService, shopService, buffDebuffService,
//        canvasFxService,
//        clipService,
//        transcriptionService, gameStreamService.
//   4. Factory does NOT throw when `io` is missing but forwards undefined —
//      documents current behavior so a future tightening (required-dep
//      validation) gets a deliberate test update.

// ── Mock every service module the factory loads ──────────────────────────
// Each mock is a constructor that stashes its args on `this._args`. We
// inline the class body inside each factory callback because Jest forbids
// out-of-scope references in `jest.mock` factories (only names prefixed
// with `mock` are allowed). Each mock also tags the instance with the
// service name to make instanceof failures obvious.

jest.mock('../../services/StreamService', () => class { constructor(...args) { this._args = args; this._stubName = 'StreamService'; } });
jest.mock('../../services/SessionService', () => class { constructor(...args) { this._args = args; this._stubName = 'SessionService'; } });
jest.mock('../../services/TakeoverService', () => class { constructor(...args) { this._args = args; this._stubName = 'TakeoverService'; } });
jest.mock('../../services/TestStreamService', () => class { constructor(...args) { this._args = args; this._stubName = 'TestStreamService'; } });
jest.mock('../../services/SimpleMediaStreamService', () => class { constructor(...args) { this._args = args; this._stubName = 'SimpleMediaStreamService'; } });
jest.mock('../../services/AudioOptimizationService', () => class { constructor(...args) { this._args = args; this._stubName = 'AudioOptimizationService'; } });
jest.mock('../../services/ResourceMonitor', () => class { constructor(...args) { this._args = args; this._stubName = 'ResourceMonitor'; } });
jest.mock('../../services/AccountService', () => class { constructor(...args) { this._args = args; this._stubName = 'AccountService'; } });
jest.mock('../../services/TimeTrackingService', () => class { constructor(...args) { this._args = args; this._stubName = 'TimeTrackingService'; } });
jest.mock('../../services/ItemService', () => class { constructor(...args) { this._args = args; this._stubName = 'ItemService'; } });
jest.mock('../../services/InventoryService', () => class { constructor(...args) { this._args = args; this._stubName = 'InventoryService'; } });
jest.mock('../../services/ShopService', () => class { constructor(...args) { this._args = args; this._stubName = 'ShopService'; } });
jest.mock('../../services/GameMechanicsService', () => class { constructor(...args) { this._args = args; this._stubName = 'GameMechanicsService'; } });
jest.mock('../../services/BuffDebuffService', () => class { constructor(...args) { this._args = args; this._stubName = 'BuffDebuffService'; } });
jest.mock('../../services/CanvasFxService', () => class { constructor(...args) { this._args = args; this._stubName = 'CanvasFxService'; } });
jest.mock('../../services/SoundFxService', () => class { constructor(...args) { this._args = args; this._stubName = 'SoundFxService'; } });
jest.mock('../../services/DiscordBotService', () => class { constructor(...args) { this._args = args; this._stubName = 'DiscordBotService'; } async stop() {} });
jest.mock('../../services/StreamNotifier', () => class { constructor(...args) { this._args = args; this._stubName = 'StreamNotifier'; } });
jest.mock('../../services/ViewerCountNotifier', () => class { constructor(...args) { this._args = args; this._stubName = 'ViewerCountNotifier'; } });
jest.mock('../../services/BuffNotifier', () => class { constructor(...args) { this._args = args; this._stubName = 'BuffNotifier'; } });
jest.mock('../../services/ModerationNotifier', () => class { constructor(...args) { this._args = args; this._stubName = 'ModerationNotifier'; } });

// PR-I2 additions
jest.mock('../../services/ClipStorageService', () => class { constructor(...args) { this._args = args; this._stubName = 'ClipStorageService'; } });
jest.mock('../../services/ClipProcessorService', () => class { constructor(...args) { this._args = args; this._stubName = 'ClipProcessorService'; } });
jest.mock('../../services/ContinuousRecordingService', () => class { constructor(...args) { this._args = args; this._stubName = 'ContinuousRecordingService'; } });
jest.mock('../../services/EgressFrameCaptureService', () => class { constructor(...args) { this._args = args; this._stubName = 'EgressFrameCaptureService'; } });
jest.mock('../../services/VisionBotService', () => class { constructor(...args) { this._args = args; this._stubName = 'VisionBotService'; } });
jest.mock('../../services/ClipService', () => class { constructor(...args) { this._args = args; this._stubName = 'ClipService'; } });
jest.mock('../../services/SessionChatCaptureService', () => class { constructor(...args) { this._args = args; this._stubName = 'SessionChatCaptureService'; } });
jest.mock('../../services/RecordingUploadScheduler', () => class { constructor(...args) { this._args = args; this._stubName = 'RecordingUploadScheduler'; } });
jest.mock('../../services/RecordingCleanupScheduler', () => class { constructor(...args) { this._args = args; this._stubName = 'RecordingCleanupScheduler'; } });
jest.mock('../../services/TranscriptionService', () => class { constructor(...args) { this._args = args; this._stubName = 'TranscriptionService'; } });
jest.mock('../../services/game', () => ({
  GameService: class { constructor(...args) { this._args = args; this._stubName = 'GameService'; } },
  GameStreamService: class { constructor(...args) { this._args = args; this._stubName = 'GameStreamService'; } },
}));

// PR-I3 additions — bots use post-construction setters wired by the factory,
// so the mocks need recording stubs for those setters too (so we can assert
// they were called in the expected order with the expected arguments).
// (The PR 8.3 ProcessManager stub-singleton mock was removed with the
// service — dead code with zero production callers; see services.js.)

jest.mock('../../services/ChatBotService', () => class {
  constructor(...args) {
    this._args = args;
    this._stubName = 'ChatBotService';
    // PR 1.3: constructor signature is ({ botEventBus = null } = {}).
    // Capture the bus on the stub so the bus-wiring test can assert
    // it's the same instance handed to MovieBotService.
    this.botEventBus = args[0] && args[0].botEventBus;
    // Real ChatBotService exposes an llmService; surface a stub so the
    // factory's `streamBotService.setChatBotLLMService(chatBotService.llmService)`
    // line has something concrete to forward.
    this.llmService = { _stubName: 'ChatBotLLMService' };
    this._ioInstance = undefined;
  }
  setIoInstance(io) { this._ioInstance = io; }
});

// PR 1.3: BotEventBus is a thin EventEmitter wrapper. The stub mimics the
// minimal shape (on/emit) so the wiring test can issue an emit + verify a
// listener fires, without pulling in the real EventEmitter chain.
jest.mock('../../services/BotEventBus', () => class {
  constructor() {
    this._listeners = new Map();
    this._stubName = 'BotEventBus';
  }
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
  }
  emit(event, payload) {
    (this._listeners.get(event) || []).forEach((cb) => cb(payload));
  }
});

// PR 4.2: LifecycleManager stub records constructor args (none — the real
// class takes no deps) and surfaces a recording `stop()` so the
// reverse-shutdown ordering test (stoppables iteration) can see it ran.
jest.mock('../../services/LifecycleManager', () => class {
  constructor(...args) {
    this._args = args;
    this._stubName = 'LifecycleManager';
    this._stopped = false;
  }
  async stop() { this._stopped = true; }
});
jest.mock('../../services/StreamBotService', () => class {
  constructor(...args) {
    this._args = args;
    this._stubName = 'StreamBotService';
    this._chatBotService = undefined;
    this._chatBotLLMService = undefined;
  }
  setChatBotService(cbs) { this._chatBotService = cbs; }
  setChatBotLLMService(llm) { this._chatBotLLMService = llm; }
});
jest.mock('../../services/MovieBotService', () => class {
  constructor(...args) { this._args = args; this._stubName = 'MovieBotService'; }
});

// PR-I4 additions — the ViewBot stack lives in a separate factory
// (`createViewBotServices`) because it's late-init (post-mediasoup) and
// branches on whether LiveKit is the active backend. Mocks here mirror the
// real constructor signatures and record setter / init invocations so the
// tests can assert the cross-wiring and the LiveKit-branch await flow.
// ViewbotService was demoted to a stateless `isViewbotStream` predicate and is
// no longer constructed by createViewBotServices (it's bound directly in
// server/index.js), so there's nothing to mock for it here.
jest.mock('../../services/ViewBotLiveKitService', () => class {
  constructor(...args) {
    this._args = args;
    this._stubName = 'ViewBotLiveKitService';
    this._initialized = false;
    this._streamServiceArg = undefined;
  }
  async initialize() { this._initialized = true; }
  setStreamService(s) { this._streamServiceArg = s; }
});

// Pull in the mocked classes for instanceof checks.
const StreamService = require('../../services/StreamService');
const SessionService = require('../../services/SessionService');
const TakeoverService = require('../../services/TakeoverService');
const TestStreamService = require('../../services/TestStreamService');
const SimpleMediaStreamService = require('../../services/SimpleMediaStreamService');
const AudioOptimizationService = require('../../services/AudioOptimizationService');
const ResourceMonitor = require('../../services/ResourceMonitor');
const AccountService = require('../../services/AccountService');
const TimeTrackingService = require('../../services/TimeTrackingService');
const ItemService = require('../../services/ItemService');
const InventoryService = require('../../services/InventoryService');
const ShopService = require('../../services/ShopService');
const GameMechanicsService = require('../../services/GameMechanicsService');
const BuffDebuffService = require('../../services/BuffDebuffService');
const CanvasFxService = require('../../services/CanvasFxService');
const SoundFxService = require('../../services/SoundFxService');
const DiscordBotService = require('../../services/DiscordBotService');
const StreamNotifier = require('../../services/StreamNotifier');
const ViewerCountNotifier = require('../../services/ViewerCountNotifier');
const BuffNotifier = require('../../services/BuffNotifier');
const ModerationNotifier = require('../../services/ModerationNotifier');

// PR-I2 additions
const ClipStorageService = require('../../services/ClipStorageService');
const ClipProcessorService = require('../../services/ClipProcessorService');
const ContinuousRecordingService = require('../../services/ContinuousRecordingService');
const EgressFrameCaptureService = require('../../services/EgressFrameCaptureService');
const VisionBotService = require('../../services/VisionBotService');
const ClipService = require('../../services/ClipService');
const SessionChatCaptureService = require('../../services/SessionChatCaptureService');
const RecordingUploadScheduler = require('../../services/RecordingUploadScheduler');
const RecordingCleanupScheduler = require('../../services/RecordingCleanupScheduler');
const TranscriptionService = require('../../services/TranscriptionService');
const { GameService, GameStreamService } = require('../../services/game');

// PR-I3 additions
const ChatBotService = require('../../services/ChatBotService');
const StreamBotService = require('../../services/StreamBotService');
const MovieBotService = require('../../services/MovieBotService');

// PR 4.2
const LifecycleManager = require('../../services/LifecycleManager');

// PR-I4 additions — ViewbotService is now a stateless module (no class to
// import for instanceof checks).
const ViewBotLiveKitService = require('../../services/ViewBotLiveKitService');

const createServices = require('../../bootstrap/services');
const { createViewBotServices } = createServices;

function buildDeps(overrides = {}) {
  return {
    io: { _kind: 'io' },
    redisClient: { _kind: 'redis' },
    database: { _kind: 'database' },
    env: { NODE_ENV: 'test' },
    webrtcService: { _kind: 'mediasoup' },
    // PR 16.1: GameMechanicsService takes a shared Map by reference from
    // the factory — server/index.js creates it before calling createServices.
    // The factory guards null; pass a real Map so the constructor accepts.
    userBonusCooldowns: new Map(),
    ...overrides,
  };
}

describe('server/bootstrap/services factory', () => {
  test('returns all 38 expected keys (no more, no less)', () => {
    const { services } = createServices(buildDeps());

    const expectedKeys = [
      // PR-I core
      'streamService',
      'sessionService',
      // PR 3.1
      'streamNotifier',
      // PR 3.2
      'viewerCountNotifier',
      // PR 3.3
      'buffNotifier',
      // PR-M1
      'moderationNotifier',
      'takeoverService',
      'testStreamService',
      'mediaStreamService',
      'audioOptimizationService',
      'resourceMonitor',
      'accountService',
      'timeTrackingService',
      'itemService',
      'inventoryService',
      'shopService',
      // PR 16.1
      'gameMechanicsService',
      'buffDebuffService',
      'canvasFxService',
      'soundFxService',
      // Optional Discord live-announcement bot
      'discordBotService',
      // PR-I2 additions
      'clipStorageService',
      'clipProcessorService',
      'continuousRecordingService',
      // VisionBot frame source — added alongside continuousRecordingService.
      'egressFrameCaptureService',
      'clipService',
      'sessionChatCaptureService',
      'recordingUploadScheduler',
      'recordingCleanupScheduler',
      'transcriptionService',
      'gameService',
      'gameStreamService',
      // PR-I3 additions
      'chatBotService',
      'streamBotService',
      'movieBotService',
      // VisionBot phase
      'visionBotService',
      // PR 1.3
      'botEventBus',
      // PR 4.2
      'lifecycleManager',
    ];

    expect(Object.keys(services).sort()).toEqual(expectedKeys.slice().sort());
    expect(expectedKeys).toHaveLength(38);
  });

  test('each returned value is an instance of the matching service class', () => {
    const { services: s } = createServices(buildDeps());

    expect(s.streamService).toBeInstanceOf(StreamService);
    expect(s.sessionService).toBeInstanceOf(SessionService);
    expect(s.takeoverService).toBeInstanceOf(TakeoverService);
    expect(s.testStreamService).toBeInstanceOf(TestStreamService);
    expect(s.mediaStreamService).toBeInstanceOf(SimpleMediaStreamService);
    expect(s.audioOptimizationService).toBeInstanceOf(AudioOptimizationService);
    expect(s.resourceMonitor).toBeInstanceOf(ResourceMonitor);
    expect(s.accountService).toBeInstanceOf(AccountService);
    expect(s.timeTrackingService).toBeInstanceOf(TimeTrackingService);
    expect(s.itemService).toBeInstanceOf(ItemService);
    expect(s.inventoryService).toBeInstanceOf(InventoryService);
    expect(s.shopService).toBeInstanceOf(ShopService);
    // PR 16.1
    expect(s.gameMechanicsService).toBeInstanceOf(GameMechanicsService);
    expect(s.buffDebuffService).toBeInstanceOf(BuffDebuffService);
    expect(s.canvasFxService).toBeInstanceOf(CanvasFxService);
    expect(s.soundFxService).toBeInstanceOf(SoundFxService);
    expect(s.discordBotService).toBeInstanceOf(DiscordBotService);
    expect(s.streamNotifier).toBeInstanceOf(StreamNotifier);
    expect(s.viewerCountNotifier).toBeInstanceOf(ViewerCountNotifier);
    expect(s.buffNotifier).toBeInstanceOf(BuffNotifier);
    // PR-M1
    expect(s.moderationNotifier).toBeInstanceOf(ModerationNotifier);
    // PR-I2
    expect(s.clipStorageService).toBeInstanceOf(ClipStorageService);
    expect(s.clipProcessorService).toBeInstanceOf(ClipProcessorService);
    expect(s.continuousRecordingService).toBeInstanceOf(ContinuousRecordingService);
    expect(s.egressFrameCaptureService).toBeInstanceOf(EgressFrameCaptureService);
    expect(s.clipService).toBeInstanceOf(ClipService);
    expect(s.sessionChatCaptureService).toBeInstanceOf(SessionChatCaptureService);
    expect(s.recordingUploadScheduler).toBeInstanceOf(RecordingUploadScheduler);
    expect(s.recordingCleanupScheduler).toBeInstanceOf(RecordingCleanupScheduler);
    expect(s.transcriptionService).toBeInstanceOf(TranscriptionService);
    expect(s.gameService).toBeInstanceOf(GameService);
    expect(s.gameStreamService).toBeInstanceOf(GameStreamService);
    // PR-I3
    expect(s.chatBotService).toBeInstanceOf(ChatBotService);
    expect(s.streamBotService).toBeInstanceOf(StreamBotService);
    expect(s.movieBotService).toBeInstanceOf(MovieBotService);
    expect(s.visionBotService).toBeInstanceOf(VisionBotService);
    // PR 4.2
    expect(s.lifecycleManager).toBeInstanceOf(LifecycleManager);
  });

  test('takeoverService is constructed with (redisClient, sessionService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.takeoverService._args).toHaveLength(2);
    expect(s.takeoverService._args[0]).toBe(deps.redisClient);
    expect(s.takeoverService._args[1]).toBe(s.sessionService);
  });

  test('inventoryService is constructed with itemService', () => {
    const { services: s } = createServices(buildDeps());

    expect(s.inventoryService._args).toHaveLength(1);
    expect(s.inventoryService._args[0]).toBe(s.itemService);
  });

  test('shopService is constructed with (itemService, inventoryService, accountService, io)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.shopService._args).toHaveLength(4);
    expect(s.shopService._args[0]).toBe(s.itemService);
    expect(s.shopService._args[1]).toBe(s.inventoryService);
    expect(s.shopService._args[2]).toBe(s.accountService);
    expect(s.shopService._args[3]).toBe(deps.io);
  });

  test('gameMechanicsService is constructed with { accountService, userBonusCooldowns }', () => {
    // PR 16.1: the cooldown Map flows from server/index.js → factory →
    // GameMechanicsService by reference, so /claim-chat-bonus mutations
    // through the service and /bonus-status reads via
    // req.app.locals.userBonusCooldowns hit the same data. Identity-pin
    // here so a future refactor that accidentally clones the Map gets
    // caught by the test.
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.gameMechanicsService._args).toHaveLength(1);
    const ctorArg = s.gameMechanicsService._args[0];
    expect(ctorArg.accountService).toBe(s.accountService);
    expect(ctorArg.userBonusCooldowns).toBe(deps.userBonusCooldowns);
  });

  test('buffDebuffService is constructed with (io, streamService, timeTrackingService, sessionService, options)', () => {
    // PR 3.3: the 5th arg is the options bag — previously implicit (an
    // optional `{ itemRepository }`), now also carrying `buffNotifier` so
    // BuffDebuffService can route its 4 internal `streamer-buffs-update`
    // emits through the chokepoint. Identity-pinning the buffNotifier
    // entry keeps future PRs honest if anyone repurposes the slot.
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.buffDebuffService._args).toHaveLength(5);
    expect(s.buffDebuffService._args[0]).toBe(deps.io);
    expect(s.buffDebuffService._args[1]).toBe(s.streamService);
    expect(s.buffDebuffService._args[2]).toBe(s.timeTrackingService);
    expect(s.buffDebuffService._args[3]).toBe(s.sessionService);
    expect(s.buffDebuffService._args[4]).toBeDefined();
    expect(s.buffDebuffService._args[4].buffNotifier).toBe(s.buffNotifier);
  });

  test('canvasFxService receives the buffDebuffService built by the factory (order)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    // Per the dependency graph, buffDebuffService must exist before
    // canvasFxService can be built — check via identity.
    expect(s.canvasFxService._args).toHaveLength(3);
    expect(s.canvasFxService._args[0]).toBe(deps.io);
    expect(s.canvasFxService._args[1]).toBe(s.itemService);
    expect(s.canvasFxService._args[2]).toBe(s.buffDebuffService);
  });

  // PR 3.1: streamNotifier is the single `stream-ended` emit chokepoint.
  // Constructor takes (io) — pinning the identity here means a future PR that
  // changes the dep shape (e.g. adding a streamService for counter bumps) gets
  // a deliberate test update.
  test('streamNotifier is constructed with (io)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.streamNotifier._args).toHaveLength(1);
    expect(s.streamNotifier._args[0]).toBe(deps.io);
  });

  // PR 3.2: viewerCountNotifier is the `viewer-count-update` chokepoint.
  // Takes (io, sessionService) so its broadcast() method can derive the
  // count internally instead of trusting every callsite to pass the right
  // helper output.
  test('viewerCountNotifier is constructed with (io, sessionService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.viewerCountNotifier._args).toHaveLength(2);
    expect(s.viewerCountNotifier._args[0]).toBe(deps.io);
    expect(s.viewerCountNotifier._args[1]).toBe(s.sessionService);
  });

  // PR 3.3: buffNotifier is the chokepoint for the buff/inventory event
  // cluster (`streamer-buffs-update`, `inventory-updated`, `buff-error`).
  // Takes (io) only — payload comes from callers.
  test('buffNotifier is constructed with (io)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.buffNotifier._args).toHaveLength(1);
    expect(s.buffNotifier._args[0]).toBe(deps.io);
  });

  // PR 3.3: buffDebuffService's 5th arg (options bag) now carries
  // buffNotifier. The 4 internal `this.io.emit('streamer-buffs-update', …)`
  // sites read from `this.buffNotifier` when set.
  test('buffDebuffService receives buffNotifier via its options bag (5th arg)', () => {
    const { services: s } = createServices(buildDeps());

    expect(s.buffDebuffService._args).toHaveLength(5);
    expect(s.buffDebuffService._args[4]).toEqual(expect.objectContaining({
      buffNotifier: s.buffNotifier,
    }));
  });

  // ── PR-I2 dep-graph identity checks ───────────────────────────────────

  test('clipProcessorService receives the factory-built clipStorageService', () => {
    const { services: s } = createServices(buildDeps());
    expect(s.clipProcessorService._args[0]).toBe(s.clipStorageService);
  });

  test('clipService receives (database, clipStorageService, clipProcessorService, continuousRecordingService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.clipService._args).toHaveLength(4);
    expect(s.clipService._args[0]).toBe(deps.database);
    expect(s.clipService._args[1]).toBe(s.clipStorageService);
    expect(s.clipService._args[2]).toBe(s.clipProcessorService);
    expect(s.clipService._args[3]).toBe(s.continuousRecordingService);
  });

  test('transcriptionService receives (database, webrtcService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.transcriptionService._args).toHaveLength(2);
    expect(s.transcriptionService._args[0]).toBe(deps.database);
    expect(s.transcriptionService._args[1]).toBe(deps.webrtcService);
  });

  test('gameStreamService receives (io, gameService, takeoverService, streamService)', () => {
    // PR 2.5b: streamService threaded as 4th arg so the game-mode
    // stream-status emits at GameStreamService.js can bump
    // streamGeneration via streamService.bumpStreamGeneration() — they
    // build their own payload (not via streamService.getStreamStatus())
    // and so don't pick up the counter automatically.
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.gameStreamService._args).toHaveLength(4);
    expect(s.gameStreamService._args[0]).toBe(deps.io);
    expect(s.gameStreamService._args[1]).toBe(s.gameService);
    expect(s.gameStreamService._args[2]).toBe(s.takeoverService);
    expect(s.gameStreamService._args[3]).toBe(s.streamService);
  });

  // ── PR-I3 dep-graph + post-construction wiring identity checks ────────

  test('chatBotService is constructed with ({ botEventBus, getMoviePromptTemplate }) — PR 1.3', () => {
    const { services: s } = createServices(buildDeps());
    expect(s.chatBotService._args).toHaveLength(1);
    const ctorArg = s.chatBotService._args[0];
    expect(ctorArg.botEventBus).toBe(s.botEventBus);
    expect(typeof ctorArg.getMoviePromptTemplate).toBe('function');
    // The closure should resolve to MovieBot's config.moviePromptTemplate
    // at call time. In the test stub, MovieBotService has no .config so
    // the closure returns undefined; verify it doesn't throw.
    expect(() => ctorArg.getMoviePromptTemplate()).not.toThrow();
  });

  test('streamBotService is constructed with (database)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.streamBotService._args).toHaveLength(1);
    expect(s.streamBotService._args[0]).toBe(deps.database);
  });

  test('movieBotService receives (transcriptionService, chatBotService, chatServiceWrapper, database, botEventBus)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.movieBotService._args).toHaveLength(5);
    expect(s.movieBotService._args[0]).toBe(s.transcriptionService);
    expect(s.movieBotService._args[1]).toBe(s.chatBotService);
    // The 3rd arg is the factory's literal chatServiceWrapper closure —
    // it's a fresh object, but we can confirm its shape.
    expect(typeof s.movieBotService._args[2]).toBe('object');
    expect(typeof s.movieBotService._args[2].getRecentMessages).toBe('function');
    expect(s.movieBotService._args[3]).toBe(deps.database);
    // PR 1.3: 5th arg is the BotEventBus shared with chatBotService.
    expect(s.movieBotService._args[4]).toBe(s.botEventBus);
  });

  test('chatBotService gets the io instance via setIoInstance', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.chatBotService._ioInstance).toBe(deps.io);
  });

  test('PR 1.3: ChatBot and MovieBot share the same BotEventBus instance', () => {
    const { services: s } = createServices(buildDeps());

    // Both services should hold the SAME bus instance (the one in s.botEventBus).
    expect(s.chatBotService.botEventBus).toBe(s.botEventBus);
    // MovieBotService stores constructor args on _args; the 5th arg is the bus.
    expect(s.movieBotService._args[4]).toBe(s.botEventBus);
  });

  test('PR 1.3: emit on the bus reaches subscribers (no direct service-to-service ref)', () => {
    const { services: s } = createServices(buildDeps());
    let received = null;
    s.botEventBus.on('chat-message', (payload) => { received = payload; });

    s.botEventBus.emit('chat-message', { username: 'TestCat', message: 'hello' });

    expect(received).toEqual({ username: 'TestCat', message: 'hello' });
  });

  // ── PR 4.2: LifecycleManager wiring ──────────────────────────────────

  test('PR 4.2: lifecycleManager is constructed with no args', () => {
    const { services: s } = createServices(buildDeps());
    expect(s.lifecycleManager._args).toEqual([]);
  });

  test('PR 4.2: lifecycleManager appears in stoppables and at the end (drained first under reverse-iteration)', () => {
    const { stoppables } = createServices(buildDeps());
    expect(stoppables).toContain(stoppables.find((s) => s._stubName === 'LifecycleManager'));
    // Reverse-iteration order: the LAST entry in stoppables is drained
    // FIRST. We want lifecycleManager drained first so any pending
    // deferred work is cancelled before its target services tear down.
    expect(stoppables[stoppables.length - 1]._stubName).toBe('LifecycleManager');
  });

  // (PR 8.3 ProcessManager wiring test removed with the service.)

  test('streamBotService gets chatBotService + chatBotService.llmService via setters', () => {
    const { services: s } = createServices(buildDeps());

    expect(s.streamBotService._chatBotService).toBe(s.chatBotService);
    expect(s.streamBotService._chatBotLLMService).toBe(s.chatBotService.llmService);
  });

  test('omitting required deps leaves the corresponding ctor arg undefined (no validation today)', () => {
    // The current factory does NOT validate inputs; it simply forwards
    // whatever is destructured. This test pins that behavior so a future
    // PR that adds required-dep checks deliberately updates this case.
    const deps = buildDeps({ io: undefined });
    const { services: s } = createServices(deps);

    expect(s.shopService._args[3]).toBeUndefined();
    expect(s.buffDebuffService._args[0]).toBeUndefined();
    expect(s.canvasFxService._args[0]).toBeUndefined();
  });

  test('throws when called with no deps object (destructure of undefined)', () => {
    expect(() => createServices()).toThrow(TypeError);
  });

  // ── PR 2.3: single fail-fast guard for the dep DAG ──────────────────────
  //
  // The existing 30+ tests in this block each pin one service's ctor args
  // by identity — that catches *wrong* wiring. This test catches *missing*
  // wiring: with the full standard deps bag, no positional ctor arg should
  // be `undefined`. If a future PR adds a new service that takes a dep the
  // factory doesn't thread (e.g., `new X(deps.zservice)` with no `zservice`
  // in the destructure), this fires with a list of offenders rather than
  // each affected route blowing up at runtime when the undefined gets
  // dereferenced. Note: `null` is distinguished from `undefined` — the
  // LiveKit-vs-MediaSoup branches leave their unused side null on the
  // ViewBot bag. Only `undefined` indicates a wiring gap.
  test('no service ctor arg is undefined when called with full deps (PR 2.3 fail-fast guard)', () => {
    const { services } = createServices(buildDeps());

    const offenders = [];
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || !svc._args || svc._args.length === 0) continue;
      svc._args.forEach((arg, idx) => {
        if (arg === undefined) {
          offenders.push(`${name}#${idx}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

// ── PR-I4: createViewBotServices (late-init helper) ─────────────────────────
//
// Separate factory because it's only called inside startServer() once the
// LiveKit backend is in play, and it branches on whether LiveKit is present.
// ViewbotService was demoted to the stateless `isViewbotStream` predicate and
// is no longer constructed/bagged here. Tests assert:
//   1. The factory is exposed on the main createServices export.
//   2. No-LiveKit branch: bag has viewBotLiveKitService === null and nothing
//      else.
//   3. LiveKit branch (livekitService present): builds + initializes
//      viewBotLiveKitService and wires streamService.
//   4. Constructor arg identity for viewBotLiveKitService matches the inline
//      original.

describe('server/bootstrap/services :: createViewBotServices', () => {
  function buildViewBotDeps(overrides = {}) {
    return {
      webrtcService: { _kind: 'mediasoup' },
      livekitService: null,
      streamService: { _kind: 'streamService' },
      ...overrides,
    };
  }

  test('is exposed as a property of the main createServices export', () => {
    expect(typeof createViewBotServices).toBe('function');
  });

  test('no-LiveKit branch (livekitService null): bag has only viewBotLiveKitService === null', async () => {
    const deps = buildViewBotDeps();
    const { services: bag } = await createViewBotServices(deps);

    expect(Object.keys(bag)).toEqual(['viewBotLiveKitService']);
    expect(bag.viewBotLiveKitService).toBeNull();
  });

  test('LiveKit branch (livekitService present): builds + initializes LiveKit + wires streamService', async () => {
    const livekitService = { _kind: 'livekit' };
    const deps = buildViewBotDeps({ livekitService });
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewBotLiveKitService).toBeInstanceOf(ViewBotLiveKitService);

    // LiveKit branch must await initialize() AND register streamService.
    expect(bag.viewBotLiveKitService._initialized).toBe(true);
    expect(bag.viewBotLiveKitService._streamServiceArg).toBe(deps.streamService);
  });

  test('viewbotService is no longer constructed/bagged (demoted to stateless predicate)', async () => {
    const livekitService = { _kind: 'livekit' };
    const deps = buildViewBotDeps({ livekitService });
    const { services: bag } = await createViewBotServices(deps);

    expect(bag).not.toHaveProperty('viewbotService');
  });

  test('viewBotLiveKitService is constructed with (livekitService)', async () => {
    const livekitService = { _kind: 'livekit' };
    const deps = buildViewBotDeps({ livekitService });
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewBotLiveKitService._args).toHaveLength(1);
    expect(bag.viewBotLiveKitService._args[0]).toBe(livekitService);
  });

  // ── PR 2.3: fail-fast guard for the ViewBot factory ─────────────────────
  //
  // Same intent as the main-factory guard above, but the ViewBot bag is
  // branched: without LiveKit, viewBotLiveKitService is left `null` on the
  // bag. We skip nulls (intentional). Two test cases — one per branch.

  test('no-LiveKit branch: no ViewBot ctor arg is undefined (PR 2.3 fail-fast guard)', async () => {
    const deps = buildViewBotDeps();
    const { services: bag } = await createViewBotServices(deps);

    const offenders = [];
    for (const [name, svc] of Object.entries(bag)) {
      if (svc === null) continue;
      if (!svc._args || svc._args.length === 0) continue;
      svc._args.forEach((arg, idx) => {
        if (arg === undefined) {
          offenders.push(`${name}#${idx}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test('LiveKit branch: no ViewBot ctor arg is undefined (PR 2.3 fail-fast guard)', async () => {
    const livekitService = { _kind: 'livekit' };
    const deps = buildViewBotDeps({ livekitService });
    const { services: bag } = await createViewBotServices(deps);

    const offenders = [];
    for (const [name, svc] of Object.entries(bag)) {
      if (svc === null) continue;
      if (!svc._args || svc._args.length === 0) continue;
      svc._args.forEach((arg, idx) => {
        if (arg === undefined) {
          offenders.push(`${name}#${idx}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
