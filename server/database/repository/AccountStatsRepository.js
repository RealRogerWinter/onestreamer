/**
 * AccountStatsRepository
 *
 * Pure SQL wrapper for the user-economy tables:
 *   - user_stats           (one row per user; carries the points_balance
 *                           atomic counter + cumulative stream/view stats)
 *   - points_transactions  (1:N audit log of points add/subtract events
 *                           with balance_after snapshots)
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Domain orchestration (when to
 * call addPoints vs. subtractPoints, what the transaction type strings
 * mean, the bcrypt/oauth flows that surround them) stays in
 * AccountService.
 *
 * Constructor mirrors the established repository pattern: deps may be
 * injected for unit-test mocking; when omitted the repo falls back to
 * the real primitives from `server/database/database.js`.
 *
 * **PR 5.1 / ADR-0013a atomic-counter shape preserved.** The
 * `atomicAddPoints` and `atomicSubtractPoints` methods use
 * `UPDATE … SET col = col ± ? … RETURNING col` (relative
 * arithmetic + post-write read in a single statement). DO NOT
 * refactor to a read-compute-write loop. The single-statement
 * shape is what closes the lost-update race between concurrent
 * callers; the repo extraction must be byte-equivalent.
 *
 * Extracted from `server/services/AccountService.js` in PR 10.3 (Phase 10).
 * Pre-extraction: 10 inline SQL call-sites against user_stats +
 * points_transactions.
 */
class AccountStatsRepository {
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
    // user_stats
    // ============================================================

    /**
     * INSERT a fresh user_stats row with only `user_id` set; every
     * other column takes its DEFAULT (points_balance = 0, the
     * cumulative-stat columns also 0). Called from
     * `AccountService.createUserStats` immediately after user
     * creation.
     *
     * OR IGNORE (audit DB5 / ADR-0035): user_stats(user_id) is UNIQUE
     * now, and a concurrent first-credit may have upserted the row
     * before this runs — in that case the row (with its balance) must
     * survive and signup must not fail, so the duplicate INSERT is a
     * silent no-op.
     */
    async insertEmptyStats(userId) {
        return await this.runAsync(
            'INSERT OR IGNORE INTO user_stats (user_id) VALUES (?)',
            [userId]
        );
    }

    /**
     * Race-safe first-credit UPSERT (audit DB5 / ADR-0035). Used by the
     * `atomicAddPoints` fallback path when the RETURNING-clause UPDATE
     * found no row — the user has no stats row yet, so INSERT one with
     * the just-added points as the starting balance.
     *
     * Two concurrent first-credits can BOTH miss the UPDATE and both
     * land here; the plain-INSERT predecessor then created two rows
     * (permanent balance corruption — later UPDATEs hit all rows,
     * reads see one). ON CONFLICT(user_id) — backed by the
     * idx_user_stats_user_id_unique index — folds the loser into an
     * atomic increment instead, and RETURNING reports the post-write
     * balance either way (goes through getAsync, which consumes
     * RETURNING rows on both drivers — same ADR-0013/0014 contract as
     * atomicAddPoints).
     *
     * @returns {{points_balance: number}} the post-upsert balance row
     */
    async upsertStatsWithBalance({ userId, balance }) {
        return await this.getAsync(
            `INSERT INTO user_stats (user_id, points_balance)
             VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
                 points_balance = points_balance + excluded.points_balance,
                 updated_at = CURRENT_TIMESTAMP
             RETURNING points_balance`,
            [userId, balance]
        );
    }

    /**
     * Dynamic-SET UPDATE driven by the user-supplied `setFragments`
     * + `values`. The caller (AccountService.updateUserStats)
     * already builds the relative-arithmetic fragments (`total_stream_time = total_stream_time + ?`,
     * etc.) and the absolute-assignment ones (`last_stream_at = ?`)
     * and passes them in pre-built. The repo's job is to append
     * `updated_at = CURRENT_TIMESTAMP` + the WHERE-by-user_id and
     * execute. Whitelist enforcement lives in the service since
     * the relative-vs-absolute decision is per-column and
     * domain-specific.
     */
    async updateStats(userId, setFragments, values) {
        if (!Array.isArray(setFragments) || setFragments.length === 0) {
            return { changes: 0 };
        }
        const sql = `UPDATE user_stats SET ${[...setFragments, 'updated_at = CURRENT_TIMESTAMP'].join(', ')} WHERE user_id = ?`;
        return await this.runAsync(sql, [...values, userId]);
    }

