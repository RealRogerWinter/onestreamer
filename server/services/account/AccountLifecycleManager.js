/**
 * AccountLifecycleManager.js - account-deletion lifecycle operations extracted
 * from AccountService.
 *
 * Deletion request/confirm/restore, audit logging, pending-deletion listing,
 * and the permanent cascade purge. Reads owner.userRepository /
 * owner.userSessionRepository / owner.db / owner.getUserById via the `owner`
 * back-reference so behavior is byte-identical to the in-service form. The
 * inline cascade-delete loop (the enumerated table list IS the audit trail)
 * is preserved verbatim — only `this.`→`owner.`.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'AccountService' });

class AccountLifecycleManager {
    constructor(owner) {
        this.owner = owner;
    }

    async requestDeletion(userId, deletionToken, tokenExpires) {
        const owner = this.owner;
        const requestedAtIso = new Date().toISOString();
        const scheduledForIso = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days from now

        await owner.userRepository.requestDeletion(userId, {
            requestedAtIso,
            token: deletionToken,
            tokenExpiresIso: tokenExpires.toISOString(),
            scheduledForIso
        });

        // Log the deletion request
        await owner.logDeletionAction(userId, 'deletion_requested');
        return true;
    }

    async confirmDeletion(token) {
        const owner = this.owner;
        let user;
        try {
            user = await owner.userRepository.findByDeletionToken(token);
        } catch (err) {
            return { success: false, error: 'Database error' };
        }

        if (!user) {
            return { success: false, error: 'Invalid or expired deletion token' };
        }

        try {
            await owner.userRepository.confirmDeletion(user.id);
        } catch (err) {
            return { success: false, error: 'Failed to confirm deletion' };
        }

        // Log the confirmation
        await owner.logDeletionAction(user.id, 'deletion_confirmed');
        return { success: true, userId: user.id };
    }

    async restoreAccount(userId) {
        const owner = this.owner;
        const result = await owner.userRepository.restoreFromDeletion(userId);
        if (result.changes === 0) {
            return false; // No rows updated
        }
        // Log the restoration
        await owner.logDeletionAction(userId, 'account_restored');
        return true;
    }

    async logDeletionAction(userId, action, ipAddress = null, userAgent = null) {
        const owner = this.owner;
        // PR 10.3 (Phase 10): moved off raw `db.run` callback shape onto
        // the repo's runAsync-backed insertDeletionLog. The legacy code
        // SWALLOWED audit-log INSERT failures (logged + resolved false
        // instead of rejecting); the swallow shape is preserved here at
        // the service level via try/catch.
        const user = await owner.getUserById(userId);
        if (!user) return false;

        try {
            await owner.userSessionRepository.insertDeletionLog({
                userId,
                username: user.username,
                email: user.email,
                action,
                ipAddress,
                userAgent,
            });
            return true;
        } catch (err) {
            logger.error('Failed to log deletion action:', err);
            return false;
        }
    }

    async getAccountsPendingDeletion() {
        const owner = this.owner;
        const rows = await owner.userRepository.listPendingDeletion();
        return rows || [];
    }

    async permanentlyDeleteAccount(userId) {
        const owner = this.owner;
        // Log the permanent deletion
        await owner.logDeletionAction(userId, 'data_purged');

        // **Cascade-delete loop stays inline by design** (PR 10.3 / Phase 10).
        // The enumerated table list IS the audit trail for what
        // permanent-deletion covers. Replacing it with N
        // repo-method calls would expand the diff without changing
        // semantics, and three of the seven tables aren't owned
        // by any repo yet (`user_inventory` is owned by
        // UserInventoryRepository but the others aren't). A future
        // PR can revisit once every table has a repo.
        const tables = [
            'user_sessions',
            'user_stats',
            'ip_to_user_transfers',
            'user_inventory',
            'item_usage_history',
            'user_points_log',
            'account_deletion_logs'
        ];

        for (const table of tables) {
            await new Promise((res, rej) => {
                owner.db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId], (err) => {
                    if (err) rej(err);
                    else res(true);
                });
            });
        }

        // Finally, mark the user as deleted (keep record for audit)
        await owner.userRepository.purgeAccount(userId);
        return true;
    }
}

module.exports = AccountLifecycleManager;
