/**
 * Per-user opt-out flag for vision frame capture (privacy control).
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'users', 'vision_audit_optout', 'BOOLEAN DEFAULT 0', logger);
}

module.exports = { run };
