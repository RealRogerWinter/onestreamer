/**
 * AdminReviewSettingsRepository
 *
 * Pure SQL wrapper for `admin_review_settings` — a key/value table
 * that backs the admin "review system" config surface (retention
 * window, B2 upload toggle, local-buffer hours). Rows are
 * upserted on each PUT; reads return the full row set so the
 * route can shape the response object.
 *
 * Constructor mirrors the UserRepository / ChatBotRepository /
 * ViewBotRepository / BuffRepository / ContinuousRecordingRepository
 * pattern: deps may be injected for unit-test mocking; when omitted
 * the repo falls back to the real primitives from
 * `server/database/database.js`.
 *
 * Extracted from `server/routes/admin-recordings.js` in PR 10.1
 * (Phase 10). Pre-extraction: 4 inline SQL call-sites (1 list, 3
 * upserts).
 */
class AdminReviewSettingsRepository {
    /**
     * @param {object} [deps]
     * @param {Function} [deps.getAsync] - (sql, params) => Promise<row|undefined>
     * @param {Function} [deps.runAsync] - (sql, params) => Promise<{ id, changes }>
     * @param {Function} [deps.allAsync] - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        const fallback = require('./../database');
        this.getAsync = deps.getAsync || fallback.getAsync;
        this.runAsync = deps.runAsync || fallback.runAsync;
        this.allAsync = deps.allAsync || fallback.allAsync;
    }

    /**
     * SELECT every row. The route shapes these into an object keyed
     * by the `key` column; the repo returns the raw rows so the
     * caller controls the shape.
     */
    async listAll() {
        return await this.allAsync('SELECT * FROM admin_review_settings');
    }

    /**
     * UPSERT a single (key, value) pair, bumping `updated_at` on
     * conflict. Matches the legacy SQL at admin-recordings.js:501,
     * 509, 518 — three byte-identical statements where only the
     * key string differed. The value is passed twice because the
     * `ON CONFLICT DO UPDATE` branch re-binds it; SQLite does
     * support `excluded.value` here but the legacy SQL doesn't use
     * it and we keep the shape.
     *
     * Caller is responsible for stringifying the value (legacy
     * called `.toString()` on numbers and booleans before
     * invoking).
     */
    async upsertSetting(key, value) {
        return await this.runAsync(`
                INSERT INTO admin_review_settings (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
            `, [key, value, value]);
    }
}

module.exports = AdminReviewSettingsRepository;
