/**
 * Test fixture (NOT a real migration — lives outside server/migrations/ so
 * the boot runner never discovers it). Exports no run() function; the DB6 /
 * ADR-0035 fail-loud contract requires the runner to abort, not skip.
 */

'use strict';

module.exports = { notRun: true };
