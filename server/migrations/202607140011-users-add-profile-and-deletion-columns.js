/**
 * Add the users profile + account-deletion columns that live-DB drift
 * carried but fresh boot never created (audit finding DB1's second half):
 *
 *   - username_changed              — one-time username-change gate; part of
 *                                     UserRepository.getByUsername's
 *                                     login-path SELECT (fresh clones could
 *                                     not log a user in without it)
 *   - deletion_* + account_status   — account-deletion lifecycle
 *                                     (UserRepository deletion methods,
 *                                     AccountLifecycleManager)
 *   - bio/website/location/display_name/avatar_url/description
 *                                   — profile fields (AccountProfileManager,
 *                                     UserRepository profile SELECTs)
 *
 * Shapes match the live DB byte-for-byte (verified read-only against prod).
 * account_status carries a CHECK constraint — legal in SQLite's ALTER TABLE
 * ADD COLUMN because the default is a constant; pinned by a migration test.
 *
 * The two supporting indexes also live here (not in database.js) because on
 * a stale DB they can only be created AFTER the addColumn backfill; fresh
 * DBs get them on first boot the same way since migrations run every boot.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'users', 'username_changed', 'BOOLEAN DEFAULT 0', logger);
    addColumn(db, 'users', 'deletion_requested_at', 'DATETIME DEFAULT NULL', logger);
    addColumn(db, 'users', 'deletion_confirmed_at', 'DATETIME DEFAULT NULL', logger);
    addColumn(db, 'users', 'deletion_scheduled_for', 'DATETIME DEFAULT NULL', logger);
    addColumn(db, 'users', 'deletion_token', 'TEXT DEFAULT NULL', logger);
    addColumn(db, 'users', 'deletion_token_expires', 'DATETIME DEFAULT NULL', logger);
    addColumn(
        db,
        'users',
        'account_status',
        "TEXT DEFAULT 'active' CHECK(account_status IN ('active', 'pending_deletion', 'deleted'))",
        logger
    );
    addColumn(db, 'users', 'bio', 'TEXT DEFAULT NULL', logger);
    addColumn(db, 'users', 'website', 'TEXT DEFAULT NULL', logger);
    addColumn(db, 'users', 'location', 'TEXT DEFAULT NULL', logger);
    addColumn(db, 'users', 'display_name', 'TEXT DEFAULT NULL', logger);
    addColumn(db, 'users', 'avatar_url', 'TEXT', logger);
    addColumn(db, 'users', 'description', 'TEXT', logger);

    const index = (sql) => db.run(sql, (err) => {
        if (err) {
            logger.error({ err }, 'Migration CREATE INDEX failed');
        }
    });
    index('CREATE INDEX IF NOT EXISTS idx_users_account_status ON users(account_status)');
    index('CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled ON users(deletion_scheduled_for)');
}

module.exports = { run };
