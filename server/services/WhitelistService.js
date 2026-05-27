/**
 * WhitelistService.js — content filter for URL relay (Twitch + Kick).
 *
 * See docs/architecture/adr/0010-url-relay-whitelist-mode.md for the design and
 * docs/architecture/plans/url-relay-whitelist-mode.md for the phased rollout.
 *
 * This is Phase 0 (scaffolding). The service reads from the DB and answers
 * policy questions; it is not yet consulted by the URL relay or rotation
 * services — those wirings come in Phases 1–3.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const applyPragmas = require('../database/applyPragmas');

const logger = require('../bootstrap/logger').child({ svc: 'WhitelistService' });
const PLATFORMS = ['twitch', 'kick'];
const MODES = ['off', 'blacklist', 'whitelist'];
const CCL_BLOCK_DEFAULT = ['SexualThemes', 'ViolentGraphic', 'DrugsIntoxication'];
const CACHE_TTL_MS = 5_000;

class WhitelistService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.providedDb = options.db || null;
    this.dbPath = options.dbPath || path.join(__dirname, '..', 'data', 'onestreamer.db');
    this.schemaPath = options.schemaPath
      || path.join(__dirname, '..', 'database', 'url-relay-whitelist-schema.sql');
    this.seedPath = options.seedPath
      || path.join(__dirname, '..', 'data', 'seeds', 'url-relay-whitelist.seed.json');
    this.cclBlock = options.cclBlock || CCL_BLOCK_DEFAULT;

    this.db = null;
    this.initialized = false;
    this._cache = null;
    this._cacheAt = 0;

    logger.debug('🛡️  WhitelistService created');
  }

  async initialize() {
    if (this.initialized) return;

    if (this.providedDb) {
      this.db = this.providedDb;
    } else {
      this.db = await this._openDb();
      await applyPragmas(this.db).catch((e) => {
        logger.warn('⚠️  WhitelistService: applyPragmas failed, continuing with defaults:', e.message);
      });
    }

    await this._applySchema();
    await this._loadSeedIfEmpty();
    await this._refreshCache();
    this.initialized = true;
    logger.debug('✅ WhitelistService initialized');
  }

  _openDb() {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) reject(err); else resolve(db);
      });
    });
  }

  async _applySchema() {
    const schema = fs.readFileSync(this.schemaPath, 'utf8');
    const statements = schema
      .split(';')
      .map((s) =>
        s
          .split('\n')
          .map((line) => {
            const idx = line.indexOf('--');
            return idx >= 0 ? line.slice(0, idx) : line;
          })
          .join('\n')
          .trim()
      )
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await this._run(stmt + ';');
    }
  }

  async _loadSeedIfEmpty() {
    const row = await this._get('SELECT COUNT(*) AS n FROM url_relay_filter_config');
    if (row && row.n > 0) return;

    if (!fs.existsSync(this.seedPath)) {
      logger.warn(`⚠️  WhitelistService: seed file not found at ${this.seedPath}; skipping seed`);
      return;
    }

    const raw = fs.readFileSync(this.seedPath, 'utf8');
    const seed = JSON.parse(raw);

    for (const cfg of seed.config || []) {
      if (!PLATFORMS.includes(cfg.platform)) continue;
      await this._run(
        `INSERT INTO url_relay_filter_config
            (platform, mode, fallback_category, fallback_evergreen, drift_check_seconds, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          cfg.platform,
          cfg.mode,
          cfg.fallback_category || null,
          cfg.fallback_evergreen || null,
          cfg.drift_check_seconds || 60,
          'seed',
        ]
      );
    }

    for (const platform of PLATFORMS) {
      const block = seed[platform];
      if (!block) continue;

      for (const item of block.allow_streamers || []) {
        await this._insertEntry(platform, 'streamer', item.login, 'allow', false, item.risk, item.notes);
      }
      for (const item of block.allow_categories || []) {
        await this._insertEntry(platform, 'category', item.name, 'allow', false, item.risk, item.notes);
      }
      for (const item of block.block_streamers || []) {
        await this._insertEntry(platform, 'streamer', item.login, 'block', false, null, item.notes);
      }
      for (const item of block.block_categories || []) {
        await this._insertEntry(platform, 'category', item.name, 'block', false, null, item.notes);
      }
      for (const item of block.evergreen || []) {
        await this._insertEntry(platform, 'streamer', item.login, 'allow', true, null, item.notes);
      }
    }

    await this._run(
      `INSERT INTO url_relay_filter_audit (actor, action, context)
       VALUES (?, ?, ?)`,
      ['seed', 'seed_loaded', `Seed file ${path.basename(this.seedPath)}`]
    );

    logger.debug('✅ WhitelistService: seed data loaded');
  }

  async _insertEntry(platform, entry_type, value, list, isEvergreen, riskFlag, notes) {
    if (!value) return;
    const normalized = entry_type === 'streamer' ? value.toLowerCase() : value;
    try {
      await this._run(
        `INSERT INTO url_relay_filter_entries
            (platform, entry_type, value, list, is_evergreen, risk_flag, notes, source, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [platform, entry_type, normalized, list, isEvergreen ? 1 : 0, riskFlag || null, notes || null, 'seed', 'seed']
      );
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }

  // ── Pure-logic public API ────────────────────────────────────────────────

  /**
   * Check whether a given stream snapshot is allowed.
   *
   * @param {object} snapshot
   * @param {string} snapshot.platform           'twitch' | 'kick'
   * @param {string|null} snapshot.login          channel login (any case)
   * @param {string|null} snapshot.currentGameName  current category as labeled by platform
   * @param {boolean|null} snapshot.isMature      Twitch is_mature
   * @param {string[]|null} snapshot.ccls         Twitch content_classification_labels
   * @param {boolean|null} snapshot.hasMatureContent  Kick has_mature_content
   * @returns {{allowed: boolean, reason: string, gateThatBlocked?: string}}
   */
  checkAllowed(snapshot) {
    this._ensureCache();

    const { platform, login, currentGameName, isMature, ccls, hasMatureContent } = snapshot || {};

    if (!PLATFORMS.includes(platform)) {
      return { allowed: false, reason: 'unsupported_platform', gateThatBlocked: 'platform_check' };
    }
    const cfg = this._cache.config[platform];
    if (!cfg) {
      return { allowed: false, reason: 'no_config', gateThatBlocked: 'config_missing' };
    }

    // CCL / mature flag gates — always on, independent of mode.
    if (isMature === true || hasMatureContent === true) {
      return { allowed: false, reason: 'platform_mature_flag', gateThatBlocked: 'mature_flag' };
    }
    if (Array.isArray(ccls) && ccls.length > 0) {
      // Hardening per code review: trim + case-insensitive compare so a future
      // caller plumbing CCLs from a webhook / cached payload can't bypass with
      // `" SexualThemes "` or `"sexualthemes"`. Twitch's Helix API returns
      // canonical PascalCase, so this is defensive, not corrective.
      const blockSet = new Set(this.cclBlock.map((c) => c.toLowerCase()));
      const hit = ccls
        .map((c) => (typeof c === 'string' ? c.trim() : ''))
        .find((c) => c && blockSet.has(c.toLowerCase()));
      if (hit) {
        return { allowed: false, reason: `ccl_blocked:${hit}`, gateThatBlocked: 'ccl_gate' };
      }
    }

    if (cfg.mode === 'off') {
      return { allowed: true, reason: 'mode_off' };
    }

    const loginLc = login ? login.toLowerCase() : null;
    const entries = this._cache.entries[platform];

    if (cfg.mode === 'blacklist') {
      if (loginLc && entries.blockStreamers.has(loginLc)) {
        return { allowed: false, reason: `streamer_blocked:${loginLc}`, gateThatBlocked: 'blacklist_streamer' };
      }
      if (currentGameName && entries.blockCategories.has(currentGameName)) {
        return { allowed: false, reason: `category_blocked:${currentGameName}`, gateThatBlocked: 'blacklist_category' };
      }
      return { allowed: true, reason: 'blacklist_pass' };
    }

    if (cfg.mode === 'whitelist') {
      const loginAllowed = loginLc && entries.allowStreamers.has(loginLc);
      const categoryAllowed = currentGameName && entries.allowCategories.has(currentGameName);
      if (loginAllowed) return { allowed: true, reason: 'streamer_allowed' };
      if (categoryAllowed) return { allowed: true, reason: 'category_allowed' };
      return { allowed: false, reason: 'not_on_whitelist', gateThatBlocked: 'whitelist_miss' };
    }

    return { allowed: false, reason: 'unknown_mode', gateThatBlocked: 'mode_check' };
  }

  /**
   * Filter a list of candidate streams down to those allowed.
   * Caller is responsible for shaping each candidate to checkAllowed's snapshot.
   *
   * The `platform` argument overrides any `platform` field on individual
   * candidates — this is deliberate (the rotation service knows which
   * platform's candidates these are; per-candidate platform tags are not
   * trusted). Don't mix platforms in one call.
   *
   * Note on category matching: category names are matched **case-sensitively**.
   * Both Twitch's `/helix/streams` and Kick's `/public/v1/livestreams` return
   * canonical-case category names, so this works in practice. Admin UI must
   * canonicalize on entry; see Should-fix #1 in the PR-W1 review.
   *
   * @param {string} platform
   * @param {Array<object>} candidates  each must have at minimum a checkable shape
   * @returns {Array<object>}  same objects, filtered
   */
  filterCandidates(platform, candidates) {
    if (!Array.isArray(candidates)) return [];
    return candidates.filter((c) => {
      const result = this.checkAllowed({ ...c, platform });
      return result.allowed;
    });
  }

  isStillAllowed(snapshot) {
    return this.checkAllowed(snapshot);
  }

  /**
   * Returns { fallbackCategory, fallbackEvergreen, evergreenCandidates }
   * for the orchestrator to consult when no whitelisted streamer is live.
   * Phase 2 wires this into RandomStreamRotationService.
   */
  chooseFallback(platform) {
    this._ensureCache();
    const cfg = this._cache.config[platform];
    if (!cfg) return null;
    const evergreenCandidates = (this._cache.entries[platform]?.evergreenList || [])
      .map((row) => row.value);
    return {
      platform,
      fallbackCategory: cfg.fallback_category || null,
      fallbackEvergreen: cfg.fallback_evergreen || null,
      evergreenCandidates,
    };
  }

  // ── Mutators ────────────────────────────────────────────────────────────

  async setMode(platform, mode, actor) {
    if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform}`);
    if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);

    const before = await this._get(
      'SELECT mode FROM url_relay_filter_config WHERE platform = ?',
      [platform]
    );

    await this._run(
      `INSERT INTO url_relay_filter_config (platform, mode, updated_by)
         VALUES (?, ?, ?)
       ON CONFLICT(platform) DO UPDATE
         SET mode = excluded.mode,
             updated_by = excluded.updated_by,
             updated_at = CURRENT_TIMESTAMP`,
      [platform, mode, actor || null]
    );

    await this._audit({
      actor,
      action: 'mode_change',
      platform,
      before_json: JSON.stringify(before || {}),
      after_json: JSON.stringify({ mode }),
      context: `mode -> ${mode}`,
    });

    await this._refreshCache();
    this.emit('change', { kind: 'mode', platform, mode });
  }

  async setFallback(platform, { fallback_category, fallback_evergreen, drift_check_seconds }, actor) {
    if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform}`);

    const before = await this._get(
      'SELECT fallback_category, fallback_evergreen, drift_check_seconds FROM url_relay_filter_config WHERE platform = ?',
      [platform]
    );
    const after = {
      fallback_category: fallback_category ?? before?.fallback_category ?? null,
      fallback_evergreen: fallback_evergreen ?? before?.fallback_evergreen ?? null,
      drift_check_seconds: drift_check_seconds ?? before?.drift_check_seconds ?? 60,
    };

    await this._run(
      `INSERT INTO url_relay_filter_config
            (platform, mode, fallback_category, fallback_evergreen, drift_check_seconds, updated_by)
         VALUES (?, COALESCE((SELECT mode FROM url_relay_filter_config WHERE platform = ?), 'off'), ?, ?, ?, ?)
       ON CONFLICT(platform) DO UPDATE
         SET fallback_category = excluded.fallback_category,
             fallback_evergreen = excluded.fallback_evergreen,
             drift_check_seconds = excluded.drift_check_seconds,
             updated_by = excluded.updated_by,
             updated_at = CURRENT_TIMESTAMP`,
      [platform, platform, after.fallback_category, after.fallback_evergreen, after.drift_check_seconds, actor || null]
    );

    await this._audit({
      actor,
      action: 'fallback_change',
      platform,
      before_json: JSON.stringify(before || {}),
      after_json: JSON.stringify(after),
    });

    await this._refreshCache();
    this.emit('change', { kind: 'fallback', platform, ...after });
  }

  async addEntry({ platform, entry_type, value, list, notes, risk_flag, is_evergreen }, actor) {
    if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform}`);
    if (!['streamer', 'category'].includes(entry_type)) throw new Error(`unknown entry_type: ${entry_type}`);
    if (!['allow', 'block'].includes(list)) throw new Error(`unknown list: ${list}`);
    if (!value || typeof value !== 'string') throw new Error('value is required');

    const normalized = entry_type === 'streamer' ? value.toLowerCase() : value;

    const result = await this._run(
      `INSERT INTO url_relay_filter_entries
            (platform, entry_type, value, list, is_evergreen, risk_flag, notes, source, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?)`,
      [platform, entry_type, normalized, list, is_evergreen ? 1 : 0, risk_flag || null, notes || null, actor || null]
    );

    await this._audit({
      actor,
      action: 'add',
      platform,
      entry_type,
      value: normalized,
      after_json: JSON.stringify({ list, risk_flag, notes, is_evergreen: !!is_evergreen }),
    });

    await this._refreshCache();
    this.emit('change', { kind: 'entry_add', platform, entry_type, value: normalized, list });
    return { id: result.lastID, value: normalized };
  }

  async removeEntry(id, actor) {
    const before = await this._get('SELECT * FROM url_relay_filter_entries WHERE id = ?', [id]);
    if (!before) return { removed: false };

    await this._run('DELETE FROM url_relay_filter_entries WHERE id = ?', [id]);
    await this._audit({
      actor,
      action: 'remove',
      platform: before.platform,
      entry_type: before.entry_type,
      value: before.value,
      before_json: JSON.stringify(before),
    });

    await this._refreshCache();
    this.emit('change', { kind: 'entry_remove', id, platform: before.platform, value: before.value });
    return { removed: true };
  }

  async markReviewed(id, actor) {
    const row = await this._get('SELECT * FROM url_relay_filter_entries WHERE id = ?', [id]);
    if (!row) return { reviewed: false };
    await this._run(
      'UPDATE url_relay_filter_entries SET last_reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
    await this._audit({
      actor,
      action: 'review',
      platform: row.platform,
      entry_type: row.entry_type,
      value: row.value,
    });
    return { reviewed: true };
  }

  async logAudit(entry) {
    return this._audit(entry);
  }

  // ── Read API for admin UI / inspection ───────────────────────────────────

  async getConfig() {
    this._ensureCache();
    return JSON.parse(JSON.stringify(this._cache));
  }

  async getAuditLog({ limit = 50, action } = {}) {
    let sql = 'SELECT * FROM url_relay_filter_audit';
    const params = [];
    if (action) {
      sql += ' WHERE action = ?';
      params.push(action);
    }
    sql += ' ORDER BY at DESC LIMIT ?';
    params.push(Math.min(limit, 500));
    return this._all(sql, params);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _ensureCache() {
    if (!this._cache) {
      throw new Error('WhitelistService cache not initialized; call initialize() first');
    }
    if (Date.now() - this._cacheAt > CACHE_TTL_MS) {
      // Stale cache is non-fatal — we serve last-known values and refresh in the
      // background. Mutations always force-refresh, so this only matters when
      // an external writer touched the DB.
      this._refreshCache().catch((e) =>
        logger.warn('⚠️  WhitelistService: background cache refresh failed:', e.message)
      );
    }
  }

  async _refreshCache() {
    const configRows = await this._all('SELECT * FROM url_relay_filter_config');
    const entryRows = await this._all('SELECT * FROM url_relay_filter_entries');

    const config = {};
    for (const platform of PLATFORMS) {
      config[platform] = configRows.find((r) => r.platform === platform) || {
        platform,
        mode: 'off',
        fallback_category: null,
        fallback_evergreen: null,
        drift_check_seconds: 60,
      };
    }

    const entries = {};
    for (const platform of PLATFORMS) {
      entries[platform] = {
        allowStreamers: new Set(),
        allowCategories: new Set(),
        blockStreamers: new Set(),
        blockCategories: new Set(),
        evergreenList: [],
        rows: [],
      };
    }

    for (const row of entryRows) {
      const bucket = entries[row.platform];
      if (!bucket) continue;
      bucket.rows.push(row);
      if (row.entry_type === 'streamer' && row.list === 'allow') bucket.allowStreamers.add(row.value);
      if (row.entry_type === 'streamer' && row.list === 'block') bucket.blockStreamers.add(row.value);
      if (row.entry_type === 'category' && row.list === 'allow') bucket.allowCategories.add(row.value);
      if (row.entry_type === 'category' && row.list === 'block') bucket.blockCategories.add(row.value);
      if (row.is_evergreen) bucket.evergreenList.push(row);
    }

    this._cache = { config, entries };
    this._cacheAt = Date.now();
  }

  async _audit(entry) {
    return this._run(
      `INSERT INTO url_relay_filter_audit
            (actor, action, platform, entry_type, value, before_json, after_json, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.actor || null,
        entry.action,
        entry.platform || null,
        entry.entry_type || null,
        entry.value || null,
        entry.before_json || null,
        entry.after_json || null,
        entry.context || null,
      ]
    );
  }

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }
}

module.exports = WhitelistService;
module.exports.PLATFORMS = PLATFORMS;
module.exports.MODES = MODES;
module.exports.CCL_BLOCK_DEFAULT = CCL_BLOCK_DEFAULT;
