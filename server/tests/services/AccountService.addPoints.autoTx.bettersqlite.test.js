/**
 * better-sqlite3 leg of the addPoints auto-tx contract (DB7-remainder).
 *
 * Runs in the dedicated `config/jest/jest.bettersqlite.config.js` process
 * (`npm run test:bettersqlite`) so node-sqlite3 is NEVER loaded alongside
 * better-sqlite3 — co-loaded, better-sqlite3 stops throwing on errors,
 * which silently defuses this contract's rollback regression pin. The
 * node-sqlite3 leg is the sister file
 * `AccountService.addPoints.autoTx.test.js`; shared bodies live in
 * `_addPoints-autoTx-contract.js`.
 *
 * NOTE: nothing required here may transitively load node-sqlite3 — the
 * jest.mock of server/database/database keeps AccountService / the
 * repositories / PointsManager's lazy withTransaction require off the real
 * module (whose self-boot would pull sqlite3).
 */

const dbSlot = {
    runAsync: null,
    getAsync: null,
    allAsync: null,
    withTransaction: null,
};

jest.mock('../../database/database', () => ({
    get db() { return null; },
    runAsync: (...args) => dbSlot.runAsync(...args),
    getAsync: (...args) => dbSlot.getAsync(...args),
    allAsync: (...args) => dbSlot.allAsync(...args),
    withTransaction: (...args) => dbSlot.withTransaction(...args),
    _betterAdapter: () => null,
}));

const { createBetterSqlite3Adapter } = require('../../database/database-better');
const { defineAddPointsAutoTxContract } = require('./_addPoints-autoTx-contract');

function makeBetterPrimitives() {
    const adapter = createBetterSqlite3Adapter(':memory:');
    return {
        db: adapter.db,
        runAsync: adapter.runAsync,
        getAsync: adapter.getAsync,
        allAsync: adapter.allAsync,
        close: () => { adapter.close(); return Promise.resolve(); },
    };
}

defineAddPointsAutoTxContract('true', makeBetterPrimitives, dbSlot);
