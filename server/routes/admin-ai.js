/**
 * AI admin HTTP surface — extracted from `server/index.js` as part of
 * Phase 15B.3.j. 14 routes across four AI-adjacent admin clusters:
 *
 *   MovieBot:  POST /admin/moviebot/{enable,disable,config}
 *              GET  /admin/moviebot/{status,logs}
 *   VisionBot: POST /admin/visionbot/{enable,disable,config}
 *              GET  /admin/visionbot/{status,logs}
 *   Groq:      GET  /admin/groq/status
 *              POST /admin/groq/config
 *   OpenAI:    GET  /admin/openai/status
 *              POST /admin/openai/config
 *
 * Auth: `adminKeyAuth` (legacy X-Admin-Key) on every route.
 *
 * Both `movieBotService` and `visionBotService` are eager services from
 * the `createServices` destructure — passed directly by value (no
 * getter pattern needed, unlike the lazy services in PR 15B.3.e/h/i).
 *
 * Body byte-equivalent except for:
 *   - `app.X(...)` → `router.X(...)` at line starts
 *
 * Deps (`adminKeyAuth`, `movieBotService`, `visionBotService`,
 * `mediasoupService`, `streamService`, `database`, `logger`)
 * destructured from the factory args bag and used verbatim.
 */

const express = require('express');

