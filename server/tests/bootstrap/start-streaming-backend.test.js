// Tests for the streaming-backend orchestration helper extracted in PR 9.3.
//
// The module under test (`server/bootstrap/start-streaming-backend.js`)
// owns the post-PR-9.2-aligned block that constructs URL/Random rotation
// services + ActionArbiter + WhitelistEnforcer and wires the LiveKit-only
// asymmetries inside a single `if (livekitService)` guard. The block has
// no return value — its job is side effects:
//   - sets globals (`viewBotURLService`, `urlStreamHealthService`,
//     `randomStreamRotationService`, `whitelistEnforcer`, `viewBotLiveKitService`)
//   - sets `app.locals.moderationActionArbiter` + `app.locals.whitelistEnforcer`
//   - mounts `/api/url-stream` + `/api/random-stream` on the Express app
//   - pushes `WhitelistEnforcer` to `stoppables`
//   - schedules `random-rotation-autostart` via `lifecycleManager`
//   - on LiveKit branch: wires `SimpleViewBotRotation.setLiveKitService`,
//     URL-service LiveKit + deliberate-dormancy setters, the LiveKit
//     cross-wire, and the streamer health check.
//
// We mock every constructed service with a tiny stub that records ctor
// args on `this._args` and method calls on `this._calls`. That gives us
// behaviour assertions without booting any real service.

// ── Mocks for everything the module constructs ───────────────────────────
jest.mock('../../services/ViewBotURLService', () => class {
  constructor(...args) { this._args = args; this._stubName = 'ViewBotURLService'; this._calls = {}; this.activeStreams = new Map(); }
  setStreamService(...a) { this._calls.setStreamService = a; }
  setViewBotRotation(...a) { this._calls.setViewBotRotation = a; }
  setWhitelistService(...a) { this._calls.setWhitelistService = a; }
  setLiveKitService(...a) { this._calls.setLiveKitService = a; }
  setSocketIO(...a) { this._calls.setSocketIO = a; }
  setStreamNotifier(...a) { this._calls.setStreamNotifier = a; }
});

jest.mock('../../services/URLStreamHealthService', () => class {
  constructor(...args) { this._args = args; this._stubName = 'URLStreamHealthService'; this._listeners = {}; this._started = false; }
  start() { this._started = true; }
  on(event, fn) { this._listeners[event] = fn; }
});

jest.mock('../../services/RandomStreamRotationService', () => class {
  constructor(...args) { this._args = args; this._stubName = 'RandomStreamRotationService'; this._calls = {}; this.twitchService = { tag: 'twitch' }; this.kickService = { tag: 'kick' }; }
  setViewBotURLService(...a) { this._calls.setViewBotURLService = a; }
  setViewBotRotation(...a) { this._calls.setViewBotRotation = a; }
  setSocketIO(...a) { this._calls.setSocketIO = a; }
  setStreamNotifier(...a) { this._calls.setStreamNotifier = a; }
  setWhitelistService(...a) { this._calls.setWhitelistService = a; }
});

jest.mock('../../services/WhitelistEnforcer', () => class {
  constructor(...args) { this._args = args; this._stubName = 'WhitelistEnforcer'; this._started = false; }
  start() { this._started = true; }
});

jest.mock('../../services/ModerationActionArbiter', () => class {
  constructor(...args) { this._args = args; this._stubName = 'ModerationActionArbiter'; }
});

jest.mock('../../database/repository/UserRepository', () => class {
  constructor(...args) { this._args = args; this._stubName = 'UserRepository'; }
});

// Routes factories are functions that return a router-like value. We just
// echo a tagged object so we can assert it got handed to app.use.
jest.mock('../../routes/url-stream', () => jest.fn((...args) => ({ _routeFactory: 'url-stream', _args: args })));
jest.mock('../../routes/random-stream', () => jest.fn((...args) => ({ _routeFactory: 'random-stream', _args: args })));

const startStreamingBackend = require('../../bootstrap/start-streaming-backend');

