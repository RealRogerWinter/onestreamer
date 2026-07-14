// Characterization tests for the CH3 retrofit in
// server/routes/admin-moderation.js — the five chat-moderation proxy routes
// must attach X-Internal-Secret (via utils/chatServiceClient) to their
// outbound chat-service calls, or the chat-service rejects them once
// ENFORCE_CHAT_INTERNAL_AUTH is flipped on. axios is a factory dep, so the
// outbound call is asserted on an injected stub — no network.

const express = require('express');
const request = require('supertest');

const createAdminModerationRouter = require('../../routes/admin-moderation');

const SECRET = 'test-internal-secret';

function makeDeps(axiosStub) {
  return {
    authenticateModerator: (req, _res, next) => {
      req.userRecord = { id: 1, username: 'mod', is_admin: 1, is_moderator: 1 };
      req.user = { id: 1 };
      next();
    },
    authService: {
      getUserFromToken: jest.fn(async () => ({ username: 'mod' })),
    },
    IPBanService: {},
    streamService: {},
    streamingLogsService: {},
    webrtcService: {},
    streamNotifier: {},
    io: { sockets: { sockets: new Map() } },
    axios: axiosStub,
    https: require('https'),
    logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  };
}

function makeApp(axiosStub) {
  const app = express();
  app.use(express.json());
  app.use(createAdminModerationRouter(makeDeps(axiosStub)));
  return app;
}

describe('admin-moderation → chat-service proxies attach X-Internal-Secret (CH3)', () => {
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

  test('GET /api/admin/moderation forwards with the secret header', async () => {
    const axiosStub = { get: jest.fn(async () => ({ data: { bannedUsers: [], timedOutUsers: [] } })) };
    const r = await request(makeApp(axiosStub)).get('/api/admin/moderation');
    expect(r.status).toBe(200);
    const [url, config] = axiosStub.get.mock.calls[0];
    expect(url).toBe('https://onestreamer.live:8444/api/moderation');
    expect(config.headers['X-Internal-Secret']).toBe(SECRET);
    expect(config.timeout).toBe(5000);
  });

  test.each([
    ['/api/admin/ban', '/api/ban', { username: 'Eve', reason: 'spam' }],
    ['/api/admin/unban', '/api/unban', { username: 'Eve' }],
    ['/api/admin/timeout', '/api/timeout', { username: 'Eve', duration: 60, reason: 'spam' }],
    ['/api/admin/remove-timeout', '/api/remove-timeout', { username: 'Eve' }],
  ])('POST %s forwards to chat-service %s with the secret header', async (adminPath, chatPath, body) => {
    const axiosStub = { post: jest.fn(async () => ({ data: { success: true } })) };
    const r = await request(makeApp(axiosStub)).post(adminPath).send(body);
    expect(r.status).toBe(200);
    const [url, , config] = axiosStub.post.mock.calls[0];
    expect(url).toBe(`https://onestreamer.live:8444${chatPath}`);
    expect(config.headers['X-Internal-Secret']).toBe(SECRET);
    // These POSTs previously had NO timeout and NO https agent at all —
    // the helper gives them both.
    expect(config.timeout).toBe(5000);
    expect(config.httpsAgent).toBeDefined();
  });

  test('CHAT_SERVICE_URL env overrides the FQDN default', async () => {
    process.env.CHAT_SERVICE_URL = 'https://127.0.0.1:8444';
    try {
      const axiosStub = { post: jest.fn(async () => ({ data: { success: true } })) };
      await request(makeApp(axiosStub)).post('/api/admin/unban').send({ username: 'Eve' });
      expect(axiosStub.post.mock.calls[0][0]).toBe('https://127.0.0.1:8444/api/unban');
    } finally {
      delete process.env.CHAT_SERVICE_URL;
    }
  });
});