function createAdminAiRouter(deps) {
    const {
        adminKeyAuth,
        movieBotService,
        visionBotService,
        mediasoupService,
        streamService,
        database,
        logger,
    } = deps;

    const router = express.Router();

    router.post('/admin/moviebot/enable', adminKeyAuth, async (req, res) => {
      try {
        let { streamerId } = req.body;
    
        if (!streamerId) {
          // Try to get current streamer
          const currentStreamer = mediasoupService.getCurrentStreamer();
          if (!currentStreamer) {
            return res.status(400).json({ error: 'No active stream to monitor' });
          }
          streamerId = currentStreamer;
        }
    
        const result = await movieBotService.enable(streamerId);
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to enable MovieBot');
        res.status(500).json({ error: 'Failed to enable MovieBot' });
      }
    });

    router.post('/admin/moviebot/disable', adminKeyAuth, async (req, res) => {
      try {
        const result = await movieBotService.disable();
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to disable MovieBot');
        res.status(500).json({ error: 'Failed to disable MovieBot' });
      }
    });

    router.get('/admin/moviebot/status', adminKeyAuth, async (req, res) => {
      try {
        const status = movieBotService.getStatus();
        res.json(status);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get MovieBot status');
        res.status(500).json({ error: 'Failed to get MovieBot status' });
      }
    });

    router.post('/admin/moviebot/config', adminKeyAuth, async (req, res) => {
      try {
        const result = movieBotService.updateConfig(req.body);
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to update MovieBot config');
        res.status(500).json({ error: 'Failed to update MovieBot config' });
      }
    });

    router.get('/admin/moviebot/logs', adminKeyAuth, async (req, res) => {
      try {
        const { limit = 50 } = req.query;
        const logs = movieBotService.getRecentLogs(parseInt(limit));
        res.json({ logs });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get MovieBot logs');
        res.status(500).json({ error: 'Failed to get MovieBot logs' });
      }
    });

    // VisionBot admin endpoints — sibling block to MovieBot above. Mirrors that
    // shape: enable / disable / status / config / logs. Auth via adminKeyAuth
    // to match the existing MovieBot client-side calls from BotsPanel.
    router.post('/admin/visionbot/enable', adminKeyAuth, async (req, res) => {
      try {
        const svc = req.app.locals.services && req.app.locals.services.visionBotService;
        if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
        const streamerId = (req.body && req.body.streamerId)
          || (streamService.getCurrentStreamer && streamService.getCurrentStreamer());
        if (!streamerId) {
          return res.status(400).json({ success: false, error: 'No active streamer; pass streamerId.' });
        }
        const result = await svc.enable(streamerId);
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to enable VisionBot');
        res.status(500).json({ error: 'Failed to enable VisionBot' });
      }
    });

    router.post('/admin/visionbot/disable', adminKeyAuth, async (req, res) => {
      try {
        const svc = req.app.locals.services && req.app.locals.services.visionBotService;
        if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
        const result = await svc.disable();
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to disable VisionBot');
        res.status(500).json({ error: 'Failed to disable VisionBot' });
      }
    });

    router.get('/admin/visionbot/status', adminKeyAuth, async (req, res) => {
      try {
        const svc = req.app.locals.services && req.app.locals.services.visionBotService;
        if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
        res.json(svc.getStatus());
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get VisionBot status');
        res.status(500).json({ error: 'Failed to get VisionBot status' });
      }
    });

    router.post('/admin/visionbot/config', adminKeyAuth, async (req, res) => {
      try {
        const svc = req.app.locals.services && req.app.locals.services.visionBotService;
        if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
        const result = svc.updateConfig(req.body || {});
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to update VisionBot config');
        res.status(500).json({ error: 'Failed to update VisionBot config' });
      }
    });

    router.get('/admin/visionbot/logs', adminKeyAuth, async (req, res) => {
      try {
        const svc = req.app.locals.services && req.app.locals.services.visionBotService;
        if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
        res.json({ logs: svc.getRecentLogs(limit) });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get VisionBot logs');
        res.status(500).json({ error: 'Failed to get VisionBot logs' });
      }
    });

    // Global Groq API endpoints for ALL chatbots
    router.get('/admin/groq/status', adminKeyAuth, async (req, res) => {
      try {
        const status = chatBotService.llmService.getGroqStatus();
        res.json(status);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get Groq status');
        res.status(500).json({ error: 'Failed to get Groq status' });
      }
    });

    router.post('/admin/groq/config', adminKeyAuth, async (req, res) => {
      try {
        const { enabled, apiKey, model } = req.body;

        // Update Groq settings in LLM service
        const result = chatBotService.llmService.updateGroqSettings(
          enabled,
          apiKey || null,
          model || null
        );

        logger.info({ result }, '🚀 ADMIN: Updated global Groq settings');
        res.json({ success: true, ...result });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to update Groq config');
        res.status(500).json({ error: 'Failed to update Groq config' });
      }
    });

    // PR-M8 (follow-up to ADR-0021): admin surface for the OpenAI moderation
    // key. Symmetric with /admin/groq/{status,config}. Used by operators who
    // store keys in DB rather than env. The boot-time resolver
    // (server/index.js around the ModerationStage3 construction) reads this
    // table when OPENAI_API_KEY env is unset.
    //
    // The status endpoint deliberately does NOT return the api_key value —
    // only its presence + length + 8-char prefix for confirmation. Echoing
    // the full key on a GET would defeat the point of storing it as a
    // secret.
    router.get('/admin/openai/status', adminKeyAuth, async (req, res) => {
      try {
        const row = await database.getAsync('SELECT enabled, api_key, updated_at, updated_by FROM openai_config WHERE id = 1');
        const hasKey = !!(row && row.api_key);
        res.json({
          enabled: !!(row && row.enabled === 1),
          hasKey,
          keyLength: hasKey ? row.api_key.length : 0,
          keyPrefix: hasKey ? row.api_key.slice(0, 8) : null,
          updated_at: row ? row.updated_at : null,
          updated_by: row ? row.updated_by : null,
          envKeyPresent: !!process.env.OPENAI_API_KEY,
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get OpenAI status');
        res.status(500).json({ error: 'Failed to get OpenAI status' });
      }
    });

    router.post('/admin/openai/config', adminKeyAuth, async (req, res) => {
      try {
        const { enabled, apiKey } = req.body || {};
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'enabled must be a boolean' });
        }
        if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') {
          return res.status(400).json({ error: 'apiKey must be a string or null' });
        }
        // Build UPDATE dynamically so the caller can flip enabled without
        // re-sending the key (and vice versa). The seed row exists from the
        // schema apply so INSERT OR REPLACE isn't necessary.
        const fields = [];
        const params = [];
        if (enabled !== undefined) {
          fields.push('enabled = ?');
          params.push(enabled ? 1 : 0);
        }
        if (apiKey !== undefined) {
          fields.push('api_key = ?');
          params.push(apiKey);
        }
        if (fields.length === 0) {
          return res.status(400).json({ error: 'pass at least one of enabled, apiKey' });
        }
        fields.push("updated_at = datetime('now')");
        fields.push('updated_by = ?');
        params.push('admin');
        await database.runAsync(`UPDATE openai_config SET ${fields.join(', ')} WHERE id = 1`, params);

        logger.info(`🔑 ADMIN: Updated openai_config (enabled=${enabled !== undefined ? enabled : 'unchanged'}, apiKey=${apiKey === undefined ? 'unchanged' : (apiKey ? 'updated' : 'cleared')})`);
        // Return the same shape as /status so the admin UI can render the
        // post-write state without an extra round-trip.
        const row = await database.getAsync('SELECT enabled, api_key, updated_at, updated_by FROM openai_config WHERE id = 1');
        const hasKey = !!(row && row.api_key);
        res.json({
          success: true,
          enabled: !!(row && row.enabled === 1),
          hasKey,
          keyLength: hasKey ? row.api_key.length : 0,
          keyPrefix: hasKey ? row.api_key.slice(0, 8) : null,
          updated_at: row ? row.updated_at : null,
          updated_by: row ? row.updated_by : null,
          note: 'A server restart is required for the new key to take effect — the boot-time resolver reads this row once on startup.',
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to update OpenAI config');
        res.status(500).json({ error: 'Failed to update OpenAI config' });
      }
    });

    return router;
}

module.exports = createAdminAiRouter;
