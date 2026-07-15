/**
 * PointsManager.js - points/balance operations extracted from AccountService.
 *
 * Owns the atomic points ledger: add/subtract balance and transaction
 * records. Reads owner.accountStatsRepository via the `owner` back-reference
 * so behavior is byte-identical to the in-service form. The atomic
 * UPDATE … RETURNING locking/ordering semantics (ADR-0013) are preserved
 * verbatim — only `this.`→`owner.`.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'AccountService' });
const AccountStatsRepository = require('../../database/repository/AccountStatsRepository');

class PointsManager {
    constructor(owner) {
        this.owner = owner;
    }

    /**
     * Repo to write through: the caller's tx-scoped one when a `tx` handle
     * is supplied (ADR-0029 — the write then joins the caller's open
     * withTransaction scope), the owner's default otherwise. `tx` has the
     * exact {runAsync,getAsync,allAsync} shape the repo constructor takes,
     * mirroring the ClipService/ADR-0015 tx-scoped-repo pattern.
     */
    _statsRepo(tx) {
        return tx ? new AccountStatsRepository(tx) : this.owner.accountStatsRepository;
    }

    /**
     * Add points to user's balance
     * @param {number} userId - User ID
     * @param {number} amount - Amount to add (must be positive)
     * @param {string} type - Transaction type (streaming, viewing, chat, bonus, etc)
     * @param {string} description - Human-readable description
     * @param {object} metadata - Optional metadata for the transaction
     * @returns {number} New balance
     */
    async addPoints(userId, amount, type, description, metadata = null, tx = null) {
        if (amount <= 0) {
            throw new Error('Amount must be positive');
        }

        // DB7-remainder (audit Plan 04): non-tx callers (timer/chat/buff
        // writers, /award-points, admin grants) used to run the balance
        // UPDATE and the audit INSERT as two bare statements — a crash
        // between them left a credit with no ledger row. Open an implicit
        // scope so the pair commits or rolls back together for ALL callers.
        //
        // CALLER CONTRACT unchanged: code already inside a withTransaction
        // body MUST keep passing its `tx` handle through (nesting
        // withTransaction deadlocks — see server/database/transaction.js).
        // Lazy require dodges module-load cycles; test doubles that mock the
        // database module without withTransaction fall through to the legacy
        // two-statement path.
        if (!tx) {
            const { withTransaction } = require('../../database/database');
            if (typeof withTransaction === 'function') {
                return await withTransaction((scopedTx) =>
                    this.addPoints(userId, amount, type, description, metadata, scopedTx)
                );
            }
        }
        const repo = this._statsRepo(tx);

        // Atomic relative-arithmetic UPDATE. RETURNING gives us the post-write
        // balance without a follow-up SELECT, so concurrent callers can't
        // race on stale reads (ADR-0013a). PR 10.3 routes through the
        // repo — the SQL is byte-equivalent to the legacy inline form.
        const updated = await repo.atomicAddPoints({ userId, amount });

        let newBalance;
        if (updated) {
            newBalance = updated.points_balance;
        } else {
            // No stats row yet — upsert with the amount as the initial
            // balance. ON CONFLICT(user_id) (audit DB5 / ADR-0035): two
            // concurrent first-credits can both miss the UPDATE above; the
            // loser's INSERT folds into an atomic increment instead of
            // creating a duplicate row, and RETURNING gives the true
            // post-write balance (which may exceed `amount` when we lost
            // that race).
            const upserted = await repo.upsertStatsWithBalance({ userId, balance: amount });
            newBalance = upserted.points_balance;
        }

        await this.owner.recordTransaction(userId, amount, newBalance, type, description, metadata, tx);

        logger.debug(`💰 Added ${amount} points to user ${userId} (${type}). New balance: ${newBalance}`);
        return newBalance;
    }

    /**
     * Subtract points from user's balance
     * @param {number} userId - User ID
     * @param {number} amount - Amount to subtract (must be positive)
     * @param {string} type - Transaction type (purchase, penalty, etc)
     * @param {string} description - Human-readable description
     * @param {object} metadata - Optional metadata for the transaction
     * @returns {number} New balance
     */
    async subtractPoints(userId, amount, type, description, metadata = null, tx = null) {
        if (amount <= 0) {
            throw new Error('Amount must be positive');
        }
        const repo = this._statsRepo(tx);

        // Atomic guarded UPDATE: only debit if the row exists AND has enough
        // balance. RETURNING gives us the post-debit balance for the
        // transaction record; no follow-up SELECT, no race window. PR 10.3
        // routes through the repo — the SQL is byte-equivalent to the
        // legacy inline form.
        const updated = await repo.atomicSubtractPoints({ userId, amount });

        if (!updated) {
            // Either no stats row or insufficient balance — disambiguate
            // for the error message. The SELECT can race with concurrent
            // mutations but it's only feeding the error string.
            //
            // E7: typed AccountServiceError(400) instead of a plain Error, so
            // routes surface a client 400 instead of an opaque 500 when the
            // atomic guard loses a race that the caller's pre-check passed.
            // Lazy require to dodge the PointsManager ⟷ AccountService
            // circular import (same pattern as AdminPointsManager).
            const { AccountServiceError } = require('../AccountService');
            const stats = await repo.getPointsBalanceByUserId(userId);
            const currentBalance = stats?.points_balance || 0;
            throw new AccountServiceError(400, `Insufficient points balance. Has: ${currentBalance}, Needs: ${amount}`);
        }

        const newBalance = updated.points_balance;

        await this.owner.recordTransaction(userId, -amount, newBalance, type, description, metadata, tx);

        logger.debug(`💸 Subtracted ${amount} points from user ${userId} (${type}). New balance: ${newBalance}`);
        return newBalance;
    }

    /**
     * Get user's current points balance
     * @param {number} userId - User ID
     * @returns {number} Current balance
     */
    async getPointsBalance(userId) {
        const owner = this.owner;
        const stats = await owner.getUserStats(userId);
        return stats?.points_balance || 0;
    }

    /**
     * Record a points transaction. With a `tx` handle the audit INSERT joins
     * the caller's scope — the balance UPDATE and its audit row then commit
     * or roll back together (audit DB7, on tx-supplied paths).
     */
    async recordTransaction(userId, amount, balanceAfter, type, description, metadata = null, tx = null) {
        await this._statsRepo(tx).insertTransaction({
            userId,
            amount,
            balanceAfter,
            type,
            description,
            metadataJson: metadata ? JSON.stringify(metadata) : null,
        });
    }
}

module.exports = PointsManager;
