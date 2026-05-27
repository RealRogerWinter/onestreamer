/**
 * Add buff/debuff metadata columns to the items table.
 *
 * - duration_seconds: how long the effect lasts when applied.
 * - effect_data: JSON blob describing the effect's runtime parameters.
 * - stack_behavior: 'replace' | 'stack' | 'extend' — how the effect combines
 *   with an already-active instance of the same item.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'items', 'duration_seconds', 'INTEGER DEFAULT 0', logger);
    addColumn(db, 'items', 'effect_data', 'TEXT', logger);
    addColumn(db, 'items', 'stack_behavior', "TEXT DEFAULT 'replace'", logger);
}

module.exports = { run };
