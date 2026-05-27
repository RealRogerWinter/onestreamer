/**
 * Add is_admin / is_banned / is_moderator flags to users.
 *
 * Originally inline ALTERs in server/database/database.js. The fresh-clone
 * CREATE TABLE for users already includes these columns, so this migration
 * is a no-op on fresh DBs. On older DBs (pre-flags-era), it backfills.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'users', 'is_admin', 'BOOLEAN DEFAULT 0', logger);
    addColumn(db, 'users', 'is_banned', 'BOOLEAN DEFAULT 0', logger);
    addColumn(db, 'users', 'is_moderator', 'BOOLEAN DEFAULT 0', logger);
}

module.exports = { run };
