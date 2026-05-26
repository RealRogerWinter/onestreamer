/**
 * Tests for /api/whitelist routes (ADR-0010, PR-W5 / Phase 4).
 *
 * Routes are exercised against an in-process Express app with a mocked
 * WhitelistService and a mock authenticateAdmin middleware (just passes
 * through). The real auth middleware is exercised by other test files.
 */

const express = require('express');
const request = require('supertest');

// Auto-mock the auth middleware so authenticateAdmin always passes.
jest.mock('../../middleware/auth', () => ({
  authenticateAdmin: (req, _res, next) => {
    req.user = { username: 'admin-test' };
    next();
  },
  authenticateModerator: (req, _res, next) => next(),
}));

const whitelistRoutes = require('../../routes/whitelist');

function buildApp(whitelistService) {
  const app = express();
  app.use(express.json());
  if (whitelistService) {
    app.locals.whitelistService = whitelistService;
  }
  app.use('/api/whitelist', whitelistRoutes());
  return app;
}

function stubService(overrides = {}) {
  return {
    getConfig: jest.fn().mockResolvedValue({
      config: {
        twitch: { platform: 'twitch', mode: 'blacklist', fallback_category: 'Minecraft', fallback_evergreen: 'bobross', drift_check_seconds: 60 },
        kick: { platform: 'kick', mode: 'whitelist', fallback_category: 'Minecraft', fallback_evergreen: 'hotradio', drift_check_seconds: 60 },
      },
      entries: {
        twitch: {
          rows: [
            { id: 1, platform: 'twitch', entry_type: 'streamer', value: 'cohhcarnage', list: 'allow', is_evergreen: 0, risk_flag: 'low', notes: '', source: 'seed', created_at: '2026-05-26', created_by: 'seed', last_reviewed_at: null },
          ],
        },
        kick: { rows: [] },
      },
    }),
    setMode: jest.fn().mockResolvedValue({}),
    setFallback: jest.fn().mockResolvedValue({}),
    addEntry: jest.fn().mockResolvedValue({ id: 42, value: 'new_user' }),
    removeEntry: jest.fn().mockResolvedValue({ removed: true }),
    markReviewed: jest.fn().mockResolvedValue({ reviewed: true }),
    getAuditLog: jest.fn().mockResolvedValue([
      { id: 1, at: '2026-05-26', actor: 'admin', action: 'add', platform: 'twitch', value: 'x' },
    ]),
    ...overrides,
  };
}

describe('whitelist routes (PR-W5)', () => {
  describe('GET /api/whitelist/config', () => {
    test('returns 503 when service is unset', async () => {
      const app = buildApp(null);
      const res = await request(app).get('/api/whitelist/config');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not initialized/);
    });

    test('returns config + entries shape', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      const res = await request(app).get('/api/whitelist/config');
      expect(res.status).toBe(200);
      expect(res.body.config.twitch.mode).toBe('blacklist');
      expect(res.body.entries.twitch).toHaveLength(1);
      expect(res.body.entries.twitch[0].value).toBe('cohhcarnage');
      expect(res.body.entries.kick).toEqual([]);
    });
  });

  describe('POST /api/whitelist/mode', () => {
    test('delegates to setMode with actor from req.user', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      const res = await request(app)
        .post('/api/whitelist/mode')
        .send({ platform: 'twitch', mode: 'whitelist' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, platform: 'twitch', mode: 'whitelist' });
      expect(svc.setMode).toHaveBeenCalledWith('twitch', 'whitelist', 'admin-test');
    });

    test('returns 400 on service rejection', async () => {
      const svc = stubService({ setMode: jest.fn().mockRejectedValue(new Error('bad mode')) });
      const app = buildApp(svc);
      const res = await request(app).post('/api/whitelist/mode').send({ platform: 'twitch', mode: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad mode');
    });
  });

  describe('POST /api/whitelist/entry', () => {
    test('creates entry and returns 201', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      const res = await request(app)
        .post('/api/whitelist/entry')
        .send({ platform: 'twitch', entry_type: 'streamer', value: 'NewUser', list: 'allow' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(42);
      expect(svc.addEntry).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'twitch', value: 'NewUser', list: 'allow' }),
        'admin-test',
      );
    });
  });

  describe('DELETE /api/whitelist/entry/:id', () => {
    test('parses id and calls removeEntry', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      const res = await request(app).delete('/api/whitelist/entry/7');
      expect(res.status).toBe(200);
      expect(svc.removeEntry).toHaveBeenCalledWith(7, 'admin-test');
    });
  });

  describe('POST /api/whitelist/entry/:id/review', () => {
    test('calls markReviewed', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      const res = await request(app).post('/api/whitelist/entry/5/review');
      expect(res.status).toBe(200);
      expect(svc.markReviewed).toHaveBeenCalledWith(5, 'admin-test');
    });
  });

  describe('POST /api/whitelist/fallback', () => {
    test('forwards fields to setFallback', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      const res = await request(app)
        .post('/api/whitelist/fallback')
        .send({ platform: 'twitch', fallback_category: 'Stardew Valley', fallback_evergreen: 'monstercat' });
      expect(res.status).toBe(200);
      expect(svc.setFallback).toHaveBeenCalledWith(
        'twitch',
        expect.objectContaining({ fallback_category: 'Stardew Valley', fallback_evergreen: 'monstercat' }),
        'admin-test',
      );
    });
  });

  describe('GET /api/whitelist/audit', () => {
    test('respects limit query param and clamps to 500', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      const res = await request(app).get('/api/whitelist/audit?limit=9999');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(svc.getAuditLog).toHaveBeenCalledWith({ limit: 500, action: undefined });
    });

    test('forwards action filter', async () => {
      const svc = stubService();
      const app = buildApp(svc);
      await request(app).get('/api/whitelist/audit?action=drift_block&limit=10');
      expect(svc.getAuditLog).toHaveBeenCalledWith({ limit: 10, action: 'drift_block' });
    });
  });
});
