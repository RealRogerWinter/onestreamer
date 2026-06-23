/**
 * BuffRepository
 *
 * Pure SQL wrapper for the active-buffs table:
 *   - active_buffs            (one row per active buff/debuff applied to a user)
 *
 * Several methods JOIN to `items` for display data (name, emoji,
 * effect_data). The JOIN is anchored on active_buffs and the SELECT
 * shape is buff-centric, so it lives in this repo rather than crossing
 * over to ItemRepository.
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Domain serialization
 * (`JSON.parse(metadata)`, `JSON.parse(effect_data)`) and the
 * formatBuffForClient projection stay in BuffDebuffService.
 *
 * Constructor mirrors the UserRepository / ChatBotRepository /
 * ViewBotRepository pattern: deps may be injected for unit-test
 * mocking; when omitted the repo falls back to the real primitives
 * from `server/database/database.js`.
 *
 * Extracted from `server/services/BuffDebuffService.js` in PR 6.2.
 * Pre-extraction: 12 inline call-sites.
 */
class BuffRepository {
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

    // ============================================================
    // active_buffs — single-row CRUD
    // ============================================================

    /**
     * INSERT a new buff row. Caller passes `metadata` already
     * stringified (or null). `duration` is used for BOTH
     * `duration_seconds` (the total amount) and `remaining_seconds`
     * (which starts at the same value and ticks down). Returns the
     * `{id, changes}` shape from runAsync.
     */
    async insertBuff({ userId, itemId, appliedByUserId, buffType, duration, metadata }) {
        return await this.runAsync(`
                INSERT INTO active_buffs (
                    user_id, item_id, applied_by_user_id, buff_type,
                    duration_seconds, remaining_seconds, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [userId, itemId, appliedByUserId, buffType, duration, duration, metadata]);
    }

    /**
     * SELECT a raw active_buffs row by id (no JOIN). Used by the
     * service to verify a freshly-inserted buff actually committed.
     */
    async getById(id) {
        return await this.getAsync(
            'SELECT * FROM active_buffs WHERE id = ?',
            [id]
        );
    }

    /**
     * SELECT a row by id WITH joined item display columns. Mirrors
     * the legacy `getBuffById` shape (alias `ab.*` + item display
     * fields).
     */
    async getByIdWithItem(id) {
        return await this.getAsync(`
                SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data
                FROM active_buffs ab
                JOIN items i ON ab.item_id = i.id
                WHERE ab.id = ?
            `, [id]);
    }

    /**
     * Update remaining seconds + bump last_updated for a buff. Called
     * every streaming-tick and on manual adjustments.
     */
    async updateRemainingSeconds(id, remainingSeconds) {
        return await this.runAsync(`
                UPDATE active_buffs
                SET remaining_seconds = ?, last_updated = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [remainingSeconds, id]);
    }

    /**
     * Mark a buff inactive AND zero its remaining_seconds — the
     * service's "remove" path. Bumps last_updated. The caller takes
     * care of cache eviction and socket emits.
     */
    async markInactive(id) {
        return await this.runAsync(`
                UPDATE active_buffs
                SET is_active = 0, remaining_seconds = 0, last_updated = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [id]);
    }

    /**
     * Counter-bump for the streaming-time tracker. Idempotent at the
     * per-second granularity (callers tick this once per streaming
     * second). NOT atomic vs. concurrent ticks — but ticks for the
     * same buff serialize through the service's update loop, so the
     * read-then-write window doesn't matter in practice. Uses
     * relative arithmetic (`= streaming_time_used + 1`) so it's a
     * single statement.
     */
    async incrementStreamingTime(id) {
        return await this.runAsync(`
                UPDATE active_buffs
                SET streaming_time_used = streaming_time_used + 1
                WHERE id = ?
            `, [id]);
    }

    // ============================================================
    // active_buffs — listings
    // ============================================================

    /**
     * Active buffs across all users, with item display columns. No
     * ORDER BY — caller doesn't depend on ordering (cache builder).
     */
    async listActiveWithItems() {
        return await this.allAsync(`
                SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data
                FROM active_buffs ab
                JOIN items i ON ab.item_id = i.id
                WHERE ab.is_active = 1 AND ab.remaining_seconds > 0
            `);
    }

    /**
     * Active buffs for one user, with item display columns. Service
     * uses this on every "what buffs does X have right now" lookup.
     */
    async listActiveForUser(userId) {
        return await this.allAsync(`
                SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data
                FROM active_buffs ab
                JOIN items i ON ab.item_id = i.id
                WHERE ab.user_id = ? AND ab.is_active = 1 AND ab.remaining_seconds > 0
                ORDER BY ab.applied_at DESC
            `, [userId]);
    }

    /**
     * Most-recently-applied active buff for a (user, item) pair —
     * the "do you already have this buff" check before applying a
     * new one. LIMIT 1 + ORDER BY applied_at DESC.
     */
    async getActiveByUserAndItem(userId, itemId) {
        return await this.getAsync(`
                SELECT * FROM active_buffs
                WHERE user_id = ? AND item_id = ? AND is_active = 1 AND remaining_seconds > 0
                ORDER BY applied_at DESC LIMIT 1
            `, [userId, itemId]);
    }

    /**
     * IDs of buffs that have expired but are still marked active.
     * The cleanup pass walks these and calls `removeBuff(id,
     * 'cleanup')` for each. SELECTs only the id column — that's all
     * the cleanup loop needs.
     */
    async findExpired() {
        return await this.allAsync(`
                SELECT id FROM active_buffs
                WHERE is_active = 1 AND remaining_seconds <= 0
            `);
    }

    // ============================================================
    // active_buffs — analytics
    // ============================================================

    /**
     * Last-7-day usage stats grouped by item. Service uses this for
     * the admin "buff stats" panel. The window is hard-coded in the
     * SQL because the service has only one consumer at one window;
     * a future multi-window method can extend this.
     */
    async getStatsLast7Days() {
        return await this.allAsync(`
                SELECT
                    i.name,
                    i.display_name,
                    i.emoji,
                    i.item_type as buff_type,
                    COUNT(*) as total_applications,
                    COUNT(DISTINCT ab.user_id) as unique_users,
                    AVG(ab.duration_seconds) as avg_duration,
                    AVG(ab.streaming_time_used) as avg_streaming_time_used
                FROM active_buffs ab
                JOIN items i ON ab.item_id = i.id
                WHERE ab.applied_at >= datetime('now', '-7 days')
                GROUP BY ab.item_id
                ORDER BY total_applications DESC
            `);
    }
}

module.exports = BuffRepository;
