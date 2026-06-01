/**
 * ViewBotHandler — characterization tests.
 *
 * These PIN the current observable behaviour of
 * `server/sockets/ViewBotHandler.js` so a follow-up decomposition into
 * sub-handler modules can be proven byte-equivalent.
 *
 * Approach (mock-based, no real socket.io server):
 *   - Build mock `io` / `socket` objects whose `.on`/`.emit` are jest.fn().
 *   - Invoke `registerViewBotHandler(io, socket, deps)` with mocked services.
 *   - CAPTURE the registered handlers from `socket.on.mock.calls`.
 *   - INVOKE representative handlers with sample payloads and assert on:
 *       emitted events + targets, service methods called with args,
 *       state transitions, and ack/callback behaviour.
 *
 * The suite must pass UNCHANGED against the current handler and against the
 * post-decomposition parent + sub-modules.
 */

const registerViewBotHandler = require('../../sockets/ViewBotHandler');

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSocket(id = 'socket-123') {
  const socket = {
    id,
    on: jest.fn(),
    emit: jest.fn(),
    join: jest.fn(),
  };
  return socket;
}

function makeIo() {
  return {
    emit: jest.fn(),
  };
}

/**
 * Build the `deps` bag with jest mocks. A `mediasoupService` with the Maps
 * the handler reaches into directly (`producers`, `transports`).
 */
function makeDeps(overrides = {}) {
  const producers = new Map();
  const transports = new Map();

  const mediasoupService = {
    cleanupSocketResources: jest.fn().mockResolvedValue(undefined),
    producers,
    transports,
    currentStreamer: 'someone',
  };

  const streamService = {
    getCurrentStreamer: jest.fn().mockReturnValue(null),
    clearStreamer: jest.fn(),
  };

  const plainTransportService = {
    cleanup: jest.fn().mockResolvedValue(undefined),
  };

  const lastEmittedStreamReady = { streamerId: null, timestamp: 0 };

  const notifyViewersStreamEnded = jest.fn();

  const viewBotClientService = {
    realStreamerActive: false,
    rotationEnabled: true,
    handleRotationRequest: jest.fn(),
  };
  const getViewBotClientService = jest.fn().mockReturnValue(viewBotClientService);
  const getViewbotService = jest.fn().mockReturnValue({});

  const streamNotifier = {
    streamEnded: jest.fn(),
  };

  return {
    mediasoupService,
    streamService,
    plainTransportService,
    lastEmittedStreamReady,
    notifyViewersStreamEnded,
    getViewBotClientService,
    getViewbotService,
    streamNotifier,
    // expose the inner client service so tests can flip flags
    _viewBotClientService: viewBotClientService,
    ...overrides,
  };
}

/**
 * Register the handler and return a lookup over the captured listeners.
 * `get(event)` returns the FIRST listener; `getAll(event)` returns every
 * listener registered for that event.
 */
