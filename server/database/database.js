const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const applyPragmas = require('./applyPragmas');
// The full boot DDL (every CREATE TABLE/INDEX + seeds + numbered migrations)
// lives in ./schema — a side-effect-free module tests can require without
// triggering this module's self-boot against the real data file (ADR-0030).
const { initializeSchema } = require('./schema');

const logger = require('../bootstrap/logger').child({ svc: 'database' });
const dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        logger.error(err, 'Error opening database');
        return;
    }
    logger.info({ dbPath }, 'Connected to SQLite database');
    applyPragmas(db, { tuneForLargeReads: true })
        .then(({ walActive }) => {
            logger.info({ journalMode: walActive ? 'wal' : 'fallback' }, 'SQLite PRAGMAs applied');
            initializeDatabase();
        })
        .catch((e) => {
            logger.error(e, 'Failed to apply SQLite PRAGMAs');
            // Continue with schema setup; the connection is still usable,
            // it's just running with default (less optimal but correct) settings.
            initializeDatabase();
        });
});

function initializeDatabase() {
    initializeSchema(db, logger).catch((e) => {
        logger.error({ err: e }, 'Schema initialization failed');
    });
}

function runAsyncSqlite3(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function getAsyncSqlite3(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allAsyncSqlite3(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// ============================================================================
// ADR-0014: better-sqlite3 adapter behind USE_BETTER_SQLITE3 env flag.
//
// When the flag is true, runAsync/getAsync/allAsync are backed by a
// better-sqlite3 connection (with prepared-statement cache) opened against
// the same database file. The sqlite3 `db` handle stays open and exported
// for legacy consumers that call db.run/.get/.all/.serialize directly
// (routes/admin.js, routes/auth.js, several services + migrations).
//
// SQLite supports multiple connections to the same WAL'd file from the
// same process; both backends see each other's commits through WAL.
// busy_timeout=5000 on both handles bounds SQLITE_BUSY surfacing.
//
// Default is ON since the ADR-0014 Phase-C cutover (2026-07, audit Plan 04
// driver decision): better-sqlite3 backs the wrappers unless the operator
// opts out with the exact string USE_BETTER_SQLITE3=false. The cutover
// remains reversible without a code revert (set the opt-out and restart).
// A load failure still falls back to sqlite3 — but since that now silently
// downgrades the DEFAULT driver, deploy verification must check for the
// 'better-sqlite3 adapter active' line (see the better-sqlite3-rebuild
// runbook).
// ============================================================================

let runAsync = runAsyncSqlite3;
let getAsync = getAsyncSqlite3;
let allAsync = allAsyncSqlite3;
let betterAdapter = null;

if (process.env.USE_BETTER_SQLITE3 !== 'false') {
    try {
        const { createBetterSqlite3Adapter } = require('./database-better');
        betterAdapter = createBetterSqlite3Adapter(dbPath, { tuneForLargeReads: true });
        runAsync = betterAdapter.runAsync;
        getAsync = betterAdapter.getAsync;
        allAsync = betterAdapter.allAsync;
        logger.info(
            { walActive: betterAdapter.walActive, dbPath },
            'better-sqlite3 adapter active (default; set USE_BETTER_SQLITE3=false to opt out)'
        );
    } catch (e) {
        logger.error(
            { err: e },
            'better-sqlite3 adapter failed to load; falling back to sqlite3'
        );
        // Leave runAsync/getAsync/allAsync pointing at the sqlite3 impls.
    }
}

// withTransaction (ADR-0015). Closes over the *current* wrappers — captured
// AFTER the USE_BETTER_SQLITE3 swap above. Module-load order is the contract.
const { createWithTransaction } = require('./transaction');
const withTransaction = createWithTransaction({ runAsync, getAsync, allAsync });

module.exports = {
    db,
    // The GATED primitives (ADR-0029; audit DB2): module-level ops serialize
    // behind any open withTransaction scope instead of implicitly joining it,
    // so a foreign ROLLBACK can never destroy a timer/socket write. In-scope
    // code must write through its `tx` handle (the raw wrappers); an in-scope
    // call that still lands here executes directly with a one-time warning.
    // Legacy direct `db.run/.get/.all` callers bypass the gate (pre-existing
    // hole, tracked separately).
    runAsync: withTransaction.gated.runAsync,
    getAsync: withTransaction.gated.getAsync,
    allAsync: withTransaction.gated.allAsync,
    withTransaction,
    // The production schema bootstrap (ADR-0030), re-exported from ./schema.
    // Tests and fixtures that only need the DDL should require ./schema
    // directly to avoid this module's self-boot side effect.
    initializeSchema,
    // Test-only handle for the adapter, when active. Gated on NODE_ENV so
    // production code physically can't reach the adapter's raw Database
    // (which exposes .exec/.transaction/.backup outside the wrappers).
    // Returns null in production OR when opted out / the adapter failed
    // to load.
    _betterAdapter: () => (process.env.NODE_ENV === 'test' ? betterAdapter : null),
};
