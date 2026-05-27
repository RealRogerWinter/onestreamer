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
const { authenticateAdmin } = require('../middleware/auth');

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
              console.error('moderation-ai/reverse: unban failed:', e.message);
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

  return router;
};
