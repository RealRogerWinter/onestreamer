/**
 * AI moderation admin routes (PR-M5 of ADR-0013).
 *
 * Admin-only API surface for the AI moderation pipeline:
 *   GET    /api/moderation-ai/events                 list events
 *   GET    /api/moderation-ai/events/:id             event detail
 *   POST   /api/moderation-ai/events/:id/reverse     reverse a ban
 *   GET    /api/moderation-ai/terms                  list terms
 *   POST   /api/moderation-ai/terms                  add admin term
 *   POST   /api/moderation-ai/terms/:id/enabled      enable/disable a term
 *   DELETE /api/moderation-ai/terms/:id              remove an admin term (embedded rows are rejected)
 *   GET    /api/moderation-ai/terms/audit            recent terms audit log
 *   GET    /api/moderation-ai/config                 per-category config
 *   POST   /api/moderation-ai/config                 update per-category config
 *
 * Mounted at /api/moderation-ai. All routes require authenticateAdmin.
 * Routes are mounted unconditionally — the handlers return 503 when
 * moderationService is unset, matching the pattern PR-W5 established.
 */

const express = require('express');
const { authenticateAdmin, authenticateToken } = require('../middleware/auth');

const logger = require('../bootstrap/logger').child({ svc: 'moderation-ai' });
module.exports = function moderationAIRoutes() {
  const router = express.Router();

  function svc(req) {
    return req.app.locals.moderationService
      || (typeof global !== 'undefined' && global.moderationService);
  }

  function actionArbiter(req) {
    return req.app.locals.moderationActionArbiter
      || (typeof global !== 'undefined' && global.moderationActionArbiter);
  }

  function actor(req) {
    return (req.user && (req.user.username || req.user.email)) || 'admin';
  }

  function svcOr503(req, res) {
    const s = svc(req);
    if (!s) {
      res.status(503).json({ error: 'ModerationService not initialized' });
      return null;
    }
    return s;
  }

  // ── Events ────────────────────────────────────────────────────────────

  router.get('/events', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const decision = req.query.decision || null;
    try {
      const rows = await s.getEvents({ limit, offset, decision });
      res.json({ rows, limit, offset });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/events/:id', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const row = await s.getEvent(id);
      if (!row) return res.status(404).json({ error: 'event_not_found' });
      res.json({ event: row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/events/:id/reverse', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const id = parseInt(req.params.id, 10);
    const reason = (req.body && req.body.reason) || null;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const event = await s.getEvent(id);
      if (!event) return res.status(404).json({ error: 'event_not_found' });
      if (event.reversed_at) return res.status(409).json({ error: 'already_reversed' });

      // Mark the moderation_events row reversed.
      const result = await s.reverseEvent(id, actor(req), reason);
      if (!result.ok) return res.status(400).json({ error: result.error });

      // For auto_ban events, also unban the user via the action arbiter's
      // userRepository (or fall back to the local request-scoped one). For
      // auto_skip events on URL-relay, the admin can remove the blocklist
      // row via the existing /api/whitelist/entry/:id DELETE — keeping
      // the two reversal flows separate matches the existing per-system
      // mental model.
      let userUnbanned = false;
      if (event.final_decision === 'auto_ban' && event.streamer_id) {
        const arb = actionArbiter(req);
        if (arb && arb.sessionService && arb.userRepository) {
          const userId = arb.sessionService.getUserIdBySocketId(event.streamer_id);
          if (userId) {
            try {
              // The repo doesn't have a dedicated unban method today (M3
              // notes this gap); fall back to a direct UPDATE through the
              // raw db handle the repo exposes via runAsync.
              if (typeof arb.userRepository.runAsync === 'function') {
                await arb.userRepository.runAsync(
                  `UPDATE users
                     SET streaming_banned = 0,
                         streaming_banned_at = NULL,
                         streaming_banned_by = NULL
                   WHERE id = ?`,
                  [userId]
                );
                userUnbanned = true;
              }
            } catch (e) {
              logger.error('moderation-ai/reverse: unban failed:', e.message);
            }
          }
        }
      }

      res.json({ ok: true, event_id: id, user_unbanned: userUnbanned });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Terms ──────────────────────────────────────────────────────────────

  router.get('/terms', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const enabled = req.query.enabled === undefined
      ? null
      : (req.query.enabled === 'true' || req.query.enabled === '1');
    try {
      const rows = await s.getTerms({
        enabled,
        category: req.query.category || null,
        source: req.query.source || null,
      });
      res.json({ rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/terms', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const result = await s.addTerm(req.body || {}, actor(req));
      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/terms/:id/enabled', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const id = parseInt(req.params.id, 10);
    const enabled = !!(req.body && req.body.enabled);
    try {
      const r = await s.setTermEnabled(id, enabled, actor(req));
      if (!r.ok) return res.status(404).json({ error: r.error });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/terms/:id', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const id = parseInt(req.params.id, 10);
    try {
      const r = await s.removeTerm(id, actor(req));
      if (!r.ok) {
        if (r.error === 'cannot_remove_embedded') return res.status(409).json(r);
        return res.status(404).json(r);
      }
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/terms/audit', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    try {
      const rows = await s.getTermsAudit({ limit });
      res.json({ rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Config ─────────────────────────────────────────────────────────────

  router.get('/config', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const rows = await s.getCategoryConfig();
      res.json({ rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/config', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const r = await s.setCategoryConfig(req.body || {}, actor(req));
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Global enforce toggle ──────────────────────────────────────────────
  // The DB-backed master switch for AI moderation enforcement. When
  // enforce=1, the ActionArbiter applies real bans + URL-relay blocklists
  // on confirmed 2-of-2 HIGH agreement. When enforce=0, all verdicts are
  // downgraded to admin_review (events still log + notifier emits, no
  // destructive action). Replaces the boot-time-only AI_MODERATION_ENFORCE
  // env flag with a runtime-mutable value.
  router.get('/global-config', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const row = await s.getGlobalConfig();
      res.json({ row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/global-config', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const body = req.body || {};
    if (typeof body.enforce !== 'boolean') {
      return res.status(400).json({ error: 'enforce must be a boolean' });
    }
    try {
      const r = await s.setEnforce(body.enforce, actor(req));
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GDPR data subject access (PR-M6) ───────────────────────────────────
  // Any authenticated user (not just admins) can fetch the moderation
  // events that name them. Implements GDPR Article 15 (right of access)
  // and provides a hook for Article 17 (right to erasure) — erasure is
  // handled administratively via a manual review for now because some
  // moderation_events retention is "necessary for legitimate safety
  // interest" per GDPR Article 6(1)(f) and cannot be erased on demand;
  // a separate request-and-review flow is the right approach (deferred).
  //
  // Match logic: events whose `streamer_id` resolves to the caller's user
  // id via the action arbiter's sessionService mapping. This is best-
  // effort — anonymous streams won't appear because no socketId → userId
  // mapping ever existed, but those events also lack a user identifier
  // in any other sense (the user wasn't authenticated when the chunk was
  // emitted).
  router.get('/me/export', authenticateToken, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const userId = req.user && (req.user.id || req.user.userId);
    if (!userId) {
      return res.status(400).json({ error: 'no_user_id_in_token' });
    }
    try {
      const arb = actionArbiter(req);
      let userSocketIds = [];
      if (arb && arb.sessionService && typeof arb.sessionService.socketToUserId !== 'undefined') {
        // SessionService exposes `socketToUserId` as a public Map; we walk
        // it for socket ids mapping to this user. The mapping reflects
        // CURRENT live sockets only — historical bans rely on the
        // moderation_events row carrying the streamer socket id at
        // capture time, but since SessionService.socketToUserId is the
        // only socketId → userId reverse map, this is the best we can do
        // for live correlation. Persistent socketId-to-userId history is
        // deferred to a future PR.
        for (const [socketId, mappedUserId] of arb.sessionService.socketToUserId.entries()) {
          if (mappedUserId === userId) userSocketIds.push(socketId);
        }
      }

      // Pull all events authored against any of the caller's known
      // historical socket ids. Cap at the standard 500-row limit.
      const events = userSocketIds.length === 0
        ? []
        : await s.database.allAsync(
            `SELECT * FROM moderation_events
              WHERE streamer_id IN (${userSocketIds.map(() => '?').join(',')})
              ORDER BY created_at DESC, id DESC LIMIT 500`,
            userSocketIds
          );

      res.json({
        user_id: userId,
        generated_at: new Date().toISOString(),
        notice: 'Per GDPR Article 15, this export lists moderation events known to be associated with your account. Anonymous-session events are not included. Retention: flagged events are kept for 90 days; clean events for 30 days. To request erasure of a specific event under Article 17, contact a platform administrator — note that events retained under Article 6(1)(f) legitimate-safety-interest may not be erasable on demand.',
        legal_basis: 'GDPR Article 6(1)(f) — legitimate safety interest',
        event_count: events.length,
        events,
      });
    } catch (e) {
      logger.error('moderation-ai/me/export error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
