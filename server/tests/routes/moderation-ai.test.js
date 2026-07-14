/**
 * Tests for /api/moderation-ai routes (PR-M5 of ADR-0013).
 *
 * Routes are exercised against an in-process Express app with a mocked
 * ModerationService. The real auth middleware is bypassed via jest.mock —
 * authenticateAdmin always passes here (the actual auth contract is
 * exercised by other test files).
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authenticateAdmin: (req, _res, next) => {
    req.user = { username: 'admin-test' };
    next();
  },
  authenticateModerator: (req, _res, next) => next(),
  authenticateToken: (req, _res, next) => {
    // Tests inject a user via app.locals._testUser when they need a specific id;
    // default is a normal authenticated user with id=42.
    req.user = (req.app && req.app.locals && req.app.locals._testUser) || { id: 42, username: 'user-test' };
    next();
  },
}));

const moderationAIRoutes = require('../../routes/moderation-ai');

function makeApp(moderationService, actionArbiter) {
  const app = express();
  app.use(express.json());
  if (moderationService) app.locals.moderationService = moderationService;
  if (actionArbiter) app.locals.moderationActionArbiter = actionArbiter;
  app.use('/api/moderation-ai', moderationAIRoutes());
  return app;
}

function stubService(overrides = {}) {
  return {
    getEvents: jest.fn().mockResolvedValue([
      { id: 1, final_decision: 'admin_review', transcript_excerpt: 'a' },
      { id: 2, final_decision: 'auto_ban', transcript_excerpt: 'b' },
    ]),
    getEvent: jest.fn(async (id) => (id === 7 ? { id: 7, final_decision: 'auto_ban', streamer_id: 'sock_a' } : null)),
    reverseEvent: jest.fn(async () => ({ ok: true, event_id: 7 })),
    getTerms: jest.fn().mockResolvedValue([{ id: 1, term: 'foo', category: 'hate_speech', severity: 'hard', source: 'embedded', enabled: 1 }]),
    addTerm: jest.fn().mockResolvedValue({ id: 99, normalized_form: 'newterm' }),
    setTermEnabled: jest.fn().mockResolvedValue({ ok: true, id: 1 }),
    removeTerm: jest.fn(async (id) => (id === 1
      ? { ok: false, error: 'cannot_remove_embedded' }
      : { ok: true, id })),
    getTermsAudit: jest.fn().mockResolvedValue([{ id: 1, action: 'add' }]),
    getCategoryConfig: jest.fn().mockResolvedValue([
      { category: 'hate_speech', action_mode: 'auto_ban', stage2_threshold: 3, stage3_required: 1, enabled: 1 },
    ]),
    setCategoryConfig: jest.fn().mockResolvedValue({ ok: true, category: 'hate_speech' }),
    ...overrides,
  };
}

describe('/api/moderation-ai', () => {
  test('returns 503 when service not set', async () => {
    const app = makeApp(null);
    const r = await request(app).get('/api/moderation-ai/events');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/ModerationService/);
  });

  describe('events', () => {
    test('GET /events returns rows + limit/offset', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc)).get('/api/moderation-ai/events?limit=10&offset=5');
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(2);
      expect(svc.getEvents).toHaveBeenCalledWith({ limit: 10, offset: 5, decision: null });
    });

    test('GET /events forwards decision filter', async () => {
      const svc = stubService();
      await request(makeApp(svc)).get('/api/moderation-ai/events?decision=auto_ban');
      expect(svc.getEvents).toHaveBeenCalledWith(expect.objectContaining({ decision: 'auto_ban' }));
    });

    test('GET /events/:id returns the row', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc)).get('/api/moderation-ai/events/7');
      expect(r.status).toBe(200);
      expect(r.body.event.id).toBe(7);
    });

    test('GET /events/:id 404 when missing', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc)).get('/api/moderation-ai/events/999');
      expect(r.status).toBe(404);
    });

    test('POST /events/:id/reverse marks the row reversed', async () => {
      const svc = stubService();
      const arb = {
        sessionService: { getUserIdBySocketId: jest.fn(() => 42) },
        userRepository: { runAsync: jest.fn().mockResolvedValue({}) },
      };
      const r = await request(makeApp(svc, arb))
        .post('/api/moderation-ai/events/7/reverse')
        .send({ reason: 'false positive' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.user_unbanned).toBe(true);
      expect(svc.reverseEvent).toHaveBeenCalledWith(7, 'admin-test', 'false positive');
      expect(arb.userRepository.runAsync).toHaveBeenCalled();
    });

    test('POST /events/:id/reverse 409 when already reversed', async () => {
      const svc = stubService({
        getEvent: jest.fn(async () => ({ id: 7, final_decision: 'auto_ban', reversed_at: '2026-05-27' })),
      });
      const r = await request(makeApp(svc)).post('/api/moderation-ai/events/7/reverse').send({});
      expect(r.status).toBe(409);
    });

    test('POST /events/:id/reverse 404 when missing', async () => {
      const svc = stubService({ getEvent: jest.fn(async () => null) });
      const r = await request(makeApp(svc)).post('/api/moderation-ai/events/999/reverse').send({});
      expect(r.status).toBe(404);
    });

    // ── Audit M5: unban by the PERSISTED resolved_user_id ────────────────
    test('reverse unbans via persisted resolved_user_id even when the socket is long gone', async () => {
      const svc = stubService({
        getEvent: jest.fn(async () => ({
          id: 7, final_decision: 'auto_ban', streamer_id: 'sock_dead', resolved_user_id: 42,
        })),
      });
      const arb = {
        // Live resolution FAILS (socket disconnected) — the persisted id must win.
        sessionService: { getUserIdBySocketId: jest.fn(() => null) },
        userRepository: { runAsync: jest.fn().mockResolvedValue({}) },
      };
      const r = await request(makeApp(svc, arb))
        .post('/api/moderation-ai/events/7/reverse')
        .send({ reason: 'appeal upheld' });
      expect(r.status).toBe(200);
      expect(r.body.user_unbanned).toBe(true);
      expect(arb.userRepository.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('streaming_banned = 0'),
        [42]
      );
      // The persisted id short-circuits — no live lookup needed.
      expect(arb.sessionService.getUserIdBySocketId).not.toHaveBeenCalled();
    });

    test('reverse falls back to the live socket lookup for pre-M5 rows (no resolved_user_id)', async () => {
      const svc = stubService(); // getEvent(7) → auto_ban, streamer_id sock_a, no resolved_user_id
      const arb = {
        sessionService: { getUserIdBySocketId: jest.fn(() => 42) },
        userRepository: { runAsync: jest.fn().mockResolvedValue({}) },
      };
      const r = await request(makeApp(svc, arb)).post('/api/moderation-ai/events/7/reverse').send({});
      expect(r.status).toBe(200);
      expect(r.body.user_unbanned).toBe(true);
      expect(arb.sessionService.getUserIdBySocketId).toHaveBeenCalledWith('sock_a');
    });

    test('reverse of an unresolvable auto_ban → 409 user_unresolvable, row NOT marked reversed (was a silent 200 no-op)', async () => {
      const svc = stubService({
        getEvent: jest.fn(async () => ({
          id: 7, final_decision: 'auto_ban', streamer_id: 'sock_dead', resolved_user_id: null,
        })),
      });
      const arb = {
        sessionService: { getUserIdBySocketId: jest.fn(() => null) },
        userRepository: { runAsync: jest.fn() },
      };
      const r = await request(makeApp(svc, arb)).post('/api/moderation-ai/events/7/reverse').send({});
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('user_unresolvable');
      expect(svc.reverseEvent).not.toHaveBeenCalled();
      expect(arb.userRepository.runAsync).not.toHaveBeenCalled();
    });

    test('non-ban events (admin_review / auto_skip) still reverse without user resolution', async () => {
      const svc = stubService({
        getEvent: jest.fn(async () => ({ id: 7, final_decision: 'auto_skip', streamer_id: null })),
      });
      const r = await request(makeApp(svc)).post('/api/moderation-ai/events/7/reverse').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.user_unbanned).toBe(false);
      expect(svc.reverseEvent).toHaveBeenCalled();
    });
  });

  describe('terms', () => {
    test('GET /terms', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc)).get('/api/moderation-ai/terms?enabled=true&category=hate_speech');
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(1);
      expect(svc.getTerms).toHaveBeenCalledWith({ enabled: true, category: 'hate_speech', source: null });
    });

    test('POST /terms', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc))
        .post('/api/moderation-ai/terms')
        .send({ term: 'newterm', category: 'hate_speech', severity: 'soft' });
      expect(r.status).toBe(201);
      expect(svc.addTerm).toHaveBeenCalledWith({ term: 'newterm', category: 'hate_speech', severity: 'soft' }, 'admin-test');
    });

    test('POST /terms validation error → 400', async () => {
      const svc = stubService({
        addTerm: jest.fn().mockRejectedValue(new Error('invalid category')),
      });
      const r = await request(makeApp(svc)).post('/api/moderation-ai/terms').send({});
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid category');
    });

    test('POST /terms/:id/enabled', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc))
        .post('/api/moderation-ai/terms/5/enabled')
        .send({ enabled: false });
      expect(r.status).toBe(200);
      expect(svc.setTermEnabled).toHaveBeenCalledWith(5, false, 'admin-test');
    });

    test('DELETE /terms/:id 409 for embedded', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc)).delete('/api/moderation-ai/terms/1');
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('cannot_remove_embedded');
    });

    test('GET /terms/audit', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc)).get('/api/moderation-ai/terms/audit?limit=5');
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(1);
      expect(svc.getTermsAudit).toHaveBeenCalledWith({ limit: 5 });
    });
  });

  describe('config', () => {
    test('GET /config', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc)).get('/api/moderation-ai/config');
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(1);
    });

    test('POST /config', async () => {
      const svc = stubService();
      const r = await request(makeApp(svc))
        .post('/api/moderation-ai/config')
        .send({ category: 'hate_speech', action_mode: 'admin_review' });
      expect(r.status).toBe(200);
      expect(svc.setCategoryConfig).toHaveBeenCalledWith(
        { category: 'hate_speech', action_mode: 'admin_review' },
        'admin-test'
      );
    });

    test('POST /config validation error → 400', async () => {
      const svc = stubService({
        setCategoryConfig: jest.fn().mockRejectedValue(new Error('invalid action_mode')),
      });
      const r = await request(makeApp(svc)).post('/api/moderation-ai/config').send({ category: 'hate_speech', action_mode: 'bogus' });
      expect(r.status).toBe(400);
    });
  });

  describe('global-config (enforce toggle)', () => {
    test('GET /global-config returns the row', async () => {
      const svc = stubService({
        getGlobalConfig: jest.fn().mockResolvedValue({ enforce: 0, updated_at: '2026-05-27', updated_by: 'seed' }),
      });
      const r = await request(makeApp(svc)).get('/api/moderation-ai/global-config');
      expect(r.status).toBe(200);
      expect(r.body.row).toEqual({ enforce: 0, updated_at: '2026-05-27', updated_by: 'seed' });
    });

    test('POST /global-config { enforce: true } calls setEnforce with actor', async () => {
      const svc = stubService({
        setEnforce: jest.fn().mockResolvedValue({ ok: true, enforce: true }),
      });
      const r = await request(makeApp(svc))
        .post('/api/moderation-ai/global-config')
        .send({ enforce: true });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, enforce: true });
      expect(svc.setEnforce).toHaveBeenCalledWith(true, 'admin-test');
    });

    test('POST /global-config { enforce: false } calls setEnforce', async () => {
      const svc = stubService({
        setEnforce: jest.fn().mockResolvedValue({ ok: true, enforce: false }),
      });
      const r = await request(makeApp(svc))
        .post('/api/moderation-ai/global-config')
        .send({ enforce: false });
      expect(r.status).toBe(200);
      expect(svc.setEnforce).toHaveBeenCalledWith(false, 'admin-test');
    });

    test('POST /global-config rejects non-boolean enforce with 400', async () => {
      const svc = stubService();
      const r1 = await request(makeApp(svc)).post('/api/moderation-ai/global-config').send({});
      expect(r1.status).toBe(400);
      const r2 = await request(makeApp(svc)).post('/api/moderation-ai/global-config').send({ enforce: 'true' });
      expect(r2.status).toBe(400);
      const r3 = await request(makeApp(svc)).post('/api/moderation-ai/global-config').send({ enforce: 1 });
      expect(r3.status).toBe(400);
    });
  });

  describe('GDPR export (PR-M6)', () => {
    test('GET /me/export returns events tied to the caller via session map', async () => {
      const svc = stubService({
        database: {
          allAsync: jest.fn().mockResolvedValue([
            { id: 11, streamer_id: 'sock_a', final_decision: 'admin_review' },
          ]),
        },
      });
      const arb = {
        sessionService: { socketToUserId: new Map([['sock_a', 42], ['sock_other', 99]]) },
      };
      const r = await request(makeApp(svc, arb)).get('/api/moderation-ai/me/export');
      expect(r.status).toBe(200);
      expect(r.body.user_id).toBe(42);
      expect(r.body.event_count).toBe(1);
      expect(r.body.events[0].id).toBe(11);
      expect(r.body.legal_basis).toMatch(/Article 6\(1\)\(f\)/);
      expect(r.body.notice).toMatch(/GDPR/);
    });

    test('GET /me/export returns empty when caller has no socket history', async () => {
      const svc = stubService({
        database: { allAsync: jest.fn().mockResolvedValue([]) },
      });
      const arb = { sessionService: { socketToUserId: new Map() } };
      const r = await request(makeApp(svc, arb)).get('/api/moderation-ai/me/export');
      expect(r.status).toBe(200);
      expect(r.body.event_count).toBe(0);
      expect(r.body.events).toEqual([]);
    });

    test('GET /me/export 400 when token has no user id', async () => {
      const svc = stubService();
      const app = makeApp(svc);
      app.locals._testUser = { username: 'no-id-here' };
      const r = await request(app).get('/api/moderation-ai/me/export');
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('no_user_id_in_token');
    });
  });
});
