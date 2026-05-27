/**
 * ViewBotRepository
 *
 * Pure SQL wrapper for the ViewBot system's persistence tables:
 *   - viewbots                   (configured viewbot rows, one per bot_id)
 *   - viewbot_sessions           (lifetime of an individual viewbot run)
 *   - viewbot_metrics            (per-session performance samples)
 *   - viewbot_rotation_history   (audit log of rotation transitions)
 *   - viewbot_system_state       (single-row table; id = 1)
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Domain serialization
 * (`JSON.stringify(config)`, `JSON.stringify(metadata)`) stays in
 * ViewBotDatabaseService; the repo takes the already-stringified value.
 *
 * Constructor mirrors the UserRepository / ChatBotRepository pattern:
 * deps may be injected for unit-test mocking; when omitted the repo
 * falls back to the real primitives from `server/database/database.js`.
 *
 * Extracted from `server/services/ViewBotDatabaseService.js` in PR 6.1.
 * Pre-extraction: 20 inline call-sites.
 */
class ViewBotRepository {
    /**
     * @param {object} [deps]
     * @param {Function} [deps.getAsync] - (sql, params) => Promise<row|undefined>
     * @param {Function} [deps.runAsync] - (sql, params) => Promise<{ id, changes }>
     * @param {Function} [deps.allAsync] - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        // References are captured at construction time. The env-flag swap
        // in database.js (USE_BETTER_SQLITE3, ADR-0014) reassigns the
        // exported wrappers at module load BEFORE any service is
        // constructed, so the captured refs are correct for the lifetime
        // of the process. Don't move the swap post-construction or every
        // existing repo would be stuck on stale refs.
        const fallback = require('./../database');
        this.getAsync = deps.getAsync || fallback.getAsync;
        this.runAsync = deps.runAsync || fallback.runAsync;
        this.allAsync = deps.allAsync || fallback.allAsync;
    }

    // ============================================================
    // viewbots — configured bot rows
    // ============================================================

    /**
     * Returns the row from sqlite_master if the `viewbots` table exists.
     * Used by ViewBotDatabaseService.initialize() to decide whether to
     * run the legacy setup migration.
     */
    async viewbotsTableExists() {
        return await this.getAsync(`
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='viewbots'
            `);
    }

    /**
     * INSERT OR REPLACE a viewbot row. Preserves the existing row's
     * `usage_count` via a correlated subquery — replacement should not
     * silently reset the counter. Caller passes `config` already
     * stringified.
     */
    async upsertViewBot({
        botId,
        name,
        configJson,
        contentType,
        isEnabled,
        autoStart,
        timeAllotment,
    }) {
        return await this.runAsync(`
                INSERT OR REPLACE INTO viewbots
                (bot_id, name, config, content_type, is_enabled, auto_start, time_allotment, updated_at, usage_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP,
                    COALESCE((SELECT usage_count FROM viewbots WHERE bot_id = ?), 0))
            `, [botId, name, configJson, contentType, isEnabled, autoStart, timeAllotment, botId]);
    }

    /**
     * SELECT a single viewbot row, filtered to enabled rows only.
     * Mirrors the legacy `loadViewBot` shape — returns the raw row;
     * caller handles JSON parsing and boolean coercion.
     */
    async findEnabledByBotId(botId) {
        return await this.getAsync(`
                SELECT * FROM viewbots WHERE bot_id = ? AND is_enabled = 1
            `, [botId]);
    }

    async listEnabled() {
        return await this.allAsync(`
                SELECT * FROM viewbots WHERE is_enabled = 1 ORDER BY created_at ASC
            `);
    }

    async deleteByBotId(botId) {
        return await this.runAsync(`
                DELETE FROM viewbots WHERE bot_id = ?
            `, [botId]);
    }

    /**
     * Toggle the `is_enabled` flag for a viewbot. Service passes 0 or 1.
     * Always bumps `updated_at`.
     */
    async setEnabledByBotId(botId, isEnabled) {
        return await this.runAsync(`
                UPDATE viewbots
                SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP
                WHERE bot_id = ?
            `, [isEnabled, botId]);
    }

    async incrementUsageCount(botId) {
        return await this.runAsync(`
                UPDATE viewbots
                SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP
                WHERE bot_id = ?
            `, [botId]);
    }

    async updateName(botId, name) {
        return await this.runAsync(`
                UPDATE viewbots
                SET name = ?, updated_at = CURRENT_TIMESTAMP
                WHERE bot_id = ?
            `, [name, botId]);
    }

    // ============================================================
    // viewbot_system_state — singleton row, id = 1
    // ============================================================

