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
 *   - CAPTURE the registered handlers from `socket.on.mock.calls`. NOTE the
 *     handler registers TWO listeners for `viewbot-create-webrtc-transport`
 *     (a legacy one taking `(data)` and a modern one taking `(data, callback)`)
 *     — both are captured and asserted independently.
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
    router: {
      createPlainTransport: jest.fn(),
    },
    createWebRtcTransport: jest.fn(),
    createProducer: jest.fn(),
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
 * listener registered for that event (matters for the dual
 * `viewbot-create-webrtc-transport`).
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
  test('registers the full set of viewbot events (with dual webrtc-transport listener)', () => {
    const io = makeIo();
    const socket = makeSocket();
    const handlers = register(io, socket, makeDeps());

    // PIN: every event name the handler wires, in registration order.
    expect(handlers.events).toEqual([
      'viewbot-create-plain-bridge',
      'viewbot-create-webrtc-transport',
      'viewbot-create-plain-transport',
      'stop-stream',
      'viewbot-create-webrtc-transport',
      'viewbot-create-transport',
      'viewbot-webrtc-produce',
      'viewbot-create-producers',
      'viewbot-stream-ready',
      'viewbot-rotation-request',
      'viewbot-video-ended',
      'viewbot-cleanup-transports',
    ]);

    // PIN: two distinct listeners share the webrtc-transport event name.
    expect(handlers.getAll('viewbot-create-webrtc-transport')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// viewbot-create-plain-bridge
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-create-plain-bridge', () => {
  test('creates a plain transport, stores it under botId-kind, acks with port + fixed video ssrc', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps.mediasoupService.router.createPlainTransport.mockResolvedValue({
      tuple: { localPort: 40100 },
    });

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-create-plain-bridge')(
      { botId: 'bot1', producerId: 'p1', kind: 'video', rtpParameters: {} },
      callback,
    );

    expect(deps.mediasoupService.router.createPlainTransport).toHaveBeenCalledTimes(1);
    // PIN: bridge stored under the `${botId}-${kind}` key.
    expect(deps.mediasoupService.plainBridges.get('bot1-video')).toEqual({
      tuple: { localPort: 40100 },
    });
    // PIN: fixed video SSRC 11111111 + the listen port returned to caller.
    expect(callback).toHaveBeenCalledWith({
      success: true,
      rtpPort: 40100,
      ssrc: 11111111,
    });
  });

  test('uses fixed audio ssrc 22222222 for audio kind', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps.mediasoupService.router.createPlainTransport.mockResolvedValue({
      tuple: { localPort: 40200 },
    });

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-create-plain-bridge')(
      { botId: 'bot1', kind: 'audio' },
      callback,
    );

    expect(callback).toHaveBeenCalledWith({
      success: true,
      rtpPort: 40200,
      ssrc: 22222222,
    });
  });

  test('acks failure with error message on createPlainTransport throw', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps.mediasoupService.router.createPlainTransport.mockRejectedValue(new Error('boom'));

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-create-plain-bridge')({ botId: 'bot1', kind: 'video' }, callback);

    expect(callback).toHaveBeenCalledWith({ success: false, error: 'boom' });
  });
});

// ---------------------------------------------------------------------------
// viewbot-create-webrtc-transport (legacy, first listener — takes (data))
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-create-webrtc-transport (legacy)', () => {
  test('creates transport + producer, emits viewbot-producer-created with transport options', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();

    const transportOptions = {
      id: 'tx-legacy',
      iceParameters: { i: 1 },
      iceCandidates: [{ c: 1 }],
      dtlsParameters: { d: 1 },
    };
    deps.mediasoupService.createWebRtcTransport.mockResolvedValue(transportOptions);

    const producer = { id: 'prod-legacy', appData: {} };
    const transport = { produce: jest.fn().mockResolvedValue(producer) };
    // The legacy handler looks the transport up under `viewbot-<botId>-<kind>`.
    deps.mediasoupService.transports.set('viewbot-bot1-video', transport);

    const handlers = register(io, socket, deps);
    const legacy = handlers.getAll('viewbot-create-webrtc-transport')[0];
    await legacy({ botId: 'bot1', kind: 'video', rtpParameters: { r: 1 } });

    // PIN: transport created with the `viewbot-<botId>-<kind>` key.
    expect(deps.mediasoupService.createWebRtcTransport).toHaveBeenCalledWith('viewbot-bot1-video');
    // PIN: producer produced on that transport with passed rtpParameters.
    expect(transport.produce).toHaveBeenCalledWith({
      kind: 'video',
      rtpParameters: { r: 1 },
      paused: false,
      appData: { isViewBot: true, botId: 'bot1' },
    });
    // PIN: success emit carries producer + ICE/DTLS details and rtpPort 0.
    expect(socket.emit).toHaveBeenCalledWith('viewbot-producer-created', {
      botId: 'bot1',
      kind: 'video',
      producerId: 'prod-legacy',
      transportId: 'tx-legacy',
      iceParameters: { i: 1 },
      iceCandidates: [{ c: 1 }],
      dtlsParameters: { d: 1 },
      rtpPort: 0,
    });
  });

  test('emits viewbot-producer-error when transport missing after creation', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps.mediasoupService.createWebRtcTransport.mockResolvedValue({ id: 'tx' });
    // Do NOT seed transports map → "Transport not found after creation".

    const handlers = register(io, socket, deps);
    const legacy = handlers.getAll('viewbot-create-webrtc-transport')[0];
    await legacy({ botId: 'bot1', kind: 'video', rtpParameters: {} });

    expect(socket.emit).toHaveBeenCalledWith('viewbot-producer-error', {
      botId: 'bot1',
      kind: 'video',
      error: 'Transport not found after creation',
    });
  });
});

