/**
 * UserRepository
 *
 * Pure SQL wrapper for the `users` table. No business logic — methods are
 * thin shims over the DB primitives (`getAsync`, `runAsync`, `allAsync`).
 *
 * The constructor accepts `{getAsync, runAsync, allAsync}` so the repository
 * can be unit-tested with mocked DB primitives. When constructed without
 * arguments it falls back to the real primitives exported from
 * `server/database/database.js`, which preserves backwards compatibility
 * with callers that instantiate it as `new UserRepository()`.
 *
 * This is the pilot repository for the PR-Q refactor that splits the
 * monolithic `database.js` into per-entity repositories. Subsequent PRs
 * (PR-Q2, PR-Q3, ...) will migrate remaining inline `users`-table SQL from
 * the other services/routes onto this class.
 */
class UserRepository {
    /**
     * @param {object} [deps]
     * @param {Function} [deps.getAsync]  - (sql, params) => Promise<row|undefined>
     * @param {Function} [deps.runAsync]  - (sql, params) => Promise<{ id, changes }>
     * @param {Function} [deps.allAsync]  - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        const fallback = require('./../database');
        this.getAsync = deps.getAsync || fallback.getAsync;
        this.runAsync = deps.runAsync || fallback.runAsync;
        this.allAsync = deps.allAsync || fallback.allAsync;
    }

    /**
     * Fetch a user row by primary key.
     * Returns the full row (all columns). For callers that need only
     * specific columns, prefer adding a dedicated method rather than
     * post-filtering here.
     */
    async getById(id) {
        return await this.getAsync(
            `SELECT * FROM users WHERE id = ?`,
            [id]
        );
    }

    /**
     * Fetch a user row by email (unique).
     */
    async getByEmail(email) {
        return await this.getAsync(
            `SELECT * FROM users WHERE email = ?`,
            [email]
        );
    }

    /**
     * Fetch a user row by username (unique).
     *
     * Note: the legacy inline SQL in AccountService.getUserByUsername
     * explicitly listed columns. We preserve that exact projection here
     * so the migration is a pure refactor (no semantic change).
     */
    async getByUsername(username) {
        return await this.getAsync(
            `SELECT id, email, username, password, created_at, updated_at, last_login, is_verified, is_admin, is_moderator, is_banned, oauth_provider, username_changed, avatar_url, description FROM users WHERE username = ?`,
            [username]
        );
    }

