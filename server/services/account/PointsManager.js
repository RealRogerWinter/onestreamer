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

class PointsManager {
    constructor(owner) {
        this.owner = owner;
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
    async addPoints(userId, amount, type, description, metadata = null) {
        const owner = this.owner;
        if (amount <= 0) {
            throw new Error('Amount must be positive');
        }

        // Atomic relative-arithmetic UPDATE. RETURNING gives us the post-write
        // balance without a follow-up SELECT, so concurrent callers can't
        // race on stale reads (ADR-0013a). PR 10.3 routes through the
        // repo — the SQL is byte-equivalent to the legacy inline form.
        const updated = await owner.accountStatsRepository.atomicAddPoints({ userId, amount });

        let newBalance;
        if (updated) {
            newBalance = updated.points_balance;
        } else {
            // No stats row yet — INSERT with the amount as the initial balance.
            await owner.accountStatsRepository.insertStatsWithBalance({ userId, balance: amount });
            newBalance = amount;
        }

        await owner.recordTransaction(userId, amount, newBalance, type, description, metadata);

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
    async subtractPoints(userId, amount, type, description, metadata = null) {
        const owner = this.owner;
        if (amount <= 0) {
            throw new Error('Amount must be positive');
        }

        // Atomic guarded UPDATE: only debit if the row exists AND has enough
        // balance. RETURNING gives us the post-debit balance for the
        // transaction record; no follow-up SELECT, no race window. PR 10.3
        // routes through the repo — the SQL is byte-equivalent to the
        // legacy inline form.
        const updated = await owner.accountStatsRepository.atomicSubtractPoints({ userId, amount });

        if (!updated) {
            // Either no stats row or insufficient balance — disambiguate
            // for the error message. The SELECT can race with concurrent
            // mutations but it's only feeding the error string.
            const stats = await owner.accountStatsRepository.getPointsBalanceByUserId(userId);
            const currentBalance = stats?.points_balance || 0;
            throw new Error(`Insufficient points balance. Has: ${currentBalance}, Needs: ${amount}`);
        }

        const newBalance = updated.points_balance;

        await owner.recordTransaction(userId, -amount, newBalance, type, description, metadata);

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
     * Record a points transaction
     */
    async recordTransaction(userId, amount, balanceAfter, type, description, metadata = null) {
        const owner = this.owner;
        await owner.accountStatsRepository.insertTransaction({
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
