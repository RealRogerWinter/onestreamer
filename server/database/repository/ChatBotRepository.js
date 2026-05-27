/**
 * ChatBotRepository
 *
 * Pure SQL wrapper for the ChatBot system's tables:
 *   - chatbots                 (one row per configured bot)
 *   - chatbot_sessions         (live socket sessions per bot)
 *   - chatbot_message_history  (response log, including movie comments)
 *   - temporary_bots           (summon metadata for time-limited bots)
 *   - auto_summoned_bots       (auto-summon bookkeeping)
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Serialization choices that
 * touch domain shape (e.g. `JSON.stringify(personality_traits)`) live in
 * ChatBotService; the repo takes the already-stringified value.
 *
 * Constructor follows the UserRepository pattern (PR-Q precedent): deps
 * may be injected for unit-test mocking; when omitted the repo falls
 * back to the real primitives from `server/database/database.js`, so
 * callers that instantiate it as `new ChatBotRepository()` continue to
 * work unchanged.
 *
 * Extracted from `server/services/ChatBotService.js` in PR 5.3 — the
 * heaviest DB-touching service in the codebase (40 inline call-sites
 * pre-PR).
 */
class ChatBotRepository {
    /**
     * @param {object} [deps]
     * @param {Function} [deps.getAsync]  - (sql, params) => Promise<row|undefined>
     * @param {Function} [deps.runAsync]  - (sql, params) => Promise<{ id, changes }>
     * @param {Function} [deps.allAsync]  - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        // References are captured at construction time. The env-flag swap in
        // database.js (USE_BETTER_SQLITE3, ADR-0014) reassigns the exported
        // wrappers at module load, BEFORE any service is constructed, so the
        // captured refs are correct for the lifetime of the process. If the
        // swap ever moved post-construction, every existing repo would be
        // stuck on stale refs — don't do that.
        const fallback = require('./../database');
        this.getAsync = deps.getAsync || fallback.getAsync;
        this.runAsync = deps.runAsync || fallback.runAsync;
        this.allAsync = deps.allAsync || fallback.allAsync;
    }

    // ============================================================
    // chatbots — top-level configuration rows
    // ============================================================

    async getEnabled() {
        return await this.allAsync('SELECT * FROM chatbots WHERE is_enabled = 1');
    }

    async getById(id) {
        return await this.getAsync('SELECT * FROM chatbots WHERE id = ?', [id]);
    }

    async getAll() {
        return await this.allAsync('SELECT * FROM chatbots ORDER BY created_at DESC');
    }

    /**
     * Full-row fetch with no ORDER BY — preserves the legacy shape used by
     * enableAllBots() which doesn't care about ordering.
     */
    async listForBulk() {
        return await this.allAsync('SELECT * FROM chatbots');
    }

    /**
     * Lightweight summary used by disable-all bookkeeping; only id/name/is_enabled.
     */
    async listSummary() {
        return await this.allAsync('SELECT id, name, is_enabled FROM chatbots');
    }

    async getMovieBotEnabled() {
        return await this.allAsync(
            'SELECT * FROM chatbots WHERE is_enabled = 1 AND moviebot_enabled = 1'
        );
    }

    /**
     * Returns expired temporary bots (id + name only — cleanup doesn't need
     * the full row). Uses `datetime()` on both sides to handle the
     * ISO-8601 timestamps the service writes (e.g. 2026-01-08T07:24:27.751Z).
     */
    async findExpiredTemporary() {
        return await this.allAsync(
            `SELECT id, name FROM chatbots
              WHERE is_temporary = 1
                AND datetime(expires_at) < datetime('now')`
        );
    }

