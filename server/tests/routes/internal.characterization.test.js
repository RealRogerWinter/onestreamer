/**
 * Characterization tests for /api/internal routes defined in
 * server/routes/internal.js.
 *
 * These PIN the CURRENT HTTP behavior (status codes, response shapes, and the
 * service methods invoked with their args) of a representative endpoint from
 * each concern group, so that a follow-up decomposition into sub-route modules
 * can be verified as behavior-preserving. UNIT-level (supertest + mocked
 * services) — a complement to the two existing integration suites
 * (routes.internal.gift / routes.internal.points), which exercise the real
 * AccountService/InventoryService against an in-memory DB.
 *
 * DI reality being characterized:
 *   - The router is mounted at '/api/internal' and is a plain express.Router
 *     (not a factory). Services are read from `req.app.locals.services` (the
 *     PR-I bag) and a few off `req.app.locals` directly (viewbotService,
 *     getStreamerDisplayName, viewbot caches). io comes from `req.app.get('io')`.
 *   - There is NO auth middleware. Each authed handler verifies a Bearer token
 *     INLINE via a module-scoped `authService.verifyToken(token)` and compares
 *     `decoded.id` to an id from the body/params. We mock AuthService with the
 *     same "user:<id>" stub the integration tests use so the equality check
 *     passes for matching ids and rejects (null) otherwise.
 *   - AccountService / ItemService / InventoryService / GameMechanicsService
 *     are typically re-instantiated at module/handler scope. For the endpoints
 *     under test we inject mocks through `app.locals.services` (the handlers
 *     prefer the bag when present) so we can pin the service contract; the
 *     gift/admin paths that `new AccountService()` inline are covered by the
 *     integration suites and are not re-pinned here.
 */

// AuthService.verifyToken: token === "user:<id>" returns { id, userId: id, ... }.
// Any other token returns null (handler responds 401). Mirrors the stub used by
// the two existing integration suites.
jest.mock('../../services/AuthService', () => {
  return class AuthServiceStub {
    verifyToken(token) {
      const m = /^user:(\d+)$/.exec(token);
      if (!m) return null;
      const id = parseInt(m[1], 10);
      return { id, userId: id, username: `user${id}` };
    }
  };
});

const express = require('express');
const request = require('supertest');

const internalRouter = require('../../routes/internal');

function buildApp({ services = {}, locals = {}, io } = {}) {
  const app = express();
  app.locals.services = services;
  for (const [k, v] of Object.entries(locals)) {
    app.locals[k] = v;
  }
  if (io) app.set('io', io);
  app.use('/api/internal', internalRouter);
  return app;
}