// ── Deps factory ─────────────────────────────────────────────────────────
function makeDeps(overrides = {}) {
  const app = {
    locals: {},
    use: jest.fn(),
  };
  const lifecycleManager = {
    schedule: jest.fn(),
  };
  const SimpleViewBotRotation = {
    setURLViewBotService: jest.fn(),
    setLiveKitService: jest.fn(),
  };
  return {
    streamService: { _stubName: 'StreamService' },
    SimpleViewBotRotation,
    whitelistService: { _stubName: 'WhitelistService' },
    io: { _stubName: 'io' },
    streamNotifier: { _stubName: 'streamNotifier' },
    moderationService: {
      _stubName: 'ModerationService',
      setActionArbiter: jest.fn(),
    },
    sessionService: { _stubName: 'SessionService' },
    moderationNotifier: { _stubName: 'ModerationNotifier' },
    database: { _stubName: 'database' },
    lifecycleManager,
    app,
    stoppables: [],
    livekitService: null,
    viewBotLiveKitService: null,
    ...overrides,
  };
}

// Clean up the globals/env the module mutates so tests don't bleed into
// each other.
function cleanGlobals() {
  delete global.viewBotURLService;
  delete global.urlStreamHealthService;
  delete global.randomStreamRotationService;
  delete global.whitelistEnforcer;
  delete global.viewBotLiveKitService;
}

afterEach(() => {
  cleanGlobals();
  delete process.env.AI_MODERATION_ENFORCE;
});

describe('startStreamingBackend (MediaSoup branch — livekitService null)', () => {
  test('constructs the URL stream stack and wires it through SimpleViewBotRotation', () => {
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(global.viewBotURLService).toBeDefined();
    expect(global.viewBotURLService._stubName).toBe('ViewBotURLService');
    expect(global.viewBotURLService._calls.setStreamService).toEqual([deps.streamService]);
    expect(global.viewBotURLService._calls.setViewBotRotation).toEqual([deps.SimpleViewBotRotation]);
    expect(global.viewBotURLService._calls.setWhitelistService).toEqual([deps.whitelistService]);
    expect(global.urlStreamHealthService._started).toBe(true);
    expect(global.urlStreamHealthService._listeners['source-offline']).toBeInstanceOf(Function);
    expect(global.urlStreamHealthService._listeners['stream-stale']).toBeInstanceOf(Function);
    expect(deps.SimpleViewBotRotation.setURLViewBotService).toHaveBeenCalledWith(global.viewBotURLService);
    expect(deps.app.use).toHaveBeenCalledWith('/api/url-stream', expect.objectContaining({ _routeFactory: 'url-stream' }));
  });

  test('constructs RandomStreamRotationService and sets it globally', () => {
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(global.randomStreamRotationService).toBeDefined();
    expect(global.randomStreamRotationService._stubName).toBe('RandomStreamRotationService');
    expect(global.randomStreamRotationService._calls.setSocketIO).toEqual([deps.io]);
    expect(global.randomStreamRotationService._calls.setStreamNotifier).toEqual([deps.streamNotifier]);
    expect(global.randomStreamRotationService._calls.setWhitelistService).toEqual([deps.whitelistService]);
    expect(deps.app.use).toHaveBeenCalledWith('/api/random-stream', expect.objectContaining({ _routeFactory: 'random-stream' }));
  });

  test('wires the ActionArbiter when moderationService is present', () => {
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(deps.app.locals.moderationActionArbiter).toBeDefined();
    expect(deps.app.locals.moderationActionArbiter._stubName).toBe('ModerationActionArbiter');
    expect(deps.moderationService.setActionArbiter).toHaveBeenCalledWith(deps.app.locals.moderationActionArbiter);
    // ctor args (object); spot-check the dep identities the arbiter receives.
    const arbiterArgs = deps.app.locals.moderationActionArbiter._args[0];
    expect(arbiterArgs.sessionService).toBe(deps.sessionService);
    expect(arbiterArgs.streamService).toBe(deps.streamService);
    expect(arbiterArgs.randomStreamRotationService).toBe(global.randomStreamRotationService);
    expect(arbiterArgs.whitelistService).toBe(deps.whitelistService);
    expect(arbiterArgs.moderationNotifier).toBe(deps.moderationNotifier);
    expect(arbiterArgs.enforce).toBe(false); // default — env unset
  });

  test('ActionArbiter.enforce honors AI_MODERATION_ENFORCE=true at first install', () => {
    process.env.AI_MODERATION_ENFORCE = 'true';
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(deps.app.locals.moderationActionArbiter._args[0].enforce).toBe(true);
  });

  test('skips ActionArbiter wiring when moderationService is null', () => {
    const deps = makeDeps({ moderationService: null });
    startStreamingBackend(deps);

    expect(deps.app.locals.moderationActionArbiter).toBeUndefined();
  });

  test('constructs WhitelistEnforcer and pushes it to stoppables when whitelistService is present', () => {
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(global.whitelistEnforcer).toBeDefined();
    expect(global.whitelistEnforcer._stubName).toBe('WhitelistEnforcer');
    expect(global.whitelistEnforcer._started).toBe(true);
    expect(deps.app.locals.whitelistEnforcer).toBe(global.whitelistEnforcer);
    expect(deps.stoppables).toContain(global.whitelistEnforcer);

    // The enforcer receives twitchService + kickService from the rotation.
    const enforcerArgs = global.whitelistEnforcer._args[0];
    expect(enforcerArgs.twitchService).toBe(global.randomStreamRotationService.twitchService);
    expect(enforcerArgs.kickService).toBe(global.randomStreamRotationService.kickService);
    expect(enforcerArgs.io).toBe(deps.io);
  });

  test('skips WhitelistEnforcer when whitelistService is null', () => {
    const deps = makeDeps({ whitelistService: null });
    startStreamingBackend(deps);

    expect(global.whitelistEnforcer).toBeUndefined();
    expect(deps.stoppables).toHaveLength(0);
  });

  test('schedules the unified random-rotation-autostart', () => {
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(deps.lifecycleManager.schedule).toHaveBeenCalledWith(
      'random-rotation-autostart',
      expect.any(Function),
      5000
    );
  });

  test('D2 dormancy: NO setSocketIO / setStreamNotifier on viewBotURLService when livekitService null', () => {
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(global.viewBotURLService._calls.setSocketIO).toBeUndefined();
    expect(global.viewBotURLService._calls.setStreamNotifier).toBeUndefined();
    expect(global.viewBotURLService._calls.setLiveKitService).toBeUndefined();
  });

  test('does not touch LiveKit-only globals when livekitService null', () => {
    const deps = makeDeps();
    startStreamingBackend(deps);

    expect(global.viewBotLiveKitService).toBeUndefined();
    expect(deps.SimpleViewBotRotation.setLiveKitService).not.toHaveBeenCalled();
  });
});

