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
}

module.exports = UserRepository;
