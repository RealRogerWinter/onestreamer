/**
 * better-sqlite3 leg of the withTransaction contract (ADR-0015).
 *
 * Runs in the dedicated `config/jest/jest.bettersqlite.config.js` process so
 * node-sqlite3 is NEVER loaded alongside better-sqlite3 — the two native SQLite
 * bindings corrupt each other's error handling in one process (better-sqlite3
 * stops throwing). The node-sqlite3 leg is the sister file
 * `transaction.sqlite3.test.js`, run by the main config. Shared bodies live in
 * `_with-transaction-contract.js`.
 */
const { createBetterSqlite3Adapter } = require('../../database/database-better');
const { defineWithTransactionContract } = require('./_with-transaction-contract');

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

defineWithTransactionContract('true', makeBetterPrimitives);