// ---------------------------------------------------------------------------
// viewbot-create-webrtc-transport (modern, second listener — takes (data, cb))
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-create-webrtc-transport (modern)', () => {
  test('creates transport under socket.id (non-producing) and acks transportOptions', async () => {
    const io = makeIo();
    const socket = makeSocket('socket-xyz');
    const deps = makeDeps();
    const transportOptions = { id: 'tx-modern', iceCandidates: [1, 2] };
    deps.mediasoupService.createWebRtcTransport.mockResolvedValue(transportOptions);

    const handlers = register(io, socket, deps);
    const modern = handlers.getAll('viewbot-create-webrtc-transport')[1];
    const callback = jest.fn();
    await modern({ botId: 'bot1' }, callback);

    // PIN: modern variant uses socket.id and the (id, false) signature.
    expect(deps.mediasoupService.createWebRtcTransport).toHaveBeenCalledWith('socket-xyz', false);
    expect(callback).toHaveBeenCalledWith({ success: true, transportOptions });
  });

  test('acks failure on transport creation error', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps.mediasoupService.createWebRtcTransport.mockRejectedValue(new Error('no-tx'));

    const handlers = register(io, socket, deps);
    const modern = handlers.getAll('viewbot-create-webrtc-transport')[1];
    const callback = jest.fn();
    await modern({ botId: 'bot1' }, callback);

    expect(callback).toHaveBeenCalledWith({ success: false, error: 'no-tx' });
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
// viewbot-create-transport (paired plain RTP / LiveKit branch)
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-create-transport', () => {
  test('mediasoup path: creates paired video+audio transports, stores under socket.id, acks ports', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();

    const videoTransport = { id: 'vtx', tuple: { localPort: 5001 } };
    const audioTransport = { id: 'atx', tuple: { localPort: 5002 } };
    deps.mediasoupService.router.createPlainTransport
      .mockResolvedValueOnce(videoTransport)
      .mockResolvedValueOnce(audioTransport);

    const prevAdapter = process.env.USE_WEBRTC_ADAPTER;
    delete process.env.USE_WEBRTC_ADAPTER;

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-create-transport')({ botId: 'bot1' }, callback);

    if (prevAdapter === undefined) delete process.env.USE_WEBRTC_ADAPTER;
    else process.env.USE_WEBRTC_ADAPTER = prevAdapter;

    expect(deps.mediasoupService.router.createPlainTransport).toHaveBeenCalledTimes(2);
    // PIN: paired transports stored under socket.id with botId tag.
    expect(deps.mediasoupService.transports.get('vb-sock')).toEqual({
      video: videoTransport,
      audio: audioTransport,
      botId: 'bot1',
    });
    expect(callback).toHaveBeenCalledWith({
      videoTransportId: 'vtx',
      audioTransportId: 'atx',
      videoPort: 5001,
      audioPort: 5002,
    });
  });

  test('livekit path: returns useLiveKit ack with token + whipUrl, no plain transports created', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();

    const prevAdapter = process.env.USE_WEBRTC_ADAPTER;
    const prevBackend = process.env.WEBRTC_BACKEND;
    process.env.USE_WEBRTC_ADAPTER = 'true';
    process.env.WEBRTC_BACKEND = 'livekit';

    const generateToken = jest.fn().mockResolvedValue('lk-token');
    global.webrtcAdapter = { _backend: { generateToken } };

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-create-transport')({ botId: 'bot1' }, callback);

    // restore env / global
    if (prevAdapter === undefined) delete process.env.USE_WEBRTC_ADAPTER;
    else process.env.USE_WEBRTC_ADAPTER = prevAdapter;
    if (prevBackend === undefined) delete process.env.WEBRTC_BACKEND;
    else process.env.WEBRTC_BACKEND = prevBackend;
    delete global.webrtcAdapter;

    expect(generateToken).toHaveBeenCalledWith('bot1', {
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
    });
    expect(callback).toHaveBeenCalledWith({
      useLiveKit: true,
      token: 'lk-token',
      whipUrl: 'https://onestreamer.live/livekit/rtc',
      message: 'Use LiveKit GStreamer pipeline with whipsink',
    });
    // PIN: LiveKit branch short-circuits before creating plain transports.
    expect(deps.mediasoupService.router.createPlainTransport).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// viewbot-webrtc-produce (priority gating)
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-webrtc-produce', () => {
  test('blocks when a real streamer is active', async () => {
    const io = makeIo();
    const socket = makeSocket();
    const deps = makeDeps();
    deps._viewBotClientService.realStreamerActive = true;

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-webrtc-produce')({ botId: 'bot1' }, callback);

    expect(callback).toHaveBeenCalledWith({
      success: false,
      error: 'Real streamer is active - viewbot creation blocked',
    });
    expect(deps.mediasoupService.createProducer).not.toHaveBeenCalled();
  });

  test('blocks when a url-stream is the current streamer', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();
    deps.streamService.getCurrentStreamer.mockReturnValue('url-stream-99');

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-webrtc-produce')({ botId: 'bot1' }, callback);

    expect(callback).toHaveBeenCalledWith({
      success: false,
      error: 'URL stream is active - viewbot creation blocked',
    });
  });

  test('creates video + audio producers and acks their ids when not blocked', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();
    deps.mediasoupService.transports.set('vb-sock', { /* truthy transport */ id: 'tx' });
    deps.mediasoupService.createProducer
      .mockResolvedValueOnce({ producer: { id: 'vprod', appData: {} } })
      .mockResolvedValueOnce({ producer: { id: 'aprod', appData: {} } });

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-webrtc-produce')({ botId: 'bot1' }, callback);

    expect(deps.mediasoupService.createProducer).toHaveBeenCalledTimes(2);
    // PIN: producers created against socket.id with kind labels.
    expect(deps.mediasoupService.createProducer.mock.calls[0][0]).toBe('vb-sock');
    expect(deps.mediasoupService.createProducer.mock.calls[0][2]).toBe('video');
    expect(deps.mediasoupService.createProducer.mock.calls[1][2]).toBe('audio');
    expect(callback).toHaveBeenCalledWith({
      success: true,
      videoProducerId: 'vprod',
      audioProducerId: 'aprod',
    });
  });
});

