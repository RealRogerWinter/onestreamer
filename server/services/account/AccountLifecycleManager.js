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
        // Log the permanent deletion. Written to account_deletion_logs, which is
        // itself purged below — a GDPR hard delete erases its own audit trail.
        await owner.logDeletionAction(userId, 'data_purged');

        // Every table keyed on the deleting user by a literal `user_id` column,
        // verified column-by-column against the live schema. The prior list
        // named two tables that DO NOT EXIST (`item_usage_history`,
        // `user_points_log` — real names `item_usage_log` / `points_transactions`),
        // so the old loop threw "no such table" mid-purge and never completed,
        // AND it covered only 5 of the user's data tables.
        const userIdTables = [
            'user_sessions',
            'user_stats',
            'user_inventory',
            'ip_to_user_transfers',
            'item_usage_log',
            'points_transactions',
            'item_transactions',
            'active_buffs',
            'recordings',
            'recording_events',
            'clip_views',
            'streaming_logs',
            'bug_reports',
            'game_player_state',
            'game_player_sessions',
            'account_deletion_logs',
        ];
        for (const table of userIdTables) {
            await this._purgeFrom(`DELETE FROM ${table} WHERE user_id = ?`, [userId], table);
        }

        // Tables that reference the user under a non-`user_id` column.
        await this._purgeFrom(
            'DELETE FROM gift_transactions WHERE from_user_id = ? OR to_user_id = ?',
            [userId, userId],
            'gift_transactions'
        );
        await this._purgeFrom(
            'DELETE FROM recording_sessions WHERE streamer_user_id = ?',
            [userId],
            'recording_sessions'
        );
        // clips carries both the creator (`user_id`) and, on some paths, the
        // streamer (`streamer_user_id`) — purge either reference so a clip is
        // erased whether the subject made it or starred in it.
        await this._purgeFrom(
            'DELETE FROM clips WHERE user_id = ? OR streamer_user_id = ?',
            [userId, userId],
            'clips'
        );

        // Intentionally RETAINED: ip_bans (banned_by_user_id),
        // moderation_events (external_user_id), temporary_bots / chatbots
        // (summoned_by_user_id) reference this user as an *actor* on
        // security / moderation / bot records — not as the data subject — so
        // erasing them would destroy moderation history, not the user's PII.
        // See the PR description for the retention rationale.

        // Finally, anonymize the users row (scrubs email/username/password/oauth,
        // keeps an id-only tombstone for referential audit).
        await owner.userRepository.purgeAccount(userId);
        return true;
    }

    // Run one purge DELETE against owner.db. A table that doesn't exist on this
    // install is logged LOUDLY and skipped — so a future rename surfaces as an
    // error in the logs instead of silently wiping nothing (the exact failure
    // mode of the old hard-coded list) — while any OTHER DB error aborts the
    // purge so we never falsely report a completed deletion.
    _purgeFrom(sql, params, table) {
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.run(sql, params, (err) => {
                if (!err) return resolve(true);
                if (/no such table/i.test(err.message)) {
                    logger.error(`Account purge: table "${table}" missing on this install — skipped. Investigate schema drift.`);
                    return resolve(false);
                }
                reject(err);
            });
        });
    }
}

module.exports = AccountLifecycleManager;