describe('routes/internal characterization', () => {
  // ---- Chat-service callbacks (no Bearer auth) -----------------------------
  describe('chat-service callbacks', () => {
    test('POST /track-chat-message tracks by userId and returns success', async () => {
      const timeTrackingService = { trackChatMessage: jest.fn().mockResolvedValue() };
      const sessionService = { getSessionByIp: jest.fn() };
      const res = await request(buildApp({ services: { timeTrackingService, sessionService } }))
        .post('/api/internal/track-chat-message')
        .send({ userId: 7 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, userId: 7 });
      expect(timeTrackingService.trackChatMessage).toHaveBeenCalledWith(7);
    });

    test('POST /track-chat-message 400 when neither userId nor ip provided', async () => {
      const res = await request(buildApp({ services: {} }))
        .post('/api/internal/track-chat-message')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'userId or ip required' });
    });

    test('POST /sync-chat-username updates session and echoes payload', async () => {
      const sessionService = { setChatUsername: jest.fn() };
      const res = await request(buildApp({ services: { sessionService } }))
        .post('/api/internal/sync-chat-username')
        .send({ ip: '1.2.3.4', username: 'bob', color: '#fff' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, ip: '1.2.3.4', username: 'bob', color: '#fff' });
      expect(sessionService.setChatUsername).toHaveBeenCalledWith('1.2.3.4', 'bob', '#fff');
    });
  });

  // ---- Public reads (leaderboard / uptime / user-stats) --------------------
  describe('public reads', () => {
    test('GET /stream-uptime reports not-live when no streaming socket', async () => {
      const io = { sockets: { sockets: new Map() } };
      const res = await request(buildApp({ io })).get('/api/internal/stream-uptime');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, isLive: false, uptime: 0 });
    });
  });

  // ---- Game-mechanics economy (Bearer-gated, gameMechanicsService) ---------
  describe('game-mechanics economy', () => {
    test('POST /gamble dispatches to gameMechanicsService.gamble and spreads result', async () => {
      const gameMechanicsService = { gamble: jest.fn().mockResolvedValue({ won: true, payout: 50 }) };
      const res = await request(buildApp({ services: { gameMechanicsService } }))
        .post('/api/internal/gamble')
        .set('Authorization', 'Bearer user:7')
        .send({ userId: 7, amount: 25 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, won: true, payout: 50 });
      expect(gameMechanicsService.gamble).toHaveBeenCalledWith(7, 25);
    });

    test('POST /gamble 401 when Bearer token id does not match body userId', async () => {
      const gameMechanicsService = { gamble: jest.fn() };
      const res = await request(buildApp({ services: { gameMechanicsService } }))
        .post('/api/internal/gamble')
        .set('Authorization', 'Bearer user:99')
        .send({ userId: 7, amount: 25 });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Invalid credentials' });
      expect(gameMechanicsService.gamble).not.toHaveBeenCalled();
    });

    test('POST /gamble 400 when required params missing', async () => {
      const res = await request(buildApp({ services: {} }))
        .post('/api/internal/gamble')
        .set('Authorization', 'Bearer user:7')
        .send({ userId: 7 }); // no amount

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Missing required parameters' });
    });

    test('POST /slots dispatches to gameMechanicsService.slots', async () => {
      const gameMechanicsService = { slots: jest.fn().mockResolvedValue({ reels: ['a', 'a', 'a'] }) };
      const res = await request(buildApp({ services: { gameMechanicsService } }))
        .post('/api/internal/slots')
        .set('Authorization', 'Bearer user:7')
        .send({ userId: 7, amount: 10 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, reels: ['a', 'a', 'a'] });
      expect(gameMechanicsService.slots).toHaveBeenCalledWith(7, 10);
    });

    test('GET /bonus-status/:userId returns service status (Bearer-gated)', async () => {
      const gameMechanicsService = { getBonusStatus: jest.fn().mockReturnValue({ available: true }) };
      const res = await request(buildApp({ services: { gameMechanicsService } }))
        .get('/api/internal/bonus-status/7')
        .set('Authorization', 'Bearer user:7');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, available: true });
      expect(gameMechanicsService.getBonusStatus).toHaveBeenCalledWith(7);
    });

    test('GET /bonus-status/:userId 401 without Authorization header', async () => {
      const res = await request(buildApp({ services: {} }))
        .get('/api/internal/bonus-status/7');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    });
  });

  // ---- Gift surface (Bearer-gated, inventoryService) -----------------------
  describe('gift surface', () => {
    test('GET /giftable-items/:userId returns service items (Bearer-gated)', async () => {
      const inventoryService = {
        getGiftableItems: jest.fn().mockResolvedValue([{ id: 1, name: 'rose' }]),
      };
      const res = await request(buildApp({ services: { inventoryService } }))
        .get('/api/internal/giftable-items/7')
        .set('Authorization', 'Bearer user:7');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, items: [{ id: 1, name: 'rose' }] });
      expect(inventoryService.getGiftableItems).toHaveBeenCalledWith(7);
    });

    test('GET /giftable-items/:userId 401 when token id mismatches path id', async () => {
      const inventoryService = { getGiftableItems: jest.fn() };
      const res = await request(buildApp({ services: { inventoryService } }))
        .get('/api/internal/giftable-items/7')
        .set('Authorization', 'Bearer user:99');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Invalid credentials' });
      expect(inventoryService.getGiftableItems).not.toHaveBeenCalled();
    });
  });

  // ---- Auth-rejection short-circuit (before any service/DB touch) ----------
  // /award-points and /transfer-points construct AccountService/GameMechanics
  // inline, but their auth + required-param guards run BEFORE any service is
  // touched, so we can pin those branches without a DB. These complement the
  // integration suites which exercise the happy paths against a real DB.
  describe('auth + validation guards (no service reached)', () => {
    test('POST /award-points 401 when Authorization header is missing', async () => {
      const res = await request(buildApp({ services: {} }))
        .post('/api/internal/award-points')
        .send({ userId: 7, amount: 100 });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    });

    test('POST /award-points 400 when required params missing (before auth)', async () => {
      const res = await request(buildApp({ services: {} }))
        .post('/api/internal/award-points')
        .send({ userId: 7 }); // no amount

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Missing required parameters' });
    });

    test('POST /transfer-points 401 when token id does not match fromUserId', async () => {
      const gameMechanicsService = { transferPoints: jest.fn() };
      const res = await request(buildApp({ services: { gameMechanicsService } }))
        .post('/api/internal/transfer-points')
        .set('Authorization', 'Bearer user:99')
        .send({ fromUserId: 7, toUsername: 'bob', amount: 50 });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Invalid credentials' });
      expect(gameMechanicsService.transferPoints).not.toHaveBeenCalled();
    });
  });
});
