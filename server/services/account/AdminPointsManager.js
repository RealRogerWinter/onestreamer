/**
 * AdminPointsManager.js - audited admin grant/revoke operations extracted
 * from AccountService (PR 16.4).
 *
 * Funnels through owner.addPoints / owner.subtractPoints so the audit row
 * carries `type='admin_award'` / `type='admin_deduction'`. The is_admin
 * guard, target resolution, and balance precheck all route back through the
 * owner (owner.getUserById / owner.getUserByUsername / owner.getPointsBalance)
 * so route handlers and the existing test's instance-level overrides keep
 * working. Throws AccountServiceError, defined on AccountService.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'AccountService' });

class AdminPointsManager {
    constructor(owner) {
        this.owner = owner;
    }

    /**
     * PR 16.4: admin grant. Verifies the caller is_admin, resolves
     * targetUsername to a user row, then funnels through `addPoints` with
     * `type='admin_award'` so the audit row carries the standard ledger
     * type. Extracted from the inline /api/internal/admin/award-points
     * handler in server/routes/internal.js.
     *
     * Auth (Bearer token + decoded.id === adminUserId) stays in the
     * handler — this method assumes the caller has proven they are
     * adminUserId; what it adds is the is_admin row-level check.
     *
     * @throws {AccountServiceError} 403 'Admin access required' when the
     *                               adminUserId row is missing or has
     *                               is_admin = 0; 404 `User 'X' not found`
     *                               when targetUsername doesn't resolve.
     * @returns {Promise<{ newBalance, targetUserId, targetUsername }>}
     *          Same subset the pre-PR handler used to build its 200 body.
     */
    async adminGrantPoints(adminUserId, targetUsername, amount) {
        const owner = this.owner;
        const { AccountServiceError } = require('../AccountService');
        const adminUser = await owner.getUserById(adminUserId);
        if (!adminUser || !adminUser.is_admin) {
            throw new AccountServiceError(403, 'Admin access required');
        }

        const targetUser = await owner.getUserByUsername(targetUsername);
        if (!targetUser) {
            throw new AccountServiceError(404, `User '${targetUsername}' not found`);
        }

        const newBalance = await owner.addPoints(
            targetUser.id,
            amount,
            'admin_award',
            `Admin award by ${adminUser.username}`,
            { adminId: adminUserId }
        );

        logger.debug(
            `💰 ADMIN: ${adminUser.username} awarded ${amount} points to ${targetUsername}. New balance: ${newBalance}`
        );

        return {
            newBalance,
            targetUserId: targetUser.id,
            targetUsername: targetUser.username,
        };
    }

    /**
     * PR 16.4: admin revoke. Sibling of adminGrantPoints — same is_admin
     * guard, same target resolution, but adds a balance precheck (the
     * service throws 400 if `amount > currentBalance`, matching the pre-PR
     * `User only has X points` message) and funnels through
     * `subtractPoints` with `type='admin_deduction'`.
     *
     * @throws {AccountServiceError} 403 'Admin access required'; 404
     *                               `User 'X' not found`; 400
     *                               `User only has X points (cannot
     *                               deduct Y)`.
     * @returns {Promise<{ newBalance, targetUserId, targetUsername }>}
     */
    async adminRevokePoints(adminUserId, targetUsername, amount) {
        const owner = this.owner;
        const { AccountServiceError } = require('../AccountService');
        const adminUser = await owner.getUserById(adminUserId);
        if (!adminUser || !adminUser.is_admin) {
            throw new AccountServiceError(403, 'Admin access required');
        }

        const targetUser = await owner.getUserByUsername(targetUsername);
        if (!targetUser) {
            throw new AccountServiceError(404, `User '${targetUsername}' not found`);
        }

        const currentBalance = await owner.getPointsBalance(targetUser.id);
        if (currentBalance < amount) {
            throw new AccountServiceError(
                400,
                `User only has ${currentBalance} points (cannot deduct ${amount})`
            );
        }

        const newBalance = await owner.subtractPoints(
            targetUser.id,
            amount,
            'admin_deduction',
            `Admin deduction by ${adminUser.username}`,
            { adminId: adminUserId }
        );

        logger.debug(
            `💸 ADMIN: ${adminUser.username} deducted ${amount} points from ${targetUsername}. New balance: ${newBalance}`
        );

        return {
            newBalance,
            targetUserId: targetUser.id,
            targetUsername: targetUser.username,
        };
    }
}

module.exports = AdminPointsManager;
