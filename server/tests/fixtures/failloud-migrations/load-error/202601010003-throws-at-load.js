/**
 * Test fixture (NOT a real migration — lives outside server/migrations/ so
 * the boot runner never discovers it). Throws at require() time — e.g. a
 * migration whose top-level require of a helper is broken. The DB6 /
 * ADR-0035 fail-loud contract requires the runner to abort, not skip.
 */

'use strict';

throw new Error('fixture migration failed to load');
