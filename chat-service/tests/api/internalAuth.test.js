// Tests for chat-service/api/internalAuth.js (audit CH3) — the
// X-Internal-Secret gate on the chat-service HTTP API, plus router-level
// coverage that every mutating route (and the two gated READ routes) is
// actually behind it while /health stays open.
//
// No supertest in the chat-service package — the router tests boot a real
// express app on an ephemeral port and drive it with axios (already a
// chat-service dependency), matching the dep-stub style of
// tests/moderation/moderationService.test.js.

const express = require('express');
const axios = require('axios');
const { internalAuth, safeCompare } = require('../../api/internalAuth');
const createApiRouter = require('../../api/routes');

const SECRET = 'test-internal-secret-value';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  return { restore };
}

describe('safeCompare (timing-safe secret compare)', () => {
  test('equal non-empty strings match', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
  });

  test('differing strings of same length do not match', () => {
    expect(safeCompare('abc123', 'abc124')).toBe(false);
  });

  test('differing lengths do not match (no length leak / no throw)', () => {
    expect(safeCompare('short', 'much-longer-secret')).toBe(false);
  });

  test('fails closed on undefined / null / empty / non-string input', () => {
    expect(safeCompare(undefined, 'secret')).toBe(false);
    expect(safeCompare(null, 'secret')).toBe(false);
    expect(safeCompare('', 'secret')).toBe(false);
    expect(safeCompare('provided', '')).toBe(false);
    expect(safeCompare('provided', undefined)).toBe(false);
    expect(safeCompare(42, 'secret')).toBe(false);
  });
});

