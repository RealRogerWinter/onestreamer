/**
 * Whitelist routes (ADR-0010, PR-W5 / Phase 4).
 *
 * Admin-only API surface for managing the URL-relay content filter.
 * Reads / mutates the WhitelistService that's wired in server/index.js.
 *
 * Mounted at /api/whitelist. All routes require authenticateAdmin.
 */

const express = require('express');
const { authenticateAdmin } = require('../middleware/auth');

const logger = require('../bootstrap/logger').child({ svc: 'whitelist' });
module.exports = function whitelistRoutes() {
  const router = express.Router();

  function svc(req) {
    return req.app.locals.whitelistService || (typeof global !== 'undefined' && global.whitelistService);
  }

  function actor(req) {
    return (req.user && (req.user.username || req.user.email)) || 'admin';
  }

  function svcOr503(req, res) {
    const s = svc(req);
    if (!s) {
      res.status(503).json({ error: 'WhitelistService not initialized' });
      return null;
    }
    return s;
  }

  // GET /api/whitelist/config — full state (config + entries per platform).
  router.get('/config', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const cfg = await s.getConfig();
      // Serialize Sets → arrays for transport (getConfig already calls
      // JSON.parse(JSON.stringify(...)) which drops the Set internals — we
      // surface the row arrays here for the UI).
      const entries = {};
      for (const platform of Object.keys(cfg.entries || {})) {
        entries[platform] = (cfg.entries[platform].rows || []).map((r) => ({
          id: r.id,
          platform: r.platform,
          entry_type: r.entry_type,
          value: r.value,
          list: r.list,
          is_evergreen: !!r.is_evergreen,
          risk_flag: r.risk_flag,
          notes: r.notes,
          source: r.source,
          created_at: r.created_at,
          created_by: r.created_by,
          last_reviewed_at: r.last_reviewed_at,
        }));
      }
      res.json({ config: cfg.config, entries });
    } catch (e) {
      logger.error('whitelist/config error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/whitelist/mode — { platform, mode }
  router.post('/mode', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const { platform, mode } = req.body || {};
    try {
      await s.setMode(platform, mode, actor(req));
      res.json({ ok: true, platform, mode });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /api/whitelist/fallback — { platform, fallback_category?, fallback_evergreen?, drift_check_seconds? }
  router.post('/fallback', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const { platform, fallback_category, fallback_evergreen, drift_check_seconds } = req.body || {};
    try {
      await s.setFallback(platform, { fallback_category, fallback_evergreen, drift_check_seconds }, actor(req));
      res.json({ ok: true, platform });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /api/whitelist/language — { platform, preferred_languages: ["en", ...] }
  // Empty array disables the language gate for that platform.
  router.post('/language', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const { platform, preferred_languages } = req.body || {};
    try {
      await s.setLanguagePreference(platform, preferred_languages, actor(req));
      res.json({ ok: true, platform, preferred_languages });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /api/whitelist/entry — add an entry
  router.post('/entry', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const result = await s.addEntry(req.body || {}, actor(req));
      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // DELETE /api/whitelist/entry/:id — remove
  router.delete('/entry/:id', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const result = await s.removeEntry(parseInt(req.params.id, 10), actor(req));
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /api/whitelist/entry/:id/review — stamp last_reviewed_at
  router.post('/entry/:id/review', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    try {
      const result = await s.markReviewed(parseInt(req.params.id, 10), actor(req));
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // GET /api/whitelist/audit?action=X&limit=N
  router.get('/audit', authenticateAdmin, async (req, res) => {
    const s = svcOr503(req, res);
    if (!s) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    try {
      const rows = await s.getAuditLog({ limit, action: req.query.action });
      res.json({ rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