    /**
     * Insert a permanent bot. Field set + defaults mirror the legacy
     * `createBot` shape byte-for-byte. Callers MUST stringify
     * `personality_traits` themselves.
     */
    async create({
        name,
        prompt,
        is_enabled = 1,
        response_interval_min = 60,
        response_interval_max = 180,
        show_robot_emoji = 1,
        personality_traits = '{}',
        use_assigned_name = 1,
        llm_model = null,
        moviebot_enabled = 0,
        response_creativity_temperature = 0.7,
    }) {
        return await this.runAsync(
            `INSERT INTO chatbots (
                name, prompt, is_enabled, response_interval_min,
                response_interval_max, show_robot_emoji, personality_traits,
                use_assigned_name, llm_model, moviebot_enabled,
                response_creativity_temperature
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name, prompt, is_enabled, response_interval_min,
                response_interval_max, show_robot_emoji, personality_traits,
                use_assigned_name, llm_model, moviebot_enabled,
                response_creativity_temperature,
            ]
        );
    }

    /**
     * Insert a temporary (summoned) bot. Extra columns vs. `create`:
     * `is_temporary`, `summoned_by_user_id`, `expires_at`, `summon_item_id`.
     * Mirrors the legacy `createTemporaryBot` SQL.
     */
    async createTemporary({
        name,
        prompt,
        summoned_by_user_id,
        expires_at,
        summon_item_id = null,
        llm_model = 'openai',
        response_creativity_temperature = 0.8,
    }) {
        return await this.runAsync(
            `INSERT INTO chatbots (
                name, prompt, is_enabled, is_temporary,
                summoned_by_user_id, expires_at, summon_item_id,
                moviebot_enabled, use_assigned_name,
                response_interval_min, response_interval_max,
                show_robot_emoji, llm_model, response_creativity_temperature
            ) VALUES (?, ?, 1, 1, ?, ?, ?, 1, 1, 30, 90, 1, ?, ?)`,
            [name, prompt, summoned_by_user_id, expires_at, summon_item_id,
             llm_model, response_creativity_temperature]
        );
    }

    /**
     * Dynamic field update by primary key. Keys in `fields` are used as
     * raw SQL column names — callers MUST pass a controlled, known set
     * (the route handler in ChatBotService.updateBot whitelists the 11
     * mutable columns). Always sets `updated_at = CURRENT_TIMESTAMP`.
     *
     * Returns the `runAsync` shape; callers fetch the post-update row
     * via `getById` if they need it.
     */
    async updateFields(id, fields) {
        const keys = Object.keys(fields);
        if (keys.length === 0) {
            // No-op: still bump updated_at so the call is observable.
            return await this.runAsync(
                'UPDATE chatbots SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [id]
            );
        }
        const setClause = keys.map((k) => `${k} = ?`).join(', ');
        const values = keys.map((k) => fields[k]);
        return await this.runAsync(
            `UPDATE chatbots SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...values, id]
        );
    }

    async setEnabled(id, isEnabled) {
        return await this.runAsync(
            'UPDATE chatbots SET is_enabled = ? WHERE id = ?',
            [isEnabled ? 1 : 0, id]
        );
    }

    async enableAll() {
        return await this.runAsync('UPDATE chatbots SET is_enabled = 1');
    }

    async disableAll() {
        return await this.runAsync('UPDATE chatbots SET is_enabled = 0');
    }

    async deleteById(id) {
        return await this.runAsync('DELETE FROM chatbots WHERE id = ?', [id]);
    }

    /**
     * Delete only if the row is a temporary bot. Used by the expiration
     * timer to avoid accidentally removing a permanent bot if a stale
     * timer fires after the bot was promoted.
     */
    async deleteTemporaryById(id) {
        return await this.runAsync(
            'DELETE FROM chatbots WHERE id = ? AND is_temporary = 1',
            [id]
        );
    }

    // ============================================================
    // chatbot_sessions — live socket sessions
    // ============================================================

    async createSession({ chatbotId, socketId, username, color }) {
        return await this.runAsync(
            `INSERT INTO chatbot_sessions (chatbot_id, socket_id, username, color)
                 VALUES (?, ?, ?, ?)`,
            [chatbotId, socketId, username, color]
        );
    }

    async markSessionDisconnected(sessionId) {
        return await this.runAsync(
            'UPDATE chatbot_sessions SET socket_id = NULL WHERE id = ?',
            [sessionId]
        );
    }

    async touchSessionLastMessage(sessionId) {
        return await this.runAsync(
            'UPDATE chatbot_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
            [sessionId]
        );
    }

    async deleteSessionsForBot(chatbotId) {
        return await this.runAsync(
            'DELETE FROM chatbot_sessions WHERE chatbot_id = ?',
            [chatbotId]
        );
    }

    async deleteAllSessions() {
        return await this.runAsync('DELETE FROM chatbot_sessions');
    }

    async listConnectedSessions() {
        return await this.allAsync(
            'SELECT * FROM chatbot_sessions WHERE socket_id IS NOT NULL'
        );
    }

    /**
     * Active sessions joined with their bot's name + show_robot_emoji
     * flag. Used by the admin "active sessions" panel.
     */
    async listActiveSessionsWithBot() {
        return await this.allAsync(
            `SELECT s.*, b.name as bot_name, b.show_robot_emoji
                 FROM chatbot_sessions s
                 JOIN chatbots b ON s.chatbot_id = b.id
                WHERE s.socket_id IS NOT NULL
             ORDER BY s.connected_at DESC`
        );
    }

    // ============================================================
    // chatbot_message_history — response log
    // ============================================================

    async getLastMessageForBot(chatbotId) {
        return await this.getAsync(
            `SELECT message, created_at FROM chatbot_message_history
              WHERE chatbot_id = ?
           ORDER BY created_at DESC
              LIMIT 1`,
            [chatbotId]
        );
    }

    async insertChatMessage({ chatbotId, message, context, exactPrompt }) {
        return await this.runAsync(
            `INSERT INTO chatbot_message_history (chatbot_id, message, context, exact_prompt)
                 VALUES (?, ?, ?, ?)`,
            [chatbotId, message, context, exactPrompt]
        );
    }

    /**
     * Movie-comment log entry — same table, different `message_type` +
     * structured metadata.
     */
    async insertMovieComment({ chatbotId, message, metadata, exactPrompt }) {
        return await this.runAsync(
            `INSERT INTO chatbot_message_history
                 (chatbot_id, message, message_type, metadata, exact_prompt)
                 VALUES (?, ?, ?, ?, ?)`,
            [chatbotId, message, 'movie_comment', metadata, exactPrompt]
        );
    }

    async getMessages(chatbotId, limit = 50) {
        return await this.allAsync(
            `SELECT * FROM chatbot_message_history
              WHERE chatbot_id = ?
           ORDER BY created_at DESC
              LIMIT ?`,
            [chatbotId, limit]
        );
    }

    // ============================================================
    // temporary_bots — summon metadata
    // ============================================================

    async getTemporaryBotInfo(chatbotId) {
        return await this.getAsync(
            'SELECT * FROM temporary_bots WHERE chatbot_id = ?',
            [chatbotId]
        );
    }

    async createTemporaryRecord({
        chatbotId, summonedByUserId, summonedByUsername, personalityPrompt, expiresAt,
    }) {
        return await this.runAsync(
            `INSERT INTO temporary_bots (
                chatbot_id, summoned_by_user_id, summoned_by_username,
                personality_prompt, expires_at
            ) VALUES (?, ?, ?, ?, ?)`,
            [chatbotId, summonedByUserId, summonedByUsername, personalityPrompt, expiresAt]
        );
    }

    async deleteTemporaryRecord(chatbotId) {
        return await this.runAsync(
            'DELETE FROM temporary_bots WHERE chatbot_id = ?',
            [chatbotId]
        );
    }

    // ============================================================
    // auto_summoned_bots — auto-summon bookkeeping
    // ============================================================

    async deleteAutoSummonedForBot(chatbotId) {
        return await this.runAsync(
            'DELETE FROM auto_summoned_bots WHERE chatbot_id = ?',
            [chatbotId]
        );
    }
}

module.exports = ChatBotRepository;