describe('startStreamingBackend (LiveKit branch — livekitService present)', () => {
  function makeLiveKitDeps(overrides = {}) {
    const livekitService = {
      _stubName: 'LiveKitService',
      startStreamerHealthCheck: jest.fn(),
    };
    const viewBotLiveKitService = {
      _stubName: 'ViewBotLiveKitService',
      setURLViewBotService: jest.fn(),
    };
    return makeDeps({ livekitService, viewBotLiveKitService, ...overrides });
  }

  test('wires SimpleViewBotRotation.setLiveKitService + URL service LiveKit cross-wire', () => {
    const deps = makeLiveKitDeps();
    startStreamingBackend(deps);

    expect(deps.SimpleViewBotRotation.setLiveKitService).toHaveBeenCalledWith(deps.viewBotLiveKitService);
    expect(global.viewBotURLService._calls.setLiveKitService).toEqual([deps.viewBotLiveKitService]);
    expect(deps.viewBotLiveKitService.setURLViewBotService).toHaveBeenCalledWith(global.viewBotURLService);
  });

  test('D2 dormancy zone: setSocketIO + setStreamNotifier fire ONLY on the LiveKit branch', () => {
    const deps = makeLiveKitDeps();
    startStreamingBackend(deps);

    expect(global.viewBotURLService._calls.setSocketIO).toEqual([deps.io]);
    expect(global.viewBotURLService._calls.setStreamNotifier).toEqual([deps.streamNotifier]);
  });

  test('publishes viewBotLiveKitService globally and starts the streamer health check', () => {
    const deps = makeLiveKitDeps();
    startStreamingBackend(deps);

    expect(global.viewBotLiveKitService).toBe(deps.viewBotLiveKitService);
    expect(deps.livekitService.startStreamerHealthCheck).toHaveBeenCalledWith(
      deps.streamService,
      deps.io,
      10000
    );
  });
});
