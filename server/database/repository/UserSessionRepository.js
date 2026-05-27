/**
 * UserSessionRepository
 *
 * Pure SQL wrapper for the session / lifecycle tables that the
 * AccountService owns:
 *   - user_sessions          (active session rows; cookie-token → user
 *                             mapping with an `expires_at` TTL)
 *   - account_deletion_logs  (audit log for the deletion-request →
 *                             deletion-confirmed → data-purged
 *                             lifecycle)
 *   - ip_to_user_transfers   (anonymous-IP-session → logged-in-user
 *                             migration audit log, recording what
 *                             a newly-signed-up user inherited from
 *                             their pre-auth IP-bound state)
 *
 * Three tables, one repo — the concerns are all "session and account
 * lifecycle" rather than user-economy (which is AccountStatsRepository).
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Domain orchestration (how
 * long sessions last, what counts as a deletion event, how stats
 * migrate from an IP-bound session to a user-bound one) stays in
 * AccountService.
 *
 * Constructor mirrors the established repository pattern: deps may
 * be injected for unit-test mocking; when omitted the repo falls
 * back to the real primitives from `server/database/database.js`.
 *
 * **Scope note** — the cascade-delete loop in
 * `AccountService.permanentlyDeleteAccount` enumerates seven tables
 * via raw `db.run` with template-string table names and a
 * callback-style Promise wrapper. PR 10.3 deliberately does NOT
 * refactor that loop into N repo calls because: (a) it would expand
 * lines without changing semantics, (b) the loop's defining feature
 * is the enumerated table list itself (the audit trail is in the
 * deletion log, but the table list is the source of truth), and (c)
 * three of the seven tables (`user_inventory`, `item_usage_history`,
 * `user_points_log`) aren't owned by any repo yet — extracting only
 * the four owned-table DELETEs would leave the loop hybrid in a
 * confusing shape. The loop stays inline with a comment naming
 * PR 10.3 so the next round of repo work knows to revisit.
 *
 * Extracted from `server/services/AccountService.js` in PR 10.3 (Phase 10).
 * Pre-extraction: 7 inline SQL call-sites (5 against user_sessions,
 * 1 against account_deletion_logs, 1 against ip_to_user_transfers).
 */
class UserSessionRepository {
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
    // user_sessions
    // ============================================================

    /**
     * INSERT a new session row. `expiresAtIso` is an ISO-8601
     * timestamp string (legacy code passes
     * `new Date(Date.now() + expiresIn).toISOString()`); SQLite
     * stores it in TEXT and compares against `datetime('now')` in
     * later queries — the comparison is lexicographic on the ISO
     * format and works correctly.
     */
    async insertSession({ userId, ipAddress, expiresAtIso }) {
        return await this.runAsync(
            `INSERT INTO user_sessions (user_id, ip_address, expires_at)
             VALUES (?, ?, ?)`,
            [userId, ipAddress, expiresAtIso]
        );
    }

    /**
     * SELECT the most-recently-created non-expired session for a
     * user. Used by AccountService.getSessionByUserId to expose
     * "is this user logged in anywhere?" without iterating all
     * their session rows.
     */
    async getActiveSessionByUserId(userId) {
        return await this.getAsync(
            `SELECT * FROM user_sessions
             WHERE user_id = ? AND expires_at > datetime('now')
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
    }

    /**
     * DELETE a single session by row id (the autoincrement PK, not
     * the user_id). Called when the user logs out.
     */
    async deleteSessionById(sessionId) {
        return await this.runAsync(
            'DELETE FROM user_sessions WHERE id = ?',
            [sessionId]
        );
    }

    /**
     * DELETE every session row whose `expires_at` is in the past.
     * Called from the periodic cleanup tick. No params — the
     * `datetime('now')` literal is the only filter.
     */
    async deleteExpiredSessions() {
        return await this.runAsync(
            "DELETE FROM user_sessions WHERE expires_at < datetime('now')"
        );
    }

    /**
     * DELETE every session for a user. Called from `deleteUser`
     * (the soft-delete path that runs immediately) — distinct from
     * the cascade in `permanentlyDeleteAccount` which uses a raw
     * table-list loop.
     */
    async deleteSessionsByUserId(userId) {
        return await this.runAsync(
            'DELETE FROM user_sessions WHERE user_id = ?',
            [userId]
        );
    }

    // ============================================================
    // account_deletion_logs
    // ============================================================

    /**
     * INSERT an account-deletion audit row. Seven columns; the
     * caller passes user identifying fields (`username`, `email`)
     * pre-fetched from the user row because the audit log
     * deliberately copies them (so the log row survives the user
     * row being deleted later). `created_at` is set via
     * `datetime('now')` literal — matches the legacy SQL.
     *
     * **Behaviour preservation note**: the legacy code used a raw
     * `db.run` with a callback-style Promise wrapper that **swallows
     * errors** (logs to console.error and `resolve(false)` instead
     * of `reject(err)`). The repo method here is fail-loud
     * (rejects). The service-level method `logDeletionAction` keeps
     * the swallow shape — it try/catches the repo call and resolves
     * false on error. The change is from "callback-style
     * pseudo-Promise that swallowed" to "real-Promise that the
     * service swallows in its try/catch wrapper"; observable
     * behaviour identical (audit-log INSERT failures continue to
     * log + resolve-false the calling promise without throwing
     * upstream).
     */
    async insertDeletionLog({ userId, username, email, action, ipAddress, userAgent }) {
        return await this.runAsync(
            `INSERT INTO account_deletion_logs
             (user_id, username, email, action, ip_address, user_agent, created_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [userId, username, email, action, ipAddress, userAgent]
        );
    }

    // ============================================================
    // ip_to_user_transfers
    // ============================================================

    /**
     * INSERT an IP-to-user transfer audit row. `sessionDataJson` is
     * a pre-stringified JSON blob (the service handles
     * `JSON.stringify(sessionData)` before invoking) — keeps the
     * repo dead-simple about types.
     */
    async insertIpTransfer({ userId, ipAddress, sessionDataJson }) {
        return await this.runAsync(
            `INSERT INTO ip_to_user_transfers (user_id, ip_address, session_data)
             VALUES (?, ?, ?)`,
            [userId, ipAddress, sessionDataJson]
        );
    }
}

module.exports = UserSessionRepository;
