/**
 * Add llm_model selector to the singleton chatbot_config row.
 *
 * The fresh-clone CREATE TABLE for chatbot_config already includes
 * `llm_model TEXT DEFAULT 'mistral'`, so this migration is a no-op on a
 * fresh DB. On older DBs it backfills the column.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'chatbot_config', 'llm_model', "TEXT DEFAULT 'mistral'", logger);
}

module.exports = { run };
