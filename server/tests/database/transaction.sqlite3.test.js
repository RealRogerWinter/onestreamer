/**
 * node-sqlite3 leg of the withTransaction contract (ADR-0015).
 *
 * Runs in the main jest config alongside the other node-sqlite3 prod-path
 * tests. The better-sqlite3 leg is the sister file
 * `transaction.bettersqlite.test.js` (separate process — see that file and
 * `_with-transaction-contract.js` for why the legs are split).
 */
const sqlite3 = require('sqlite3').verbose();
const { defineWithTransactionContract } = require('./_with-transaction-contract');

function makeSqlite3Primitives() {
    const db = new sqlite3.Database(':memory:');
    db.serialize(() => {
        db.run('PRAGMA busy_timeout = 5000');
    });
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

defineWithTransactionContract('false', makeSqlite3Primitives);