    async upsertSystemState({
        rotationEnabled,
        currentLiveBot,
        realStreamerActive,
        maxBots,
        rotationProbability,
        rotationCheckIntervalMin,
        rotationCheckIntervalMax,
    }) {
        return await this.runAsync(`
                INSERT OR REPLACE INTO viewbot_system_state
                (id, rotation_enabled, current_live_bot, real_streamer_active, max_bots,
                 rotation_probability, rotation_check_interval_min, rotation_check_interval_max, updated_at)
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [rotationEnabled, currentLiveBot, realStreamerActive, maxBots,
                rotationProbability, rotationCheckIntervalMin, rotationCheckIntervalMax]);
    }

    async getSystemState() {
        return await this.getAsync(`
                SELECT * FROM viewbot_system_state WHERE id = 1
            `);
    }

    // ============================================================
    // viewbot_sessions — per-run rows
    // ============================================================

    /**
     * Caller passes `metadataJson` already stringified.
     */
    async insertSession({
        sessionId,
        viewbotId,
        botId,
        streamQuality,
        metadataJson,
    }) {
        return await this.runAsync(`
                INSERT INTO viewbot_sessions
                (session_id, viewbot_id, bot_id, stream_quality, metadata)
                VALUES (?, ?, ?, ?, ?)
            `, [sessionId, viewbotId, botId, streamQuality, metadataJson]);
    }

    async endSession(sessionId, { duration, viewerCount, rotationReason, status, errorMessage }) {
        return await this.runAsync(`
                UPDATE viewbot_sessions
                SET ended_at = CURRENT_TIMESTAMP, duration_ms = ?, viewer_count = ?,
                    rotation_reason = ?, status = ?, error_message = ?
                WHERE session_id = ?
            `, [duration, viewerCount, rotationReason, status, errorMessage, sessionId]);
    }

    // ============================================================
    // viewbot_rotation_history
    // ============================================================

    /**
     * Caller passes `metadataJson` already stringified.
     */
    async insertRotation({
        fromBotId,
        toBotId,
        reason,
        rotationType,
        durationBeforeRotation,
        viewerCount,
        metadataJson,
    }) {
        return await this.runAsync(`
                INSERT INTO viewbot_rotation_history
                (from_bot_id, to_bot_id, rotation_reason, rotation_type,
                 duration_before_rotation, viewer_count_at_rotation, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [fromBotId, toBotId, reason, rotationType, durationBeforeRotation,
                viewerCount, metadataJson]);
    }

    // ============================================================
    // viewbot_metrics
    // ============================================================

    /**
     * Caller passes `additionalDataJson` already stringified.
     */
    async insertMetric({
        viewbotId,
        botId,
        sessionId,
        metricType,
        metricValue,
        metricUnit,
        additionalDataJson,
    }) {
        return await this.runAsync(`
                INSERT INTO viewbot_metrics
                (viewbot_id, bot_id, session_id, metric_type, metric_value, metric_unit, additional_data)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [viewbotId, botId, sessionId, metricType, metricValue, metricUnit,
                additionalDataJson]);
    }

    // ============================================================
    // Analytics — dynamic-fragment helpers
    // ============================================================

    /**
     * Session-aggregate SELECT, composed with pre-built fragment
     * strings. The service owns the fragment whitelist (a fixed switch
     * over timeframe values); the repo owns the SQL template. Same
     * "whitelisting stays in the service" pattern as ChatBotRepository
     * dynamic UPDATEs.
     *
     * @param {string} timeCondition - empty string or `AND started_at > datetime('now', ...)`
     * @param {string} botCondition  - empty string or `AND bot_id = ?`
     * @param {Array}  params        - bindings for the bot_id placeholder
     */
    async getSessionAnalytics({ timeCondition, botCondition, params }) {
        return await this.getAsync(`
                SELECT
                    COUNT(*) as total_sessions,
                    AVG(duration_ms) as avg_duration,
                    SUM(duration_ms) as total_duration,
                    AVG(viewer_count) as avg_viewers,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_sessions,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_sessions
                FROM viewbot_sessions
                WHERE 1=1 ${timeCondition} ${botCondition}
            `, params);
    }

    /**
     * Rotation-aggregate SELECT. Caller-built fragments — note that the
     * bot-condition for rotations matches against from_bot_id OR
     * to_bot_id, so its params array has two entries when filtered.
     */
    async getRotationAnalytics({ timeCondition, botCondition, params }) {
        return await this.getAsync(`
                SELECT
                    COUNT(*) as total_rotations,
                    AVG(duration_before_rotation) as avg_rotation_time
                FROM viewbot_rotation_history
                WHERE 1=1 ${timeCondition} ${botCondition}
            `, params);
    }

    // ============================================================
    // Retention cleanup — caller passes numeric retentionDays
    // ============================================================

    /**
     * NOTE: `retentionDays` is interpolated into the SQL string (not
     * bound) because SQLite's `datetime()` modifier argument is parsed
     * at SQL-compile time, not bind time. Callers MUST pass a numeric
     * value — the service layer controls this, never user input.
     */
    async cleanupOldSessions(retentionDays) {
        const cutoffDate = `datetime('now', '-${retentionDays} days')`;
        return await this.runAsync(`
                DELETE FROM viewbot_sessions
                WHERE created_at < ${cutoffDate} AND status IN ('completed', 'failed')
            `);
    }

    async cleanupOldRotations(retentionDays) {
        const cutoffDate = `datetime('now', '-${retentionDays} days')`;
        return await this.runAsync(`
                DELETE FROM viewbot_rotation_history
                WHERE timestamp < ${cutoffDate}
            `);
    }

    async cleanupOldMetrics(retentionDays) {
        const cutoffDate = `datetime('now', '-${retentionDays} days')`;
        return await this.runAsync(`
                DELETE FROM viewbot_metrics
                WHERE measured_at < ${cutoffDate}
            `);
    }
}

module.exports = ViewBotRepository;
