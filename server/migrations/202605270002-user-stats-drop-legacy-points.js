/**
 * Drop the legacy `user_stats.points` column.
 *
 * `user_stats.points_balance` is the authoritative balance source per the
 * migrate-points-system migration; the `points` column was its
 * calculated-on-read predecessor and has been unread for some time.
 *
 * Idempotent: a second run errors with "no such column" which the helper
 * silently ignores.
 */

'use strict';

const { dropColumn } = require('./_runner');

function run(db, logger) {
    dropColumn(db, 'user_stats', 'points', logger);
}

module.exports = { run };