// ---------------------------------------------------------------------------
// viewbot-create-producers
// ---------------------------------------------------------------------------

describe('ViewBotHandler — viewbot-create-producers', () => {
  test('produces video+audio on paired transports and acks producer ids', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();

    const videoProducer = { id: 'vp' };
    const audioProducer = { id: 'ap' };
    const videoT = { produce: jest.fn().mockResolvedValue(videoProducer) };
    const audioT = { produce: jest.fn().mockResolvedValue(audioProducer) };
    deps.mediasoupService.transports.set('vb-sock', { video: videoT, audio: audioT });

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-create-producers')({ botId: 'bot1' }, callback);

    expect(videoT.produce).toHaveBeenCalledTimes(1);
    expect(audioT.produce).toHaveBeenCalledTimes(1);
    // PIN: producers stored under socket.id keyed by kind.
    const stored = deps.mediasoupService.producers.get('vb-sock');
    expect(stored.get('video')).toBe(videoProducer);
    expect(stored.get('audio')).toBe(audioProducer);
    expect(callback).toHaveBeenCalledWith({
      success: true,
      videoProducerId: 'vp',
      audioProducerId: 'ap',
    });
  });

  test('acks error when paired transports are missing', async () => {
    const io = makeIo();
    const socket = makeSocket('vb-sock');
    const deps = makeDeps();
    // No transports seeded → "Transports not found".

    const handlers = register(io, socket, deps);
    const callback = jest.fn();
    await handlers.get('viewbot-create-producers')({ botId: 'bot1' }, callback);

    expect(callback).toHaveBeenCalledWith({ error: 'Transports not found' });
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
