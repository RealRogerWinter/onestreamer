/**
 * StreamHandler — characterization tests.
 *
 * StreamHandler registers per-connection socket.io listeners for the
 * streaming/takeover lifecycle. Unlike AdminHandler (which boots a real
 * socket.io server), StreamHandler pulls in ~25 injected services and shared
 * mutable state, so this suite uses mock `io` / `socket` objects: we call the
 * registration function with fully-mocked deps, CAPTURE the registered
 * handlers from `socket.on.mock.calls`, then INVOKE representative handlers
 * with sample payloads and PIN the observable behavior — which events get
 * emitted (and to whom), which service methods are called with which args,
 * the room join/leave transitions, and the ack/callback contract.
 *
 * This is a CHARACTERIZATION test: it pins CURRENT behavior so a later
 * decomposition (splitting StreamHandler into sub-handler modules) stays
 * byte-for-byte behavior-equivalent. It asserts nothing about correctness.
 */

const registerStreamHandler = require('../../sockets/StreamHandler');

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

/**
 * Build a mock `io`. `io.to(id)` and `socket.to(id)` return an object whose
 * `.emit` is a shared jest.fn so a test can read every targeted emit, tagged
 * with the room id passed to `.to(...)`.
 */
function makeIo() {
  const toEmit = jest.fn();
  const toCalls = [];
  const io = {
    emit: jest.fn(),
    to: jest.fn((roomId) => {
      toCalls.push(roomId);
      return { emit: (...args) => toEmit(roomId, ...args) };
    }),
    sockets: { sockets: new Map() },
  };
  io._toEmit = toEmit;
  io._toCalls = toCalls;
  return io;
}

function makeSocket(id = 'socket-streamer-1') {
  const toEmit = jest.fn();
  const socket = {
    id,
    connected: true,
    rooms: new Set(),
    handshake: { headers: { 'user-agent': 'jest-UA' }, auth: {} },
    conn: { transport: { name: 'websocket' } },
    on: jest.fn(),
    emit: jest.fn(),
    join: jest.fn((room) => socket.rooms.add(room)),
    leave: jest.fn((room) => socket.rooms.delete(room)),
    to: jest.fn((roomId) => ({ emit: (...args) => toEmit(roomId, ...args) })),
    volatile: { emit: jest.fn() },
    disconnect: jest.fn(),
  };
  socket._toEmit = toEmit;
  return socket;
}

/**
 * Build a complete deps bag with jest.fn mocks. Reasonable defaults are wired
 * so the "happy path" of each handler runs without throwing; individual tests
 * override specific return values.
 */
