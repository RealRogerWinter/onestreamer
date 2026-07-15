/**
 * Test fixture (NOT a real migration — lives outside server/migrations/ so
 * the boot runner never discovers it). Used by migrations.runner.test.js to
 * pin the DB6 / ADR-0035 fail-loud contract: a migration whose run() throws
 * synchronously must abort the whole run.
 */

'use strict';

function run() {
    throw new Error('fixture migration exploded');
}

module.exports = { run };