describe('internalAuth middleware unit', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeReqRes(headers = {}) {
    const req = { method: 'POST', originalUrl: '/api/ban', headers };
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    return { req, res };
  }

  test('correct secret → next(), no warn', () => {
    const { restore } = withEnv({ INTERNAL_API_SECRET: SECRET, ENFORCE_CHAT_INTERNAL_AUTH: 'true' });
    try {
      const { req, res } = makeReqRes({ 'x-internal-secret': SECRET });
      const next = jest.fn();
      internalAuth(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  test('missing secret + enforce on → 401 JSON, handler not reached', () => {
    const { restore } = withEnv({ INTERNAL_API_SECRET: SECRET, ENFORCE_CHAT_INTERNAL_AUTH: 'true' });
    try {
      const { req, res } = makeReqRes({});
      const next = jest.fn();
      internalAuth(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    } finally { restore(); }
  });

  test('wrong secret + enforce on → 401', () => {
    const { restore } = withEnv({ INTERNAL_API_SECRET: SECRET, ENFORCE_CHAT_INTERNAL_AUTH: 'true' });
    try {
      const { req, res } = makeReqRes({ 'x-internal-secret': 'nope' });
      const next = jest.fn();
      internalAuth(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    } finally { restore(); }
  });

  test('missing secret + enforce off (permissive rollout) → next() + ALLOWED warn', () => {
    const { restore } = withEnv({ INTERNAL_API_SECRET: SECRET, ENFORCE_CHAT_INTERNAL_AUTH: undefined });
    try {
      const { req, res } = makeReqRes({});
      const next = jest.fn();
      internalAuth(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ALLOWED (ENFORCE_CHAT_INTERNAL_AUTH off)'));
    } finally { restore(); }
  });

  test('undefined header with configured secret does not throw (timing-safe compare fails closed)', () => {
    const { restore } = withEnv({ INTERNAL_API_SECRET: SECRET, ENFORCE_CHAT_INTERNAL_AUTH: 'true' });
    try {
      const { req, res } = makeReqRes({ 'x-internal-secret': undefined });
      const next = jest.fn();
      expect(() => internalAuth(req, res, next)).not.toThrow();
      expect(res.statusCode).toBe(401);
    } finally { restore(); }
  });

  test('no INTERNAL_API_SECRET configured + enforce on → 401 (fails closed, never matches)', () => {
    const { restore } = withEnv({ INTERNAL_API_SECRET: undefined, ENFORCE_CHAT_INTERNAL_AUTH: 'true' });
    try {
      const { req, res } = makeReqRes({ 'x-internal-secret': 'anything' });
      const next = jest.fn();
      internalAuth(req, res, next);
      expect(res.statusCode).toBe(401);
    } finally { restore(); }
  });
});

describe('api router enforcement (real express app on an ephemeral port)', () => {
  let server;
  let baseUrl;
  let logSpy;
  let warnSpy;

  function makeRouterDeps() {
    const noopSave = jest.fn();
    return {
      io: { emit: jest.fn(), sockets: { sockets: new Map() } },
      moderationService: {
        bannedUsers: new Set(),
        bannedUsersData: new Map(),
        timeoutUsers: new Map(),
        saveModerationData: noopSave,
        banUserWithSideEffects: jest.fn(() => ({ messagesDeleted: 0, disconnectedCount: 0 })),
        timeoutUserWithSideEffects: jest.fn(),
      },
      chatMessages: [],
      MAX_CHAT_HISTORY: 100,
      formatTime: () => '12:00',
      connectedUsers: new Map(),
    };
  }

  beforeAll((done) => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    app.use(createApiRouter(makeRouterDeps()));
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    server.close(done);
  });

  const MUTATING = [
    ['post', '/api/ban', { username: 'Eve' }],
    ['post', '/api/unban', { username: 'Eve' }],
    ['post', '/api/timeout', { username: 'Eve', duration: 60 }],
    ['post', '/api/remove-timeout', { username: 'Eve' }],
    ['post', '/api/system-message', { message: 'hello' }],
  ];
  const GATED_READS = [
    ['get', '/api/moderation'],
    ['get', '/api/chat-history'],
  ];

  describe('enforced mode (ENFORCE_CHAT_INTERNAL_AUTH=true)', () => {
    let restoreEnv;
    beforeAll(() => {
      ({ restore: restoreEnv } = withEnv({ INTERNAL_API_SECRET: SECRET, ENFORCE_CHAT_INTERNAL_AUTH: 'true' }));
    });
    afterAll(() => restoreEnv());

    test.each(MUTATING)('%s %s → 401 without the secret', async (method, path, body) => {
      const r = await axios[method](`${baseUrl}${path}`, body, { validateStatus: () => true });
      expect(r.status).toBe(401);
      expect(r.data).toEqual({ error: 'unauthorized' });
    });

    test.each(MUTATING)('%s %s → 401 with a WRONG secret', async (method, path, body) => {
      const r = await axios[method](`${baseUrl}${path}`, body, {
        headers: { 'X-Internal-Secret': 'wrong-secret' },
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });

    test.each(MUTATING)('%s %s → 200 with the correct secret', async (method, path, body) => {
      const r = await axios[method](`${baseUrl}${path}`, body, {
        headers: { 'X-Internal-Secret': SECRET },
        validateStatus: () => true,
      });
      expect(r.status).toBe(200);
      expect(r.data.success).toBe(true);
    });

    test.each(GATED_READS)('%s %s (read leak) → 401 without the secret, 200 with it', async (method, path) => {
      const denied = await axios[method](`${baseUrl}${path}`, { validateStatus: () => true });
      expect(denied.status).toBe(401);
      const allowed = await axios[method](`${baseUrl}${path}`, {
        headers: { 'X-Internal-Secret': SECRET },
        validateStatus: () => true,
      });
      expect(allowed.status).toBe(200);
    });

    test('GET /health stays open (no secret required)', async () => {
      const r = await axios.get(`${baseUrl}/health`, { validateStatus: () => true });
      expect(r.status).toBe(200);
      expect(r.data.status).toBe('ok');
    });
  });

  describe('permissive mode (flag off)', () => {
    let restoreEnv;
    beforeAll(() => {
      ({ restore: restoreEnv } = withEnv({ INTERNAL_API_SECRET: SECRET, ENFORCE_CHAT_INTERNAL_AUTH: undefined }));
    });
    afterAll(() => restoreEnv());

    test('unauthenticated mutation is ALLOWED but warn-logged', async () => {
      warnSpy.mockClear();
      const r = await axios.post(`${baseUrl}/api/system-message`, { message: 'rollout probe' }, { validateStatus: () => true });
      expect(r.status).toBe(200);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ALLOWED (ENFORCE_CHAT_INTERNAL_AUTH off)'));
    });

    test('authenticated mutation passes without the warn', async () => {
      warnSpy.mockClear();
      const r = await axios.post(`${baseUrl}/api/system-message`, { message: 'authed' }, {
        headers: { 'X-Internal-Secret': SECRET },
        validateStatus: () => true,
      });
      expect(r.status).toBe(200);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