function makeDeps(overrides = {}) {
  const streamService = {
    addViewer: jest.fn(),
    getStreamStatus: jest.fn(() => ({ hasActiveStream: false, viewerCount: 0 })),
    getCurrentStreamer: jest.fn(() => null),
    setStreamer: jest.fn(),
    clearStreamer: jest.fn(),
    // T2: pass-through by default; the serialization tests swap in the real
    // promise-chain implementation.
    takeoverInProgress: false,
    runExclusiveTakeover: jest.fn((task) => task()),
  };
  const sessionService = {
    getUniqueViewerCount: jest.fn(() => 7),
    getIpAddress: jest.fn(() => '1.2.3.4'),
    getSessionByIp: jest.fn(() => null),
    getSessionBySocketId: jest.fn(() => null),
    getUserIdBySocketId: jest.fn(() => null),
    linkUserToSocket: jest.fn(),
  };
  const takeoverService = {
    canTakeOver: jest.fn(async () => ({ allowed: true })),
    setSocketCooldown: jest.fn(async () => {}),
    getSocketCooldown: jest.fn(async () => ({ remaining: 30 })),
    getCooldownSeconds: jest.fn(() => 60),
    recordTakeover: jest.fn(async () => {}),
  };
  const webrtcService = {
    cleanup: jest.fn(),
    currentStreamer: null,
    producers: new Map(),
  };
  const testStreamService = {
    getTestStreamStatus: jest.fn(() => ({ isActive: false })),
    startTestStream: jest.fn(() => ({ success: true, streamId: 'test-stream-1' })),
  };
  const timeTrackingService = {
    startViewingSession: jest.fn(),
    endViewingSession: jest.fn(async () => {}),
    startStreamingSession: jest.fn(),
    endStreamingSession: jest.fn(async () => {}),
  };
  const buffDebuffService = {
    getActiveBuffsForCurrentStreamer: jest.fn(async () => []),
  };
  const streamingLogsService = {
    startSession: jest.fn(async () => {}),
    endSession: jest.fn(async () => {}),
  };
  const SimpleViewBotRotation = {
    stopRotation: jest.fn(async () => {}),
    startRotation: jest.fn(async () => {}),
  };
  const IPBanService = {
    getIPFromSocket: jest.fn(() => '1.2.3.4'),
    isIPBanned: jest.fn(async () => false),
  };
  const notifiedStreamers = new Set();
  const viewbotSocketIds = new Set();
  const lastEmittedStreamReady = { streamerId: null, timestamp: 0 };
  // ViewbotService is now stateless under LiveKit — only isViewbotStream
  // survives (the creation/streaming half was removed). The takeover/
  // request-test-stream handlers no longer call start/stop/handleTakeover/
  // updateViewbotConfig/getViewbotStatus.
  const viewbotService = {
    isViewbotStream: jest.fn(() => false),
  };
  // Optional Discord live-announcement bot. announceStreamLive is fire-and-forget
  // (never throws / returns a promise); the guard in takeover.js calls it only
  // for real human streamers.
  const discordBotService = {
    announceStreamLive: jest.fn(() => Promise.resolve(true)),
  };
  const deps = {
    streamService,
    sessionService,
    takeoverService,
    webrtcService,
    testStreamService,
    timeTrackingService,
    buffDebuffService,
    streamingLogsService,
    SimpleViewBotRotation,
    IPBanService,
    notifiedStreamers,
    viewbotSocketIds,
    lastEmittedStreamReady,
    getViewbotService: jest.fn(() => viewbotService),
    enrichStreamStatus: jest.fn(async (status) => ({ ...status, streamerDisplayName: 'Display Name' })),
    getStreamerDisplayName: jest.fn(async () => 'Display Name'),
    notifyViewersStreamStarted: jest.fn(),
    notifyViewersStreamEnded: jest.fn(),
    broadcastGlobalCooldown: jest.fn(async () => {}),
    runAsync: jest.fn(async () => {}),
    database: { allAsync: jest.fn(async () => []) },
    axios: { post: jest.fn(() => ({ then: () => ({ catch: () => {} }) })) },
    https: { Agent: jest.fn(function Agent() {}) },
    streamNotifier: { streamEnded: jest.fn() },
    viewerCountNotifier: { broadcast: jest.fn() },
    buffNotifier: { streamerBuffsUpdate: jest.fn() },
    discordBotService,
    // expose the lazy-resolved instances for assertions
    _viewbotService: viewbotService,
  };

  return Object.assign(deps, overrides);
}

/**
 * Register the handler against a fresh mock io/socket/deps and return a
 * lookup helper to fetch a handler fn by event name.
 */
function register(overrides = {}) {
  const io = makeIo();
  const socket = makeSocket(overrides.socketId || 'socket-streamer-1');
  const deps = makeDeps(overrides.deps || {});
  registerStreamHandler(io, socket, deps);

  const handlers = {};
  for (const [event, fn] of socket.on.mock.calls) {
    handlers[event] = fn;
  }
  return { io, socket, deps, handlers };
}

// Quiet timers so request-to-stream's setTimeout fan-out doesn't leak.
jest.useFakeTimers({ doNotFake: ['nextTick'] });

