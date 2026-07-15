/**
 * Add `points_balance` to user_stats — the economy's atomic counter
 * (AccountStatsRepository.atomicAdd/SubtractPoints, TimeTrackingService's
 * 1 Hz earning timer).
 *
 * Historically this column was only ever created by the legacy one-shot
 * server/migrations/migrate-points-system.js, which is NOT in the boot path —
 * so any clone created after that script's era booted with a dead economy
 * (audit finding DB1). The inline user_stats DDL in database.js now carries
 * the column for fresh DBs; this migration backfills stale clones. No-op on
 * the live DB (column exists). Shape matches live byte-for-byte:
 * `INTEGER DEFAULT 0`.
 *
 * (points_transactions, the companion audit table, needs no migration —
 * database.js's CREATE TABLE IF NOT EXISTS converges it every boot.)
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'user_stats', 'points_balance', 'INTEGER DEFAULT 0', logger);
}

module.exports = { run };
