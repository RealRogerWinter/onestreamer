/**
 * SessionChatMessageRepository
 *
 * Pure SQL wrapper for `session_chat_messages` — the per-session
 * chat snapshot rows captured by ChatCaptureService during a
 * recording. One row per chat message that landed inside the
 * recording's wall-clock window, with both an absolute timestamp
 * (`absolute_time_ms`) and a relative offset (`relative_time_ms`)
 * from the recording's start.
 *
 * Constructor mirrors the UserRepository / ChatBotRepository /
 * ViewBotRepository / BuffRepository / ContinuousRecordingRepository
 * pattern: deps may be injected for unit-test mocking; when omitted
 * the repo falls back to the real primitives from
 * `server/database/database.js`.
 *
 * Extracted from `server/routes/admin-recordings.js` in PR 10.1 (Phase 10).
 *
 * **Scope note**: the JOIN-against-recording_sessions query at
 * admin-recordings.js:1029 stays inline in the route. Cross-table
 * queries belong to the route layer per the single-domain repository
 * convention this codebase follows; the repo owns the single-table
 * shape only.
 *
 * Inserts/writes to this table happen exclusively from
 * ChatCaptureService; if/when that service is also extracted, those
 * writes will move here. PR 10.1's scope is the admin-recordings.js
 * reads.
 */
class SessionChatMessageRepository {
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
     * SELECT all chat rows for a session, optionally bounded by
     * `relative_time_ms`. ORDER ASC so playback consumers can stream
     * without re-sorting. Matches the legacy SQL at
     * admin-recordings.js:320-335 byte-for-byte.
     *
     * `fromMs`/`toMs` are number-coerced by the caller; the route
     * already runs `parseInt(...)` before invoking.
     */
    async listBySession(sessionId, { fromMs, toMs } = {}) {
        let sql = 'SELECT * FROM session_chat_messages WHERE session_id = ?';
        const params = [sessionId];
        if (fromMs !== undefined && fromMs !== null) {
            sql += ' AND relative_time_ms >= ?';
            params.push(fromMs);
        }
        if (toMs !== undefined && toMs !== null) {
            sql += ' AND relative_time_ms <= ?';
            params.push(toMs);
        }
        sql += ' ORDER BY relative_time_ms ASC';
        return await this.allAsync(sql, params);
    }

    /**
     * COUNT chat rows across a list of session ids. Builds an `IN (?, ?, ...)`
     * placeholder list from `sessionIds.length`; values flow on
     * `params` only — no string interpolation of user-controlled
     * data into the SQL. Matches the legacy SQL at
     * admin-recordings.js:824-827.
     *
     * Returns `{ count: number }` (the GET shape). Empty `sessionIds`
     * short-circuits to `{ count: 0 }` rather than emitting an
     * `IN ()` clause that SQLite would reject as a syntax error —
     * the legacy route called this path only after checking
     * `sessions.length > 0`, but defensive guard here keeps the
     * contract honest if callers forget.
     */
    async countBySessionIds(sessionIds) {
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
            return { count: 0 };
        }
        const placeholders = sessionIds.map(() => '?').join(',');
        return await this.getAsync(
            `SELECT COUNT(*) as count FROM session_chat_messages WHERE session_id IN (${placeholders})`,
            sessionIds
        );
    }
}

module.exports = SessionChatMessageRepository;
