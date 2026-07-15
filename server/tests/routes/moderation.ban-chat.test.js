// Tests for the M4 fix (audit, Plan 06) in server/routes/moderation.js —
// /api/moderation/ban-chat previously wrote banned_usernames /
// users.chat_banned and stopped: both stores were write-only, so the "ban"
// never stopped a message. It must now ALSO propagate to the chat-service's
// enforced store via POST /api/ban with the internal secret attached (CH3),
// and must NOT roll back the DB write when the chat-service is down
// (partial success is reported via chatServicePropagated).

const express = require('express');
const request = require('supertest');

jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
  authenticateModerator: (req, _res, next) => {
    req.userRecord = { id: 9, username: 'mod', is_admin: 1, is_moderator: 1 };
    next();
  },
  authenticateAdmin: (req, _res, next) => {
    req.userRecord = { id: 9, username: 'admin', is_admin: 1 };
    next();
  },
}));

const mockDbRun = jest.fn((sql, params, cb) => cb && cb(null));
jest.mock('../../database/database', () => ({
  db: { run: (...args) => mockDbRun(...args) },
  getAsync: jest.fn(),
  runAsync: jest.fn(),
  allAsync: jest.fn(),
}));

const mockGetUserByUsername = jest.fn();
jest.mock('../../services/AuthService', () => jest.fn().mockImplementation(() => ({
  accountService: { getUserByUsername: (...args) => mockGetUserByUsername(...args) },
})));

const mockBanFromChat = jest.fn(async () => ({ changes: 1 }));
jest.mock('../../database/repository/UserRepository', () => jest.fn().mockImplementation(() => ({
  banFromChat: (...args) => mockBanFromChat(...args),
  setChatTimeout: jest.fn(),
  banFromStreaming: jest.fn(),
})));

const axios = require('axios');
const moderationRouter = require('../../routes/moderation');

const SECRET = 'test-internal-secret';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/moderation', moderationRouter);
  return app;
}

describe('POST /api/moderation/ban-chat (M4: propagate to chat-service)', () => {
  let savedSecret;
  let savedUrl;
  beforeAll(() => {
    savedSecret = process.env.INTERNAL_API_SECRET;
    savedUrl = process.env.CHAT_SERVICE_URL;
    process.env.INTERNAL_API_SECRET = SECRET;
    delete process.env.CHAT_SERVICE_URL;
  });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = savedSecret;
    if (savedUrl === undefined) delete process.env.CHAT_SERVICE_URL;
    else process.env.CHAT_SERVICE_URL = savedUrl;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ data: { success: true } });
  });

  test('registered-user ban writes users.chat_banned AND calls chat-service /api/ban with the secret', async () => {
    mockGetUserByUsername.mockResolvedValue({ id: 42, is_admin: 0, is_moderator: 0 });
    const r = await request(makeApp()).post('/api/moderation/ban-chat').send({ username: 'eve_user' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.chatServicePropagated).toBe(true);

    expect(mockBanFromChat).toHaveBeenCalledWith(42, 9);

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://127.0.0.1:8444/api/ban');
    expect(body).toEqual(expect.objectContaining({ username: 'eve_user', bannedBy: 'mod' }));
    expect(config.headers['X-Internal-Secret']).toBe(SECRET);
  });

  test('anonymous (animal-name) ban writes banned_usernames AND propagates', async () => {
    const r = await request(makeApp()).post('/api/moderation/ban-chat').send({ username: 'Lion1234' });
    expect(r.status).toBe(200);
    expect(r.body.chatServicePropagated).toBe(true);

    // banned_usernames audit-trail insert retained.
    const insertCalls = mockDbRun.mock.calls.filter(([sql]) => sql.includes('banned_usernames'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual(['Lion1234', 9]);

    // Live enforcement via the chat-service's own store.
    expect(axios.post).toHaveBeenCalledWith(
      'https://127.0.0.1:8444/api/ban',
      expect.objectContaining({ username: 'Lion1234' }),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Internal-Secret': SECRET }) })
    );
    // Registered-user path not touched.
    expect(mockGetUserByUsername).not.toHaveBeenCalled();
  });

  test('chat-service down → DB ban is KEPT, 200 with chatServicePropagated:false + warning message', async () => {
    mockGetUserByUsername.mockResolvedValue({ id: 42, is_admin: 0, is_moderator: 0 });
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));

    const r = await request(makeApp()).post('/api/moderation/ban-chat').send({ username: 'eve_user' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.chatServicePropagated).toBe(false);
    expect(r.body.message).toMatch(/chat service unreachable/);

    // The DB write happened and was not rolled back.
    expect(mockBanFromChat).toHaveBeenCalledWith(42, 9);
    // The moderation_logs entry too.
    const logCalls = mockDbRun.mock.calls.filter(([sql]) => sql.includes('moderation_logs'));
    expect(logCalls).toHaveLength(1);
  });

  test('admin target still rejected before any write or propagation', async () => {
    mockGetUserByUsername.mockResolvedValue({ id: 1, is_admin: 1 });
    const r = await request(makeApp()).post('/api/moderation/ban-chat').send({ username: 'boss' });
    expect(r.status).toBe(403);
    expect(mockBanFromChat).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});