    /**
     * SELECT the full user_stats row by user_id.
     */
    async getStatsByUserId(userId) {
        return await this.getAsync(
            'SELECT * FROM user_stats WHERE user_id = ?',
            [userId]
        );
    }

    /**
     * SELECT points_balance only. Used by `atomicSubtractPoints`'s
     * error-message disambiguation (the difference between "no row"
     * and "row exists but balance < amount" is human-meaningful for
     * the error string).
     */
    async getPointsBalanceByUserId(userId) {
        return await this.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = ?',
            [userId]
        );
    }

    /**
     * **Atomic relative-arithmetic UPDATE + RETURNING** — PR 5.1 /
     * ADR-0013a. Bumps `points_balance` by `amount` (positive number
     * by AccountService precondition) and returns the post-write
     * value in a single statement. Returns undefined if no row
     * exists (caller falls back to `upsertStatsWithBalance`).
     *
     * **DO NOT** refactor to a read-compute-write loop. The single
     * statement is what closes the lost-update race.
     */
    async atomicAddPoints({ userId, amount }) {
        return await this.getAsync(
            `UPDATE user_stats
                SET points_balance = points_balance + ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ?
          RETURNING points_balance`,
            [amount, userId]
        );
    }

    /**
     * **Atomic guarded relative-arithmetic UPDATE + RETURNING** — PR
     * 5.1 / ADR-0013a. Debits `amount` from `points_balance` ONLY
     * if the row exists AND has enough balance. Returns undefined
     * on no-match (caller uses `getPointsBalanceByUserId` to
     * disambiguate "no row" vs "insufficient balance" for the
     * error string).
     *
     * The guard (`AND points_balance >= ?`) is the SQL-level fence
     * against negative balances; concurrent debits each fail or
     * succeed atomically based on their own snapshot of the
     * balance.
     */
    async atomicSubtractPoints({ userId, amount }) {
        return await this.getAsync(
            `UPDATE user_stats
                SET points_balance = points_balance - ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ?
                AND points_balance >= ?
          RETURNING points_balance`,
            [amount, userId, amount]
        );
    }

    /**
     * DELETE a user_stats row. Called from
     * `AccountService.deleteUser` and from the cascade in
     * `permanentlyDeleteAccount` (though that path still uses raw
     * `db.run` for the cascade-loop ergonomics — see the
     * AccountService comment).
     */
    async deleteStatsByUserId(userId) {
        return await this.runAsync(
            'DELETE FROM user_stats WHERE user_id = ?',
            [userId]
        );
    }

    // ============================================================
    // points_transactions
    // ============================================================

    /**
     * INSERT a points-transaction audit row. `amount` is signed
     * (positive for credit, negative for debit). `balance_after`
     * is the post-write balance from the atomic-add/subtract
     * call's RETURNING clause. `metadataJson` is null OR a
     * pre-stringified JSON blob — the service handles the
     * `JSON.stringify(metadata)` step before invoking.
     */
    async insertTransaction({ userId, amount, balanceAfter, type, description, metadataJson }) {
        return await this.runAsync(
            `INSERT INTO points_transactions
             (user_id, amount, balance_after, type, description, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, amount, balanceAfter, type, description, metadataJson]
        );
    }

    /**
     * SELECT transaction history for a user, newest first, capped by
     * `limit`. Used by the admin API to render the points-activity
     * panel.
     */
    async listTransactionsByUserId(userId, limit) {
        return await this.allAsync(
            `SELECT * FROM points_transactions
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [userId, limit]
        );
    }
}

module.exports = AccountStatsRepository;
