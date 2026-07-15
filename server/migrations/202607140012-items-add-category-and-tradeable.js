/**
 * Add `category` and `is_tradeable` to items.
 *
 *   - category TEXT DEFAULT 'general' — exists on the live DB (drift) but
 *     was created by no DDL anywhere; promoted for exact live↔fresh parity.
 *
 *   - is_tradeable BOOLEAN DEFAULT 0 — NEW schema, existed NOWHERE (not
 *     live, not any DDL) even though InventoryService.giftItem gates gifting
 *     on it: every gift against the real schema failed with "no such
 *     column". DEFAULT 0 is behavior-preserving — gifting stays blocked for
 *     every item exactly as in prod today. Marking any item tradeable is a
 *     product decision; deliberately no seeding of 1s here.
 *
 * Both columns are also in the inline items DDL in database.js for fresh
 * boots; this migration backfills stale/live DBs.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'items', 'category', "TEXT DEFAULT 'general'", logger);
    addColumn(db, 'items', 'is_tradeable', 'BOOLEAN DEFAULT 0', logger);
}

module.exports = { run };