    /**
     * Insert a new user. Mirrors the legacy
     * `INSERT INTO users (email, username, password, oauth_provider, oauth_id, verification_token)`
     * statement byte-for-byte so callers see identical behavior.
     *
     * @param {object} fields
     * @param {string} fields.email
     * @param {string} fields.username
     * @param {string|null} fields.password
     * @param {string|null} [fields.oauthProvider]
     * @param {string|null} [fields.oauthId]
     * @param {string|null} [fields.verificationToken]
     * @returns {Promise<{ id: number, changes: number }>}
     */
    async create({ email, username, password, oauthProvider = null, oauthId = null, verificationToken = null }) {
        return await this.runAsync(
            `INSERT INTO users (email, username, password, oauth_provider, oauth_id, verification_token)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            [email, username, password, oauthProvider, oauthId, verificationToken]
        );
    }

    /**
     * Generic dynamic update by primary key. Builds `UPDATE users SET ... WHERE id = ?`
     * from the provided field map.
     *
     * Keys in `fields` are used as raw SQL column names — callers MUST pass
     * a controlled, known set (e.g. `is_admin`, `password`). Do NOT pass
     * user input directly. Always sets `updated_at = CURRENT_TIMESTAMP`
     * (matching the bulk of the existing inline `UPDATE users` sites).
     *
     * Pass a Date or a CURRENT_TIMESTAMP literal via `fields` if you need
     * to override `updated_at`. To skip the auto-stamp entirely, use raw
     * `runAsync` instead — this helper is intentionally opinionated.
     *
     * Returns the underlying runAsync result ({ id, changes }).
     */
    async update(id, fields) {
        const keys = Object.keys(fields);
        // Defense-in-depth: reject anything that doesn't look like a plain
        // SQL identifier so a future caller can't accidentally interpolate
        // user input as a column name. All legitimate columns are
        // [a-z][a-z0-9_]+ in this schema.
        for (const key of keys) {
            if (!/^[a-z_][a-z0-9_]*$/i.test(key)) {
                throw new Error(`UserRepository.update: invalid column name '${key}'`);
            }
        }
        if (keys.length === 0) {
            return { id: 0, changes: 0 };
        }

        const setClauses = keys.map((k) => `${k} = ?`);
        setClauses.push('updated_at = CURRENT_TIMESTAMP');
        const values = keys.map((k) => fields[k]);
        values.push(id);

        const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`;
        return await this.runAsync(sql, values);
    }

    // ------------------------------------------------------------------
    // PR-Q2 additions — see refactor plan. Each method below replaces a
    // legacy inline SQL site in AccountService.js or server/routes/admin.js
    // verbatim. Where the original statement did NOT set
    // `updated_at = CURRENT_TIMESTAMP`, we preserve that behavior (i.e. we
    // do NOT auto-stamp) so the migration is a pure refactor.
    // ------------------------------------------------------------------

    /**
     * Fetch a user by OAuth (provider, oauth_id) pair.
     */
    async getByOAuth(provider, oauthId) {
        return await this.getAsync(
            `SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?`,
            [provider, oauthId]
        );
    }

    /**
     * Stamp last_login = CURRENT_TIMESTAMP. Does NOT touch updated_at —
     * the legacy statement did not.
     */
    async updateLastLogin(id) {
        return await this.runAsync(
            `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`,
            [id]
        );
    }

    /**
     * Link an OAuth provider/id to an existing user. Does NOT touch
     * updated_at — the legacy statement did not.
     */
    async linkOAuth(id, provider, oauthId) {
        return await this.runAsync(
            `UPDATE users SET oauth_provider = ?, oauth_id = ? WHERE id = ?`,
            [provider, oauthId, id]
        );
    }

    /**
     * Find a user by their email-verification token.
     * Returns only { id } — matches the legacy projection.
     */
    async findByVerificationToken(token) {
        return await this.getAsync(
            `SELECT id FROM users WHERE verification_token = ?`,
            [token]
        );
    }

    /**
     * Mark a user as verified and clear the verification token.
     * Does NOT touch updated_at — the legacy statement did not.
     */
    async markVerified(id) {
        return await this.runAsync(
            `UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?`,
            [id]
        );
    }

    /**
     * (Re)set the verification token. Does NOT touch updated_at — the
     * legacy statement did not.
     */
    async setVerificationToken(id, token) {
        return await this.runAsync(
            `UPDATE users SET verification_token = ? WHERE id = ?`,
            [token, id]
        );
    }

    /**
     * Set a password-reset token + expiry. Does NOT touch updated_at —
     * the legacy statement did not.
     */
    async setResetToken(id, token, expiresAtIso) {
        return await this.runAsync(
            `UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?`,
            [token, expiresAtIso, id]
        );
    }

    /**
     * Find a user by reset token, but only if the token has not yet
     * expired. Mirrors the legacy projection `id, reset_token_expires`.
     */
    async findByResetToken(token) {
        return await this.getAsync(
            `SELECT id, reset_token_expires FROM users
             WHERE reset_token = ? AND reset_token_expires > datetime('now')`,
            [token]
        );
    }

    /**
     * Set a new password and clear the reset token + expiry.
     * Does NOT touch updated_at — the legacy statement did not.
     */
    async setPasswordAndClearResetToken(id, hashedPassword) {
        return await this.runAsync(
            `UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL
             WHERE id = ?`,
            [hashedPassword, id]
        );
    }

    /**
     * Hard-delete a user row by primary key.
     */
    async deleteById(id) {
        return await this.runAsync(
            `DELETE FROM users WHERE id = ?`,
            [id]
        );
    }

    /**
     * Public-safe list used by the admin search endpoint inside
     * AccountService. Returns the legacy projection ordered by
     * created_at DESC, optionally filtered by an email/username LIKE
     * pattern (caller supplies the wildcards).
     */
    async searchByEmailOrUsername(searchPattern, limit) {
        return await this.allAsync(
            `SELECT id, email, username, created_at, last_login, is_verified, is_admin, is_banned
             FROM users
             WHERE email LIKE ? OR username LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [searchPattern, searchPattern, limit]
        );
    }

    /**
     * Public-safe list with no filter — legacy AccountService.getAllUsers.
     */
    async listPublic(limit) {
        return await this.allAsync(
            `SELECT id, email, username, created_at, last_login, is_verified, is_admin, is_banned
             FROM users
             ORDER BY created_at DESC
             LIMIT ?`,
            [limit]
        );
    }

    /**
     * Admin endpoint list (GET /api/admin/users). Same projection plus
     * `is_moderator`, optional search, no LIMIT (matches the legacy
     * inline SQL exactly).
     */
    async listForAdmin({ search } = {}) {
        let query = `
            SELECT
                id, email, username, created_at, last_login,
                is_verified, is_admin, is_moderator, is_banned
            FROM users
        `;
        const params = [];
        if (search) {
            query += ' WHERE username LIKE ? OR email LIKE ?';
            params.push(`%${search}%`, `%${search}%`);
        }
        query += ' ORDER BY created_at DESC';
        return await this.allAsync(query, params);
    }

    /**
     * Internal chat-service status check — returns only
     * { is_admin, is_moderator, is_banned } or undefined.
     */
    async getStatusFlags(id) {
        return await this.getAsync(
            'SELECT is_admin, is_moderator, is_banned FROM users WHERE id = ?',
            [id]
        );
    }

    /**
     * Account-deletion: stamp the request fields.
     * Does NOT touch updated_at — the legacy statement did not.
     */
    async requestDeletion(id, { requestedAtIso, token, tokenExpiresIso, scheduledForIso }) {
        return await this.runAsync(
            `UPDATE users
             SET deletion_requested_at = ?,
                 deletion_token = ?,
                 deletion_token_expires = ?,
                 deletion_scheduled_for = ?,
                 account_status = 'pending_deletion'
             WHERE id = ?`,
            [requestedAtIso, token, tokenExpiresIso, scheduledForIso, id]
        );
    }

    /**
     * Account-deletion: find the user with a live deletion token.
     * Matches the legacy projection (SELECT *) and the legacy WHERE
     * clause (token live + status = pending_deletion).
     */
    async findByDeletionToken(token) {
        return await this.getAsync(
            `SELECT * FROM users
             WHERE deletion_token = ?
             AND deletion_token_expires > datetime('now')
             AND account_status = 'pending_deletion'`,
            [token]
        );
    }

    /**
     * Account-deletion: stamp deletion_confirmed_at = datetime('now').
     * Does NOT touch updated_at — the legacy statement did not.
     */
    async confirmDeletion(id) {
        return await this.runAsync(
            `UPDATE users
             SET deletion_confirmed_at = datetime('now')
             WHERE id = ?`,
            [id]
        );
    }

    /**
     * Account-deletion: clear all deletion fields and restore active
     * status, but only if the row is currently pending_deletion.
     * Returns { id, changes } so the caller can detect "no rows updated"
     * (which the legacy callback-style code did via this.changes === 0).
     */
    async restoreFromDeletion(id) {
        return await this.runAsync(
            `UPDATE users
             SET deletion_requested_at = NULL,
                 deletion_confirmed_at = NULL,
                 deletion_scheduled_for = NULL,
                 deletion_token = NULL,
                 deletion_token_expires = NULL,
                 account_status = 'active'
             WHERE id = ? AND account_status = 'pending_deletion'`,
            [id]
        );
    }

    /**
     * Account-deletion: list users whose grace period has elapsed and
     * who are eligible for permanent purge.
     */
    async listPendingDeletion() {
        return await this.allAsync(
            `SELECT * FROM users
             WHERE account_status = 'pending_deletion'
             AND deletion_confirmed_at IS NOT NULL
             AND deletion_scheduled_for <= datetime('now')`,
            []
        );
    }

    /**
     * Account-deletion: tombstone the user row (keep id for audit, wipe
     * PII). Does NOT touch updated_at — the legacy statement did not.
     */
    async purgeAccount(id) {
        return await this.runAsync(
            `UPDATE users
             SET account_status = 'deleted',
                 email = 'deleted_' || id || '@deleted.com',
                 username = 'deleted_user_' || id,
                 password = NULL,
                 oauth_id = NULL,
                 verification_token = NULL,
                 reset_token = NULL,
                 deletion_token = NULL
             WHERE id = ?`,
            [id]
        );
    }

    /**
     * Fetch only the password hash for a user (used by verifyUserPassword).
     */
    async getPasswordHash(id) {
        return await this.getAsync(
            `SELECT password FROM users WHERE id = ?`,
            [id]
        );
    }

    /**
     * Public/safe projection for AccountService.getUserById — hides
     * password, oauth_id, verification_token, reset_token, etc.
     */
    async getSafeById(id) {
        return await this.getAsync(
            `SELECT id, email, username, created_at, updated_at, last_login, is_verified, is_admin, is_moderator, is_banned, oauth_provider, username_changed, avatar_url, description
             FROM users WHERE id = ?`,
            [id]
        );
    }

    /**
     * Profile projection used by AccountService.getUserProfile — adds the
     * bio/website/location/display_name fields.
     */
    async getProfileById(id) {
        return await this.getAsync(
            `SELECT id, email, username, bio, website, location, display_name,
                    created_at, updated_at, is_verified, is_admin, is_moderator
             FROM users WHERE id = ?`,
            [id]
        );
    }

    // ------------------------------------------------------------------
    // PR-Q3 additions — see refactor plan. These finish the inline-users-
    // table SQL migration for moderation.js, bug-reports.js, ShopService,
    // ContinuousRecordingService, and the server/index.js stragglers. As
    // with the PR-Q2 additions, where the legacy SQL did NOT stamp
    // `updated_at`, we preserve that behavior (i.e. we do NOT auto-stamp).
    // ------------------------------------------------------------------

    /**
     * Minimal `{ username }` projection by id — used by the server/index.js
     * recording listing routes that only need the username string.
     */
    async getUsernameById(id) {
        return await this.getAsync(
            `SELECT username FROM users WHERE id = ?`,
            [id]
        );
    }

    /**
     * Lookup helper for callers that have an opaque identifier which may be
     * either a username or a numeric user id. Returns `{ id, username }` or
     * undefined. Mirrors the legacy ContinuousRecordingService projection
     * `SELECT id, username FROM users WHERE username = ? OR id = ?`.
     *
     * The caller is responsible for casting non-numeric values to 0 (or any
     * id that will never match) so the second `id = ?` branch is harmless.
     * We accept that coercion as a parameter to keep this method honest
     * about what it does — the SQL itself is unchanged.
     */
    async getByIdOrUsername(usernameValue, idValue) {
        return await this.getAsync(
            `SELECT id, username FROM users WHERE username = ? OR id = ?`,
            [usernameValue, idValue]
        );
    }

    /**
     * Moderation: ban a user from chat. Mirrors the legacy SQL byte-for-
     * byte — `chat_banned_at = CURRENT_TIMESTAMP` is a SQL literal (DB
     * clock, not JS clock), and `updated_at` is NOT touched.
     */
    async banFromChat(targetUserId, moderatorId) {
        return await this.runAsync(
            `UPDATE users SET chat_banned = 1, chat_banned_at = CURRENT_TIMESTAMP, chat_banned_by = ? WHERE id = ?`,
            [moderatorId, targetUserId]
        );
    }

    /**
     * Moderation: timeout a user from chat. `chat_timeout_until` is an ISO
     * string supplied by the caller (legacy SQL parameterized it). Does
     * NOT touch `updated_at`.
     */
    async setChatTimeout(targetUserId, moderatorId, timeoutUntilIso) {
        return await this.runAsync(
            `UPDATE users SET chat_timeout_until = ?, chat_timeout_by = ? WHERE id = ?`,
            [timeoutUntilIso, moderatorId, targetUserId]
        );
    }

    /**
     * Moderation: ban a user from streaming. `streaming_banned_at =
     * CURRENT_TIMESTAMP` is a SQL literal. Does NOT touch `updated_at`.
     */
    async banFromStreaming(targetUserId, moderatorId) {
        return await this.runAsync(
            `UPDATE users SET streaming_banned = 1, streaming_banned_at = CURRENT_TIMESTAMP, streaming_banned_by = ? WHERE id = ?`,
            [moderatorId, targetUserId]
        );
    }
}

module.exports = UserRepository;