function register(io, socket, deps) {
  registerViewBotHandler(io, socket, deps);
  const byEvent = new Map();
  for (const [event, fn] of socket.on.mock.calls) {
    if (!byEvent.has(event)) byEvent.set(event, []);
    byEvent.get(event).push(fn);
  }
  return {
    get: (event) => byEvent.get(event)[0],
    getAll: (event) => byEvent.get(event) || [],
    events: socket.on.mock.calls.map((c) => c[0]),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Registration shape
// ---------------------------------------------------------------------------

describe('ViewBotHandler — registration', () => {
  test('registers the surviving set of viewbot events', () => {
    const io = makeIo();
    const socket = makeSocket();
    const handlers = register(io, socket, makeDeps());

    // PIN: every event name the handler wires, in registration order.
    expect(handlers.events).toEqual([
      'stop-stream',
      'viewbot-stream-ready',
      'viewbot-rotation-request',
      'viewbot-video-ended',
      'viewbot-cleanup-transports',
    ]);
  });
});

// ---------------------------------------------------------------------------
// stop-stream
// ---------------------------------------------------------------------------

describe('ViewBotHandler — stop-stream', () => {
  test('cleans up mediasoup + plain transport for a viewbot, does NOT emit stream-ended', async () => {
    const io = makeIo();
    const socket = makeSocket('streamer-sock');
    const deps = makeDeps();
    deps.streamService.getCurrentStreamer.mockReturnValue('streamer-sock');

    const handlers = register(io, socket, deps);
    await handlers.get('stop-stream')({ isViewBot: true, botId: 'bot1' });

    expect(deps.mediasoupService.cleanupSocketResources).toHaveBeenCalledWith('streamer-sock');
    expect(deps.plainTransportService.cleanup).toHaveBeenCalledWith('bot1');
    // PIN: current streamer cleared + currentStreamer nulled.
    expect(deps.streamService.clearStreamer).toHaveBeenCalledTimes(1);
    expect(deps.mediasoupService.currentStreamer).toBeNull();
    // PIN: viewbot rotation path does NOT broadcast stream-ended.
    expect(deps.streamNotifier.streamEnded).not.toHaveBeenCalled();
    expect(deps.notifyViewersStreamEnded).not.toHaveBeenCalled();
  });

  test('non-viewbot streamer stop emits stream-ended via notifier + notifies viewers', async () => {
    const io = makeIo();
    const socket = makeSocket('real-sock');
    const deps = makeDeps();
    deps.streamService.getCurrentStreamer.mockReturnValue('real-sock');

    const handlers = register(io, socket, deps);
    await handlers.get('stop-stream')({ isViewBot: false });

    // PIN: chokepoint notifier called with reason + previousStreamer.
    expect(deps.streamNotifier.streamEnded).toHaveBeenCalledWith({
      reason: 'stop_stream_request',
      previousStreamer: 'real-sock',
    });
    expect(deps.notifyViewersStreamEnded).toHaveBeenCalledTimes(1);
    // Plain transport cleanup skipped (not a viewbot).
    expect(deps.plainTransportService.cleanup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// viewbot-stream-ready (dedup + gating)
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-stream-ready', () => {
  test('emits stream-ready to io and records dedup state', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();

    const handlers = register(io, socket, deps);
    await handlers.get('viewbot-stream-ready')({ botId: 'bot1' });

    expect(io.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = io.emit.mock.calls[0];
    expect(event).toBe('stream-ready');
    expect(payload).toMatchObject({
      streamerId: 'vb-sock',
      isViewBot: true,
      streamType: 'viewbot',
      botId: 'bot1',
    });
    expect(typeof payload.timestamp).toBe('number');
    // PIN: dedup state mutated in place on the shared object.
    expect(deps.lastEmittedStreamReady.streamerId).toBe('vb-sock');
    expect(deps.lastEmittedStreamReady.timestamp).toBe(payload.timestamp);
  });

  test('skips duplicate emission within the 2s dedup window', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();
    deps.lastEmittedStreamReady.streamerId = 'vb-sock';
    deps.lastEmittedStreamReady.timestamp = Date.now();

    const handlers = register(io, socket, deps);
    await handlers.get('viewbot-stream-ready')({ botId: 'bot1' });

    expect(io.emit).not.toHaveBeenCalled();
  });

  test('blocks emission when a real streamer is active', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();
    deps._viewBotClientService.realStreamerActive = true;

    const handlers = register(io, socket, deps);
    await handlers.get('viewbot-stream-ready')({ botId: 'bot1' });

    expect(io.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// viewbot-rotation-request
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-rotation-request', () => {
  test('on success broadcasts viewbot-rotation-completed with bot transition', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps._viewBotClientService.handleRotationRequest.mockResolvedValue({
      success: true,
      previousBot: 'botA',
      newBot: 'botB',
    });

    const handlers = register(io, socket, deps);
    await handlers.get('viewbot-rotation-request')({ botId: 'botA', reason: 'manual' });

    expect(deps._viewBotClientService.handleRotationRequest).toHaveBeenCalledWith('botA', 'manual');
    expect(io.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = io.emit.mock.calls[0];
    expect(event).toBe('viewbot-rotation-completed');
    expect(payload).toMatchObject({ previousBot: 'botA', newBot: 'botB', reason: 'manual' });
  });

  test('returns early without emitting when rotation is disabled', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps._viewBotClientService.rotationEnabled = false;

    const handlers = register(io, socket, deps);
    await handlers.get('viewbot-rotation-request')({ botId: 'botA', reason: 'manual' });

    expect(deps._viewBotClientService.handleRotationRequest).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// viewbot-video-ended (global.viewBotRotation)
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-video-ended', () => {
  afterEach(() => {
    delete global.viewBotRotation;
  });

  test('triggers rotation + broadcasts viewbot-rotation-after-video-end when enabled', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();

    const rotateToNextBot = jest.fn().mockResolvedValue(undefined);
    global.viewBotRotation = { enabled: true, rotateToNextBot };

    const handlers = register(io, socket, deps);
    await handlers.get('viewbot-video-ended')({ botId: 'botA', videoFile: 'clip.mp4' });

    expect(rotateToNextBot).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = io.emit.mock.calls[0];
    expect(event).toBe('viewbot-rotation-after-video-end');
    expect(payload).toMatchObject({ previousBot: 'botA', previousVideo: 'clip.mp4' });
  });

  test('no-op when rotation disabled', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();

    const rotateToNextBot = jest.fn();
    global.viewBotRotation = { enabled: false, rotateToNextBot };

    const handlers = register(io, socket, deps);
    await handlers.get('viewbot-video-ended')({ botId: 'botA', videoFile: 'clip.mp4' });

    expect(rotateToNextBot).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// viewbot-cleanup-transports
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-cleanup-transports', () => {
  test('closes paired transports + producers found by socketId and deletes map entries', () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();

    const video = { closed: false, close: jest.fn() };
    const audio = { closed: false, close: jest.fn() };
    deps.mediasoupService.transports.set('target-sock', { video, audio, botId: 'bot1' });

    const vprod = { closed: false, close: jest.fn() };
    deps.mediasoupService.producers.set('target-sock', new Map([['video', vprod]]));

    const handlers = register(io, socket, deps);
    handlers.get('viewbot-cleanup-transports')({ botId: 'bot1', socketId: 'target-sock' });

    expect(video.close).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(vprod.close).toHaveBeenCalledTimes(1);
    expect(deps.mediasoupService.transports.has('target-sock')).toBe(false);
    expect(deps.mediasoupService.producers.has('target-sock')).toBe(false);
  });

  test('falls back to lookup by botId when socketId not present', () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();

    const video = { closed: false, close: jest.fn() };
    const audio = { closed: false, close: jest.fn() };
    // Stored under an unrelated key but tagged with the botId.
    deps.mediasoupService.transports.set('other-key', { video, audio, botId: 'bot1' });

    const handlers = register(io, socket, deps);
    handlers.get('viewbot-cleanup-transports')({ botId: 'bot1', socketId: 'missing-sock' });

    expect(video.close).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(deps.mediasoupService.transports.has('other-key')).toBe(false);
  });
});
