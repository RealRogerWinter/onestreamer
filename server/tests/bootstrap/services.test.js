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
//        canvasFxService, plainTransportService,
//        streamInterceptorService, visualFxService, clipService,
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
jest.mock('../../services/BuffDebuffService', () => class { constructor(...args) { this._args = args; this._stubName = 'BuffDebuffService'; } });
jest.mock('../../services/CanvasFxService', () => class { constructor(...args) { this._args = args; this._stubName = 'CanvasFxService'; } });
jest.mock('../../services/SoundFxService', () => class { constructor(...args) { this._args = args; this._stubName = 'SoundFxService'; } });
jest.mock('../../services/MediasoupPlainTransportService', () => class { constructor(...args) { this._args = args; this._stubName = 'MediasoupPlainTransportService'; } });

// PR-I2 additions
jest.mock('../../services/StreamInterceptorService', () => class { constructor(...args) { this._args = args; this._stubName = 'StreamInterceptorService'; } });
jest.mock('../../services/VisualFxService', () => class { constructor(...args) { this._args = args; this._stubName = 'VisualFxService'; } });
jest.mock('../../services/RecordingStorageService', () => class { constructor(...args) { this._args = args; this._stubName = 'RecordingStorageService'; } });
jest.mock('../../services/FileCompressionService', () => class { constructor(...args) { this._args = args; this._stubName = 'FileCompressionService'; } });
jest.mock('../../services/RecordingService', () => class { constructor(...args) { this._args = args; this._stubName = 'RecordingService'; } });
jest.mock('../../services/ClipStorageService', () => class { constructor(...args) { this._args = args; this._stubName = 'ClipStorageService'; } });
jest.mock('../../services/ClipProcessorService', () => class { constructor(...args) { this._args = args; this._stubName = 'ClipProcessorService'; } });
jest.mock('../../services/ContinuousRecordingService', () => class { constructor(...args) { this._args = args; this._stubName = 'ContinuousRecordingService'; } });
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
jest.mock('../../services/ViewbotService', () => class {
  constructor(...args) {
    this._args = args;
    this._stubName = 'ViewbotService';
    this.viewBotClientService = undefined; // factory assigns this post-construction
  }
});
jest.mock('../../services/ViewBotWebRTCService', () => class {
  constructor(...args) { this._args = args; this._stubName = 'ViewBotWebRTCService'; }
});
jest.mock('../../services/ViewBotClientService', () => class {
  constructor(...args) { this._args = args; this._stubName = 'ViewBotClientService'; }
});
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
const BuffDebuffService = require('../../services/BuffDebuffService');
const CanvasFxService = require('../../services/CanvasFxService');
const SoundFxService = require('../../services/SoundFxService');
const MediasoupPlainTransportService = require('../../services/MediasoupPlainTransportService');

// PR-I2 additions
const StreamInterceptorService = require('../../services/StreamInterceptorService');
const VisualFxService = require('../../services/VisualFxService');
const RecordingStorageService = require('../../services/RecordingStorageService');
const FileCompressionService = require('../../services/FileCompressionService');
const RecordingService = require('../../services/RecordingService');
const ClipStorageService = require('../../services/ClipStorageService');
const ClipProcessorService = require('../../services/ClipProcessorService');
const ContinuousRecordingService = require('../../services/ContinuousRecordingService');
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

// PR-I4 additions
const ViewbotService = require('../../services/ViewbotService');
const ViewBotWebRTCService = require('../../services/ViewBotWebRTCService');
const ViewBotClientService = require('../../services/ViewBotClientService');
const ViewBotLiveKitService = require('../../services/ViewBotLiveKitService');

const createServices = require('../../bootstrap/services');
const { createViewBotServices } = createServices;

function buildDeps(overrides = {}) {
  return {
    io: { _kind: 'io' },
    redisClient: { _kind: 'redis' },
    database: { _kind: 'database' },
    env: { NODE_ENV: 'test' },
    mediasoupService: { _kind: 'mediasoup' },
    ...overrides,
  };
}

