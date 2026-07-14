// Tests for the CH1 fix (audit, Plan 06) in chat-service/core/socketHandlers.js:
// the account-level ban that the main server reports at connect time
// (getUserStatus → isBanned) — previously fetched then DISCARDED — must now
// terminate the connection exactly like the local username-ban branch:
// emit('banned') + socket.disconnect(true), with no 'user-assigned'.
// The M4 companion flag (isChatBanned, users.chat_banned) is enforced the
// same way.

const createSocketHandlers = require('../../core/socketHandlers');

function fakeSocket() {
  const emitted = [];
  return {
    id: 'sock_test_1',
    handshake: {
      auth: { token: 'valid-token' },
      headers: {},
      address: '203.0.113.5',
      query: {},
    },
    conn: { remoteAddress: '203.0.113.5' },
    request: { connection: { remoteAddress: '203.0.113.5' } },
    emitted,
    emit(event, payload) { emitted.push({ event, payload }); },
    disconnect: jest.fn(),
    on: jest.fn(),
  };
}

function buildHandlers({ statusResponse, statusRejects = false } = {}) {
  const connectedUsers = new Map();
  const axios = {
    get: jest.fn(async (url) => {
      if (url.includes('/api/admin/internal/user/')) {
        if (statusRejects) throw new Error('main server down');
        return { data: statusResponse };
      }
      // chat-color lookup — no saved color.
      throw new Error('no saved color');
    }),
    post: jest.fn(async () => ({ data: { success: true } })),
  };
  const handlers = createSocketHandlers({
    io: { emit: jest.fn() },
    profanityFilter: { isClean: () => true },
    moderationService: {
      isUserBanned: jest.fn(() => false),
      isUserTimedOut: jest.fn(() => false),
      timeoutUsers: new Map(),
    },
    commandParser: { parse: jest.fn() },
    adminCommands: {},
    connectedUsers,
    ipToUser: new Map(),
    chatMessages: [],
    MAX_CHAT_HISTORY: 100,
    formatTime: () => '12:00',
    verifyToken: jest.fn(() => ({ id: 7, username: 'EveUser' })),
    sendAdminResponse: jest.fn(),
    MAIN_SERVER_URL: 'https://main.test:8443',
    axios,
    getAxiosConfig: (extra = {}) => extra,
    uuidv4: () => 'uuid-1',
  });
  return { handlers, axios, connectedUsers };
}

describe('CH1: account-level ban enforced at connect', () => {
  let logSpy;
  let errSpy;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('isBanned:true → emit banned + disconnect(true), never user-assigned', async () => {
    const { handlers } = buildHandlers({
      statusResponse: { isAdmin: false, isModerator: false, isBanned: true },
    });
    const socket = fakeSocket();
    await handlers.register(socket);

    const events = socket.emitted.map((e) => e.event);
    expect(events).toContain('banned');
    expect(events).not.toContain('user-assigned');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  test('isChatBanned:true (M4, users.chat_banned) is enforced identically', async () => {
    const { handlers } = buildHandlers({
      statusResponse: { isAdmin: false, isModerator: false, isBanned: false, isChatBanned: true },
    });
    const socket = fakeSocket();
    await handlers.register(socket);

    expect(socket.emitted.map((e) => e.event)).toContain('banned');
    expect(socket.emitted.map((e) => e.event)).not.toContain('user-assigned');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  test('banned user is never stored in connectedUsers and does not skip the color fetch into it', async () => {
    const { handlers, axios, connectedUsers } = buildHandlers({
      statusResponse: { isAdmin: false, isModerator: false, isBanned: true },
    });
    const socket = fakeSocket();
    await handlers.register(socket);

    expect(connectedUsers.size).toBe(0);
    // The ban check runs BEFORE the saved-color fetch — only the status
    // endpoint was hit.
    const urls = axios.get.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes('/chat-color'))).toBe(false);
  });

  test('non-banned authenticated user still connects and gets user-assigned', async () => {
    const { handlers, connectedUsers } = buildHandlers({
      statusResponse: { isAdmin: false, isModerator: false, isBanned: false },
    });
    const socket = fakeSocket();
    await handlers.register(socket);

    expect(socket.emitted.map((e) => e.event)).toContain('user-assigned');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(connectedUsers.get('sock_test_1').username).toBe('EveUser');
  });

  test('getUserStatus failure keeps the deliberate fail-open posture (user connects)', async () => {
    const { handlers } = buildHandlers({ statusRejects: true });
    const socket = fakeSocket();
    await handlers.register(socket);

    expect(socket.emitted.map((e) => e.event)).toContain('user-assigned');
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});