describe('sockets/StreamHandler characterization', () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  // -------------------------------------------------------------------------
  // Registration shape
  // -------------------------------------------------------------------------
  describe('registration', () => {
    test('registers exactly the expected event listeners', () => {
      const { socket } = register();
      const events = socket.on.mock.calls.map((c) => c[0]);
      expect(events).toEqual([
        'join-as-viewer',
        'request-to-stream',
        'stop-streaming',
        'request-test-stream',
      ]);
    });

    test('every registered handler is a function', () => {
      const { socket } = register();
      for (const [, fn] of socket.on.mock.calls) {
        expect(typeof fn).toBe('function');
      }
    });
  });

  // -------------------------------------------------------------------------
  // join-as-viewer
  // -------------------------------------------------------------------------
  describe('join-as-viewer', () => {
    test('adds viewer, joins room, emits enriched stream-status with IP viewer count', async () => {
      const { socket, deps, handlers } = register();
      await handlers['join-as-viewer']();

      expect(deps.streamService.addViewer).toHaveBeenCalledWith('socket-streamer-1');
      expect(socket.join).toHaveBeenCalledWith('viewers');

      const statusCall = socket.emit.mock.calls.find((c) => c[0] === 'stream-status');
      expect(statusCall).toBeDefined();
      // viewerCount overridden with IP-based unique count (7), and enriched.
      expect(statusCall[1].viewerCount).toBe(7);
      expect(statusCall[1].streamerDisplayName).toBe('Display Name');

      // viewer-count chokepoint fired.
      expect(deps.viewerCountNotifier.broadcast).toHaveBeenCalledTimes(1);
    });

    test('starts viewing time tracking only when an authenticated session exists', async () => {
      const { deps, handlers } = register();
      deps.sessionService.getSessionByIp.mockReturnValue({ userId: 42 });
      deps.streamService.getStreamStatus.mockReturnValue({ hasActiveStream: true, viewerCount: 0 });

      await handlers['join-as-viewer']();

      expect(deps.timeTrackingService.startViewingSession).toHaveBeenCalledWith(42, 'socket-streamer-1', true);
    });

    test('emits global-cooldown when the viewer is on cooldown', async () => {
      const { socket, deps, handlers } = register();
      deps.takeoverService.canTakeOver.mockResolvedValue({
        allowed: false,
        reason: 'individual',
        cooldownRemaining: 12,
      });

      await handlers['join-as-viewer']();

      const cd = socket.emit.mock.calls.find((c) => c[0] === 'global-cooldown');
      expect(cd).toBeDefined();
      expect(cd[1]).toEqual({ cooldownRemaining: 12, reason: 'individual' });
    });
  });

  // -------------------------------------------------------------------------
  // request-to-stream
  // -------------------------------------------------------------------------
  describe('request-to-stream', () => {
    test('webcam request without permission is denied; callback(false); no streamer set', async () => {
      const { socket, deps, handlers } = register();
      const callback = jest.fn();

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: false }, callback);

      const denied = socket.emit.mock.calls.find((c) => c[0] === 'stream-denied');
      expect(denied).toBeDefined();
      expect(denied[1].requiresPermissions).toBe(true);
      expect(callback).toHaveBeenCalledWith(false);
      expect(deps.streamService.setStreamer).not.toHaveBeenCalled();
    });

    test('banned IP is denied with callback(false)', async () => {
      const { socket, deps, handlers } = register();
      deps.IPBanService.isIPBanned.mockResolvedValue(true);
      const callback = jest.fn();

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true }, callback);

      const denied = socket.emit.mock.calls.find((c) => c[0] === 'stream-denied');
      expect(denied).toBeDefined();
      expect(denied[1].reason).toMatch(/banned/i);
      expect(callback).toHaveBeenCalledWith(false);
      expect(deps.streamService.setStreamer).not.toHaveBeenCalled();
    });

    test('fresh real-user start: acks(true), sets streamer, joins streamer room, records takeover, emits streaming-approved', async () => {
      const { io, socket, deps, handlers } = register();
      const callback = jest.fn();

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true }, callback);

      // ack sent
      expect(callback).toHaveBeenCalledWith(true);

      // streamer state set in both services
      expect(deps.streamService.setStreamer).toHaveBeenCalledWith('socket-streamer-1', 'webcam');
      expect(deps.webrtcService.currentStreamer).toBe('socket-streamer-1');

      // room transition
      expect(socket.join).toHaveBeenCalledWith('streamer');
      expect(socket.leave).toHaveBeenCalledWith('viewers');

      // real user -> records takeover + broadcasts global cooldown
      expect(deps.takeoverService.recordTakeover).toHaveBeenCalledTimes(1);
      expect(deps.broadcastGlobalCooldown).toHaveBeenCalledWith('socket-streamer-1');

      // streaming-approved emitted to the streamer
      const approved = socket.emit.mock.calls.find((c) => c[0] === 'streaming-approved');
      expect(approved).toBeDefined();

      // global stream-status broadcast
      expect(io.emit).toHaveBeenCalledWith('stream-status', expect.objectContaining({ streamerDisplayName: 'Display Name' }));

      // real user pauses nothing extra here, but logs a streaming session
      expect(deps.streamingLogsService.startSession).toHaveBeenCalledTimes(1);
    });

    test('viewbot cannot take over a real streamer: emits takeover-denied, no setStreamer', async () => {
      const { socket, deps, handlers } = register();
      // current streamer is a real user (positive userId, not a viewbot)
      deps.streamService.getCurrentStreamer.mockReturnValue('real-streamer-2');
      deps.sessionService.getUserIdBySocketId.mockReturnValue(99);
      deps._viewbotService.isViewbotStream.mockReturnValue(false);

      await handlers['request-to-stream']({ isViewBot: true, streamType: 'viewbot' });

      const denied = socket.emit.mock.calls.find((c) => c[0] === 'takeover-denied');
      expect(denied).toBeDefined();
      expect(denied[1].reason).toMatch(/Real streamer has priority/i);
      expect(deps.streamService.setStreamer).not.toHaveBeenCalled();
    });

    test('real user takes over a real streamer: cooldown set, stream-takeover + stream-ended via notifier, mediasoup cleanup', async () => {
      const { io, socket, deps, handlers } = register();
      deps.streamService.getCurrentStreamer.mockReturnValue('real-streamer-2');
      deps.sessionService.getUserIdBySocketId.mockReturnValue(99);
      deps._viewbotService.isViewbotStream.mockReturnValue(false);
      // previous streamer socket present so leave('streamer') + force-disconnect fire
      const prevSocket = { leave: jest.fn(), emit: jest.fn() };
      io.sockets.sockets.set('real-streamer-2', prevSocket);

      // (T2 removed the 200ms viewer-cleanup sleep, so the handler settles
      // without advancing fake timers.)
      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      // cooldown applied to the taken-over streamer
      expect(deps.takeoverService.setSocketCooldown).toHaveBeenCalledWith('real-streamer-2', 'stream_taken_over');

      // stream-takeover emitted to the previous streamer
      const takeoverEmit = io._toEmit.mock.calls.find((c) => c[1] === 'stream-takeover');
      expect(takeoverEmit).toBeDefined();
      expect(takeoverEmit[0]).toBe('real-streamer-2');
      expect(takeoverEmit[2].newStreamerId).toBe('socket-streamer-1');

      // previous streamer removed from streamer room + force-disconnect
      expect(prevSocket.leave).toHaveBeenCalledWith('streamer');
      const fd = prevSocket.emit.mock.calls.find((c) => c[0] === 'force-disconnect');
      expect(fd).toBeDefined();

      // stream-ended chokepoint fired with takeover reason + excludeSocket = new streamer
      expect(deps.streamNotifier.streamEnded).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'takeover', excludeSocket: socket, previousStreamer: 'real-streamer-2' })
      );

      // mediasoup cleanup for the previous streamer
      expect(deps.webrtcService.cleanup).toHaveBeenCalledWith('real-streamer-2');
    });

    // V3 (audit Plan 06): a url-stream-* current streamer is a URL relay —
    // the takeover must stop the relay pipeline itself (previously it fell
    // into the real-user branch: cooldown on a fake socket id, relay's
    // FFmpeg→ingress left publishing over the human).
    test('real user takes over a URL relay: stopURLStream + rotation stop, no fake-socket cooldown', async () => {
      const { io, deps, handlers } = register();
      deps.streamService.getCurrentStreamer.mockReturnValue('url-stream-555');
      deps.sessionService.getUserIdBySocketId.mockReturnValue(null);
      deps._viewbotService.isViewbotStream.mockReturnValue(false);
      global.viewBotURLService = {
        stopURLStream: jest.fn(async () => ({ success: true })),
      };

      try {
        await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

        expect(global.viewBotURLService.stopURLStream).toHaveBeenCalledWith('url-stream-555');
        expect(deps.SimpleViewBotRotation.stopRotation).toHaveBeenCalled();
        // The relay id must NOT be treated as an ousted real user.
        expect(deps.takeoverService.setSocketCooldown).not.toHaveBeenCalledWith(
          'url-stream-555', 'stream_taken_over'
        );
        // The human still becomes the streamer.
        expect(deps.streamService.setStreamer).toHaveBeenCalledWith('socket-streamer-1', 'webcam');
      } finally {
        delete global.viewBotURLService;
      }
    });

    // T3 (economy half): the ousted streamer's time-tracking session must end
    // AT the takeover — their socket deliberately stays connected (never hits
    // DisconnectHandler), so nothing else ends it and they kept earning
    // streaming points until the 1-hour stale sweep.
    test('takeover ends the ousted authenticated streamer\'s time-tracking session', async () => {
      const { io, deps, handlers } = register();
      deps.streamService.getCurrentStreamer.mockReturnValue('real-streamer-2');
      // ousted streamer is authenticated user 99; new streamer resolves null
      deps.sessionService.getUserIdBySocketId.mockImplementation((sid) =>
        sid === 'real-streamer-2' ? 99 : null);
      deps._viewbotService.isViewbotStream.mockReturnValue(false);
      io.sockets.sockets.set('real-streamer-2', { leave: jest.fn(), emit: jest.fn() });

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      expect(deps.timeTrackingService.endStreamingSession).toHaveBeenCalledWith(99);
    });

    test('takeover of an ANONYMOUS streamer does not call endStreamingSession', async () => {
      const { io, deps, handlers } = register();
      deps.streamService.getCurrentStreamer.mockReturnValue('anon-streamer');
      deps.sessionService.getUserIdBySocketId.mockReturnValue(null);
      deps._viewbotService.isViewbotStream.mockReturnValue(false);
      io.sockets.sockets.set('anon-streamer', { leave: jest.fn(), emit: jest.fn() });

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      expect(deps.timeTrackingService.endStreamingSession).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Discord live-announcement guard (real human streamers ONLY)
    // -----------------------------------------------------------------------
    test('real authenticated go-live posts a Discord announcement with the user id', async () => {
      const { deps, handlers } = register();
      deps.sessionService.getUserIdBySocketId.mockReturnValue(42);

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      expect(deps.discordBotService.announceStreamLive).toHaveBeenCalledTimes(1);
      expect(deps.discordBotService.announceStreamLive.mock.calls[0][0]).toEqual(
        expect.objectContaining({ displayName: 'Display Name', userId: 42, isTakeover: false })
      );
    });

    test('anonymous human go-live posts a Discord announcement with userId null', async () => {
      const { deps, handlers } = register();
      // default getUserIdBySocketId() → null (guest)

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      expect(deps.discordBotService.announceStreamLive).toHaveBeenCalledTimes(1);
      expect(deps.discordBotService.announceStreamLive.mock.calls[0][0].userId).toBeNull();
    });

    test('viewbot go-live does NOT post a Discord announcement', async () => {
      const { deps, handlers } = register();

      await handlers['request-to-stream']({ isViewBot: true, streamType: 'viewbot' });

      expect(deps.discordBotService.announceStreamLive).not.toHaveBeenCalled();
    });

    test('a url-stream- socket id does NOT post a Discord announcement (prefix guard)', async () => {
      const { deps, handlers } = register({ socketId: 'url-stream-12345' });

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      expect(deps.discordBotService.announceStreamLive).not.toHaveBeenCalled();
    });

    test('a viewbot- prefixed socket id does NOT post a Discord announcement (prefix guard)', async () => {
      const { deps, handlers } = register({ socketId: 'viewbot-987' });

      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      expect(deps.discordBotService.announceStreamLive).not.toHaveBeenCalled();
    });

    test('viewbot start: emits stream-ready (io-wide), tracks socket id, links synthetic negative userId, no recordTakeover', async () => {
      const { io, deps, handlers } = register();

      await handlers['request-to-stream']({ isViewBot: true, streamType: 'viewbot' });

      // tracked as a viewbot
      expect(deps.viewbotSocketIds.has('socket-streamer-1')).toBe(true);

      // synthetic negative user id linked
      const linkCall = deps.sessionService.linkUserToSocket.mock.calls.find((c) => c[0] === 'socket-streamer-1');
      expect(linkCall).toBeDefined();
      expect(linkCall[1]).toBeLessThan(0);

      // io-wide stream-ready emitted for viewbot
      const readyEmit = io.emit.mock.calls.find((c) => c[0] === 'stream-ready');
      expect(readyEmit).toBeDefined();
      expect(readyEmit[1].isViewBot).toBe(true);
      expect(readyEmit[1].streamType).toBe('viewbot');

      // dedupe state mutated in place
      expect(deps.lastEmittedStreamReady.streamerId).toBe('socket-streamer-1');

      // viewbots bypass takeover recording + global cooldown
      expect(deps.takeoverService.recordTakeover).not.toHaveBeenCalled();
      expect(deps.broadcastGlobalCooldown).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // T2 (ADR-0033): takeover serialization
  // -------------------------------------------------------------------------
  describe('request-to-stream serialization (T2)', () => {
    // Use the REAL StreamService serialization primitive so these tests pin
    // the actual chain semantics, not a mock's.
    const StreamService = require('../../services/StreamService');

    function makeSerializedDeps() {
      const real = new StreamService();
      return {
        deps: {
          streamService: {
            addViewer: jest.fn(),
            getStreamStatus: jest.fn(() => ({ hasActiveStream: false, viewerCount: 0 })),
            getCurrentStreamer: jest.fn(() => null),
            setStreamer: jest.fn(),
            clearStreamer: jest.fn(),
            takeoverInProgress: false,
            runExclusiveTakeover: (task) => real.runExclusiveTakeover(task),
          },
        },
        real,
      };
    }

    afterEach(() => {
      delete global.randomStreamRotationService;
    });

    test('two concurrent request-to-stream invocations run serialized (second waits for first recordTakeover)', async () => {
      const { deps: depsOverride } = makeSerializedDeps();
      const a = register({ socketId: 'socket-A', deps: depsOverride });

      // First handler blocks inside the critical section on canTakeOver.
      let releaseFirst;
      const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
      a.deps.takeoverService.canTakeOver
        .mockImplementationOnce(async () => { await firstGate; return { allowed: true }; })
        .mockImplementationOnce(async () => ({ allowed: false, reason: 'global_cooldown', cooldownRemaining: 30 }));

      const first = a.handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });
      const second = a.handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      // Give the second handler every chance to run ahead — it must not have
      // entered canTakeOver while the first holds the section.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(a.deps.takeoverService.canTakeOver).toHaveBeenCalledTimes(1);

      releaseFirst();
      await first;
      await second;

      // Second re-ran canTakeOver after the first finished and was denied.
      expect(a.deps.takeoverService.canTakeOver).toHaveBeenCalledTimes(2);
      expect(a.deps.streamService.setStreamer).toHaveBeenCalledTimes(1);
      expect(a.deps.takeoverService.recordTakeover).toHaveBeenCalledTimes(1);
      const denied = a.socket.emit.mock.calls.find((c) => c[0] === 'takeover-denied');
      expect(denied).toBeDefined();
      expect(denied[1].reason).toBe('global_cooldown');
    });

    test('rotation pause happens BEFORE setStreamer for a real user', async () => {
      const { deps: depsOverride } = makeSerializedDeps();
      const pause = jest.fn(async () => {});
      global.randomStreamRotationService = { isEnabled: true, pause };

      const { deps, handlers } = register({ deps: depsOverride });
      await handlers['request-to-stream']({ streamType: 'webcam', permissionsGranted: true });

      expect(pause).toHaveBeenCalledTimes(1);
      expect(deps.streamService.setStreamer).toHaveBeenCalledTimes(1);
      expect(pause.mock.invocationCallOrder[0])
        .toBeLessThan(deps.streamService.setStreamer.mock.invocationCallOrder[0]);
    });

    test('takeoverInProgress is set during the section and cleared after, including on throw', async () => {
      const real = new StreamService();
      const observed = [];

      await real.runExclusiveTakeover(async () => {
        observed.push(real.takeoverInProgress);
      });
      expect(observed).toEqual([true]);
      expect(real.takeoverInProgress).toBe(false);

      await expect(real.runExclusiveTakeover(async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect(real.takeoverInProgress).toBe(false);

      // The chain is not wedged by the rejection.
      const ran = await real.runExclusiveTakeover(async () => 'ok');
      expect(ran).toBe('ok');
    });
  });


  // -------------------------------------------------------------------------
  // stop-streaming
  // -------------------------------------------------------------------------
  describe('stop-streaming', () => {
    test('no-op when the socket is not the current streamer', async () => {
      const { deps, handlers } = register();
      deps.streamService.getCurrentStreamer.mockReturnValue('someone-else');

      await handlers['stop-streaming']();

      expect(deps.streamService.clearStreamer).not.toHaveBeenCalled();
      expect(deps.streamNotifier.streamEnded).not.toHaveBeenCalled();
    });

    test('active streamer stop: applies cooldown, clears streamer, ends sessions, broadcasts stream-ended', async () => {
      const { deps, handlers } = register();
      deps.streamService.getCurrentStreamer.mockReturnValue('socket-streamer-1');
      deps.sessionService.getSessionByIp.mockReturnValue({ userId: 42 });

      await handlers['stop-streaming']();

      // individual cooldown for voluntary stop
      expect(deps.takeoverService.setSocketCooldown).toHaveBeenCalledWith('socket-streamer-1', 'voluntary_stream_end');

      // streamer cleared in both services
      expect(deps.streamService.clearStreamer).toHaveBeenCalledTimes(1);
      expect(deps.webrtcService.currentStreamer).toBeNull();

      // streaming log + streaming time tracking ended
      expect(deps.streamingLogsService.endSession).toHaveBeenCalledWith('socket-streamer-1', 'voluntary_stop');
      expect(deps.timeTrackingService.endStreamingSession).toHaveBeenCalledWith(42);

      // streamer buffs cleared
      expect(deps.buffNotifier.streamerBuffsUpdate).toHaveBeenCalledWith({ buffs: [] });

      // stream-ended chokepoint with voluntary reason
      expect(deps.streamNotifier.streamEnded).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'user_stopped_streaming', previousStreamer: 'socket-streamer-1' })
      );

      // (Recording finalisation on stream-end was removed with ADR-0024 —
      // the MediaSoup-era RecordingService is gone; LiveKit egress stops
      // automatically when the publisher leaves the room.)
    });
  });

  // -------------------------------------------------------------------------
  // request-test-stream (graceful degradation)
  // -------------------------------------------------------------------------
  // The handler now always uses the legacy TestStreamService — the prior
  // ViewbotService auto-start branch was removed with the creation half (dead
  // under LiveKit, and it emitted events the fallback client never listened
  // for). TestStreamService emits `test-stream-available`, which is exactly
  // what the client's StreamSwitchManager fallback waits on.
  describe('request-test-stream', () => {
    test('idle -> starts test stream, sets streamer, emits test-stream-available io-wide', async () => {
      const { io, deps, handlers } = register();

      await handlers['request-test-stream']();

      expect(deps.testStreamService.startTestStream).toHaveBeenCalledTimes(1);
      expect(deps.streamService.setStreamer).toHaveBeenCalledWith('test-stream-1', 'test');
      expect(io.emit).toHaveBeenCalledWith('test-stream-available', { streamId: 'test-stream-1' });
    });

    test('already active -> notifies caller with existing test-stream-available; does not restart', async () => {
      const { socket, deps, handlers } = register();
      deps.testStreamService.getTestStreamStatus.mockReturnValue({ isActive: true, streamId: 'test-live' });

      await handlers['request-test-stream']();

      expect(socket.emit).toHaveBeenCalledWith('test-stream-available', { streamId: 'test-live' });
      expect(deps.testStreamService.startTestStream).not.toHaveBeenCalled();
    });
  });
});