describe('server/bootstrap/services factory', () => {
  test('returns all 35 expected keys (no more, no less)', () => {
    const { services } = createServices(buildDeps());

    const expectedKeys = [
      // PR-I core
      'streamService',
      'sessionService',
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
      'buffDebuffService',
      'canvasFxService',
      'soundFxService',
      'plainTransportService',
      // PR-I2 additions
      'streamInterceptorService',
      'visualFxService',
      'recordingStorageService',
      'fileCompressionService',
      'recordingService',
      'clipStorageService',
      'clipProcessorService',
      'continuousRecordingService',
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
      // PR 1.3
      'botEventBus',
    ];

    expect(Object.keys(services).sort()).toEqual(expectedKeys.slice().sort());
    expect(expectedKeys).toHaveLength(35);
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
    expect(s.buffDebuffService).toBeInstanceOf(BuffDebuffService);
    expect(s.canvasFxService).toBeInstanceOf(CanvasFxService);
    expect(s.soundFxService).toBeInstanceOf(SoundFxService);
    expect(s.plainTransportService).toBeInstanceOf(MediasoupPlainTransportService);
    // PR-I2
    expect(s.streamInterceptorService).toBeInstanceOf(StreamInterceptorService);
    expect(s.visualFxService).toBeInstanceOf(VisualFxService);
    expect(s.recordingStorageService).toBeInstanceOf(RecordingStorageService);
    expect(s.fileCompressionService).toBeInstanceOf(FileCompressionService);
    expect(s.recordingService).toBeInstanceOf(RecordingService);
    expect(s.clipStorageService).toBeInstanceOf(ClipStorageService);
    expect(s.clipProcessorService).toBeInstanceOf(ClipProcessorService);
    expect(s.continuousRecordingService).toBeInstanceOf(ContinuousRecordingService);
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

  test('buffDebuffService is constructed with (io, streamService, timeTrackingService, sessionService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.buffDebuffService._args).toHaveLength(4);
    expect(s.buffDebuffService._args[0]).toBe(deps.io);
    expect(s.buffDebuffService._args[1]).toBe(s.streamService);
    expect(s.buffDebuffService._args[2]).toBe(s.timeTrackingService);
    expect(s.buffDebuffService._args[3]).toBe(s.sessionService);
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

  test('plainTransportService is constructed with the passed-in mediasoupService', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.plainTransportService._args).toHaveLength(1);
    expect(s.plainTransportService._args[0]).toBe(deps.mediasoupService);
  });

  // ── PR-I2 dep-graph identity checks ───────────────────────────────────

  test('streamInterceptorService receives (mediasoupService, plainTransportService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.streamInterceptorService._args).toHaveLength(2);
    expect(s.streamInterceptorService._args[0]).toBe(deps.mediasoupService);
    expect(s.streamInterceptorService._args[1]).toBe(s.plainTransportService);
  });

  test('visualFxService receives (mediasoupService, buffDebuffService, streamInterceptorService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.visualFxService._args).toHaveLength(3);
    expect(s.visualFxService._args[0]).toBe(deps.mediasoupService);
    expect(s.visualFxService._args[1]).toBe(s.buffDebuffService);
    expect(s.visualFxService._args[2]).toBe(s.streamInterceptorService);
  });

  test('recordingService receives (database, mediasoupService, recordingStorageService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.recordingService._args).toHaveLength(3);
    expect(s.recordingService._args[0]).toBe(deps.database);
    expect(s.recordingService._args[1]).toBe(deps.mediasoupService);
    expect(s.recordingService._args[2]).toBe(s.recordingStorageService);
  });

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

  test('transcriptionService receives (database, mediasoupService, recordingService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.transcriptionService._args).toHaveLength(3);
    expect(s.transcriptionService._args[0]).toBe(deps.database);
    expect(s.transcriptionService._args[1]).toBe(deps.mediasoupService);
    expect(s.transcriptionService._args[2]).toBe(s.recordingService);
  });

  test('gameStreamService receives (io, gameService, takeoverService)', () => {
    const deps = buildDeps();
    const { services: s } = createServices(deps);

    expect(s.gameStreamService._args).toHaveLength(3);
    expect(s.gameStreamService._args[0]).toBe(deps.io);
    expect(s.gameStreamService._args[1]).toBe(s.gameService);
    expect(s.gameStreamService._args[2]).toBe(s.takeoverService);
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
  // dereferenced. Note: `null` is distinguished from `undefined` —
  // viewBotClientService passes `null` as serverUrl intentionally for the
  // env-var fallback, and the LiveKit-vs-MediaSoup branches leave their
  // unused side null on the bag. Only `undefined` indicates a wiring gap.
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
// Separate factory because it's only called inside startServer() after
// mediasoupService.initialize() resolves, and it branches on whether a
// LiveKit backend is in play. Tests assert:
//   1. The factory is exposed on the main createServices export.
//   2. Always-constructed services: viewbotService + viewBotClientService.
//   3. MediaSoup branch (no livekitService): builds viewBotWebRTCService,
//      leaves viewBotLiveKitService null.
//   4. LiveKit branch (livekitService present): builds + initializes
//      viewBotLiveKitService, wires streamService, leaves viewBotWebRTCService
//      null.
//   5. Cross-wire: viewbotService.viewBotClientService === viewBotClientService.
//   6. Constructor arg identity for each service matches the inline original.

describe('server/bootstrap/services :: createViewBotServices', () => {
  function buildViewBotDeps(overrides = {}) {
    return {
      mediasoupService: { _kind: 'mediasoup' },
      livekitService: null,
      streamService: { _kind: 'streamService' },
      ...overrides,
    };
  }

  test('is exposed as a property of the main createServices export', () => {
    expect(typeof createViewBotServices).toBe('function');
  });

  test('MediaSoup branch (livekitService null): builds Viewbot + WebRTC + Client; leaves LiveKit null', async () => {
    const deps = buildViewBotDeps();
    const { services: bag } = await createViewBotServices(deps);

    expect(Object.keys(bag).sort()).toEqual(
      ['viewBotClientService', 'viewBotLiveKitService', 'viewBotWebRTCService', 'viewbotService'].sort()
    );

    expect(bag.viewbotService).toBeInstanceOf(ViewbotService);
    expect(bag.viewBotWebRTCService).toBeInstanceOf(ViewBotWebRTCService);
    expect(bag.viewBotClientService).toBeInstanceOf(ViewBotClientService);
    expect(bag.viewBotLiveKitService).toBeNull();
  });

  test('LiveKit branch (livekitService present): builds + initializes LiveKit + wires streamService; leaves WebRTC null', async () => {
    const livekitService = { _kind: 'livekit' };
    const deps = buildViewBotDeps({ livekitService });
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewbotService).toBeInstanceOf(ViewbotService);
    expect(bag.viewBotClientService).toBeInstanceOf(ViewBotClientService);
    expect(bag.viewBotWebRTCService).toBeNull();
    expect(bag.viewBotLiveKitService).toBeInstanceOf(ViewBotLiveKitService);

    // LiveKit branch must await initialize() AND register streamService.
    expect(bag.viewBotLiveKitService._initialized).toBe(true);
    expect(bag.viewBotLiveKitService._streamServiceArg).toBe(deps.streamService);
  });

  test('viewbotService is constructed with (mediasoupService, livekitService)', async () => {
    const livekitService = { _kind: 'livekit' };
    const deps = buildViewBotDeps({ livekitService });
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewbotService._args).toHaveLength(2);
    expect(bag.viewbotService._args[0]).toBe(deps.mediasoupService);
    expect(bag.viewbotService._args[1]).toBe(livekitService);
  });

  test('viewbotService receives null as livekitService on MediaSoup branch', async () => {
    const deps = buildViewBotDeps();
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewbotService._args[1]).toBeNull();
  });

  test('viewBotWebRTCService is constructed with (mediasoupService)', async () => {
    const deps = buildViewBotDeps();
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewBotWebRTCService._args).toHaveLength(1);
    expect(bag.viewBotWebRTCService._args[0]).toBe(deps.mediasoupService);
  });

  test('viewBotLiveKitService is constructed with (livekitService)', async () => {
    const livekitService = { _kind: 'livekit' };
    const deps = buildViewBotDeps({ livekitService });
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewBotLiveKitService._args).toHaveLength(1);
    expect(bag.viewBotLiveKitService._args[0]).toBe(livekitService);
  });

  test('viewBotClientService is constructed with (null, mediasoupService, streamService, viewbotService)', async () => {
    const deps = buildViewBotDeps();
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewBotClientService._args).toHaveLength(4);
    expect(bag.viewBotClientService._args[0]).toBeNull(); // serverUrl null -> env-var fallback
    expect(bag.viewBotClientService._args[1]).toBe(deps.mediasoupService);
    expect(bag.viewBotClientService._args[2]).toBe(deps.streamService);
    expect(bag.viewBotClientService._args[3]).toBe(bag.viewbotService);
  });

  test('cross-wires viewbotService.viewBotClientService = viewBotClientService', async () => {
    const deps = buildViewBotDeps();
    const { services: bag } = await createViewBotServices(deps);

    expect(bag.viewbotService.viewBotClientService).toBe(bag.viewBotClientService);
  });

  // ── PR 2.3: fail-fast guard for the ViewBot factory ─────────────────────
  //
  // Same intent as the main-factory guard above, but the ViewBot bag is
  // branched: the inactive backend leaves either viewBotWebRTCService or
  // viewBotLiveKitService as `null` on the bag. We skip nulls (intentional)
  // and `viewBotClientService._args[0]` is intentionally `null` for the
  // env-var fallback path, which the `!== undefined` check tolerates.
  // Two test cases — one per branch — because each branch constructs a
  // different service via a different `new` site.

  test('MediaSoup branch: no ViewBot ctor arg is undefined (PR 2.3 fail-fast guard)', async () => {
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
