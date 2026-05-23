/**
 * AdminHandler socket events — integration tests.
 *
 * Boots a real socket.io server on an ephemeral port and connects real
 * socket.io-client instances against it (one "admin caller" and one
 * "target user"). This mirrors how the handler runs in production:
 * `registerAdminHandler` is invoked from inside `io.on('connection', ...)`,
 * so each connecting socket gets its own listeners.
 */

const http = require('http');
const { Server } = require('socket.io');
const Client = require('socket.io-client');

const registerAdminHandler = require('../../sockets/AdminHandler');

const ADMIN_KEY = 'test-key';

function waitForEvent(socket, event, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timeout waiting for "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

function expectNoEvent(socket, event, windowMs = 150) {
  return new Promise((resolve, reject) => {
    function onEvent(payload) {
      reject(new Error(`unexpected "${event}" event: ${JSON.stringify(payload)}`));
    }
    socket.once(event, onEvent);
    setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, windowMs);
  });
}

describe('sockets/AdminHandler', () => {
  let httpServer;
  let io;
  let port;
  let originalAdminKey;
  let gameStreamService;

  // Track connected sockets so tests can grab the "target" socket id.
  let connectedSockets;

  beforeAll((done) => {
    originalAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = ADMIN_KEY;

    // Silence the handler's console.log / console.error chatter during tests.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    gameStreamService = {
      getStatus: jest.fn().mockReturnValue({ active: false, viewers: 0 }),
    };

    httpServer = http.createServer();
    io = new Server(httpServer);

    connectedSockets = new Map();
    io.on('connection', (socket) => {
      connectedSockets.set(socket.id, socket);
      socket.on('disconnect', () => connectedSockets.delete(socket.id));
      registerAdminHandler(io, socket, { gameStreamService });
    });

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_KEY;
    } else {
      process.env.ADMIN_KEY = originalAdminKey;
    }
    jest.restoreAllMocks();
    // io.close() also closes the underlying httpServer; do not double-close.
    io.close(done);
  });

  // Per-test client lifecycle: an "admin" socket (sender) and a "target" socket
  // (recipient). The admin needs the target's server-assigned socket id.
  let adminClient;
  let targetClient;
  let targetServerSocketId;

  beforeEach(async () => {
    gameStreamService.getStatus.mockClear();
    gameStreamService.getStatus.mockReturnValue({ active: false, viewers: 0 });

    adminClient = Client(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    targetClient = Client(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });

    await Promise.all([
      new Promise((res) => adminClient.on('connect', res)),
      new Promise((res) => targetClient.on('connect', res)),
    ]);

    targetServerSocketId = targetClient.id;
  });

  afterEach(() => {
    if (adminClient && adminClient.connected) adminClient.disconnect();
    if (targetClient && targetClient.connected) targetClient.disconnect();
  });

  describe('admin-message', () => {
    test('valid ADMIN_KEY delivers admin-notification with type=info', async () => {
      const received = waitForEvent(targetClient, 'admin-notification');

      adminClient.emit('admin-message', {
        targetSocketId: targetServerSocketId,
        message: 'hello target',
        adminKey: ADMIN_KEY,
      });

      const payload = await received;
      expect(payload.message).toBe('hello target');
      expect(payload.type).toBe('info');
      expect(typeof payload.timestamp).toBe('number');
    });

    test('invalid ADMIN_KEY does NOT emit admin-notification', async () => {
      const noEvent = expectNoEvent(targetClient, 'admin-notification');

      adminClient.emit('admin-message', {
        targetSocketId: targetServerSocketId,
        message: 'should not arrive',
        adminKey: 'wrong-key',
      });

      await expect(noEvent).resolves.toBeUndefined();
    });

    test('valid key + unknown targetSocketId is a no-op (no throw)', async () => {
      // The target client should not receive anything; nothing on the wire.
      const noEvent = expectNoEvent(targetClient, 'admin-notification');

      adminClient.emit('admin-message', {
        targetSocketId: 'does-not-exist',
        message: 'ghost',
        adminKey: ADMIN_KEY,
      });

      await expect(noEvent).resolves.toBeUndefined();
    });

    // Regression test for #31: when ADMIN_KEY env is unset, the original
    // code did `undefined !== undefined` which evaluated to false and let
    // {adminKey: undefined} payloads through. The fail-closed gate must
    // reject the bypass.
    test('regression #31: undefined ADMIN_KEY env rejects undefined adminKey payload', async () => {
      const previousKey = process.env.ADMIN_KEY;
      delete process.env.ADMIN_KEY;
      try {
        const noEvent = expectNoEvent(targetClient, 'admin-notification');
        adminClient.emit('admin-message', {
          targetSocketId: targetServerSocketId,
          message: 'should not arrive',
          // adminKey omitted entirely — same shape as the original bypass
        });
        await expect(noEvent).resolves.toBeUndefined();
      } finally {
        if (previousKey !== undefined) process.env.ADMIN_KEY = previousKey;
      }
    });
  });

  describe('admin-kick', () => {
    test('valid ADMIN_KEY notifies target then disconnects ~1s later', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
      try {
        const notified = waitForEvent(targetClient, 'admin-notification', 1000);
        const disconnected = new Promise((res) => targetClient.on('disconnect', res));

        adminClient.emit('admin-kick', {
          targetSocketId: targetServerSocketId,
          adminKey: ADMIN_KEY,
        });

        // The notification fires synchronously; advance real time to allow the
        // socket.io transport to flush it to the client before we fast-forward.
        // We let real timers run briefly, then trip the 1s kick timeout.
        jest.useRealTimers();
        const payload = await notified;
        expect(payload.type).toBe('error');
        expect(payload.message).toMatch(/disconnected by an administrator/i);

        // The disconnect itself happens ~1s later — wait for it on the real clock.
        await disconnected;
        expect(targetClient.connected).toBe(false);
      } finally {
        // Make sure we don't leak fake timers into other tests.
        jest.useRealTimers();
      }
    }, 5000);

    test('invalid ADMIN_KEY does nothing (no notification, no disconnect)', async () => {
      const noEvent = expectNoEvent(targetClient, 'admin-notification', 200);
      let disconnected = false;
      targetClient.on('disconnect', () => { disconnected = true; });

      adminClient.emit('admin-kick', {
        targetSocketId: targetServerSocketId,
        adminKey: 'nope',
      });

      await expect(noEvent).resolves.toBeUndefined();
      expect(disconnected).toBe(false);
      expect(targetClient.connected).toBe(true);
    });

    // Regression test for #31 on the kick path.
    test('regression #31: undefined ADMIN_KEY env rejects undefined adminKey kick', async () => {
      const previousKey = process.env.ADMIN_KEY;
      delete process.env.ADMIN_KEY;
      try {
        const noEvent = expectNoEvent(targetClient, 'admin-notification', 200);
        let disconnected = false;
        targetClient.on('disconnect', () => { disconnected = true; });
        adminClient.emit('admin-kick', { targetSocketId: targetServerSocketId });
        await expect(noEvent).resolves.toBeUndefined();
        expect(disconnected).toBe(false);
        expect(targetClient.connected).toBe(true);
      } finally {
        if (previousKey !== undefined) process.env.ADMIN_KEY = previousKey;
      }
    });
  });

  describe('admin:game-status', () => {
    test('invokes callback with {success: true, status} when service succeeds', async () => {
      gameStreamService.getStatus.mockReturnValue({ active: true, viewers: 42 });

      const reply = await new Promise((resolve) => {
        adminClient.emit('admin:game-status', {}, resolve);
      });

      expect(gameStreamService.getStatus).toHaveBeenCalledTimes(1);
      expect(reply).toEqual({ success: true, status: { active: true, viewers: 42 } });
    });

    test('invokes callback with {success: false, error} when service throws', async () => {
      gameStreamService.getStatus.mockImplementation(() => {
        throw new Error('service unavailable');
      });

      const reply = await new Promise((resolve) => {
        adminClient.emit('admin:game-status', {}, resolve);
      });

      expect(reply).toEqual({ success: false, error: 'service unavailable' });
    });
  });
});
