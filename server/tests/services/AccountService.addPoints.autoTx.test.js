/**
 * node-sqlite3 leg of the addPoints auto-tx contract (DB7-remainder).
 *
 * Shared bodies + rationale live in `_addPoints-autoTx-contract.js`. The
 * better-sqlite3 leg is the sister file
 * `AccountService.addPoints.autoTx.bettersqlite.test.js`, run in its own
 * isolated jest process (`npm run test:bettersqlite`) because the two
 * native SQLite bindings corrupt each other's error handling when loaded
 * together (better-sqlite3 stops throwing — which would silently defuse
 * the contract's rollback regression pin).
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

const sqlite3 = require('sqlite3').verbose();
const { defineAddPointsAutoTxContract } = require('./_addPoints-autoTx-contract');

function makeSqlite3Primitives() {
    const db = new sqlite3.Database(':memory:');
    const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
    const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
    const allAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    return { db, runAsync, getAsync, allAsync, close: () => new Promise((r) => db.close(r)) };
}

defineAddPointsAutoTxContract('false', makeSqlite3Primitives, dbSlot);
