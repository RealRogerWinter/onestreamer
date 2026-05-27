/**
 * Add `chat_color` to user_stats. Per-user chat color preference.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'user_stats', 'chat_color', 'TEXT DEFAULT NULL', logger);
}

module.exports = { run };
