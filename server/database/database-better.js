/**
 * better-sqlite3 adapter (ADR-0014).
 *
 * Wraps a better-sqlite3 Database with the same `runAsync` / `getAsync` /
 * `allAsync` shape that the legacy sqlite3-based `database.js` exposes —
 * so the ~357 callsites that consume those wrappers can swap backends
 * behind the `USE_BETTER_SQLITE3=true` env flag without code changes.
 *
 * Why keep the async API on a sync backend:
 *   The callsites are spread across services, route handlers, migrations,
 *   and tests. Flattening them to sync would touch every file. Wrapping
 *   sync better-sqlite3 calls in `Promise.resolve(...)` costs one microtask
 *   per call. The headline perf wins are (a) prepared-statement reuse and
 *   (b) one fewer libuv-thread-pool hop per call; the microtask wrap
 *   doesn't undo either. Real-world ratio against the 2.2 GB onestreamer.db
 *   is unknown until Phase B measurement (ADR-0014).
 *
 * Why prepared-statement cache:
 *   The whole point of better-sqlite3 is to avoid re-parsing SQL on every
 *   call. A naive `db.prepare(sql).run(params)` per call gives no perf win
 *   over sqlite3. The cache here is keyed on SQL text (verbatim) — the
 *   357 callsites use template-literal-free string literals, so the cache
 *   keyspace is bounded by the source code, not by user input.
 *
 * RETURNING semantics (ADR-0013 contract):
 *   `getAsync` / `allAsync` route through `Statement.get()` / `Statement.all()`
 *   which both consume the first RETURNING row on UPDATE/INSERT/DELETE
 *   statements — same shape PR 5.1's `addPoints` / `subtractPoints` already
 *   relies on against the sqlite3 binding. Verified empirically before
 *   shipping; see ADR-0014 for the test matrix.
 */

const Database = require('better-sqlite3');
const logger = require('../bootstrap/logger');

/**
 * @param {string} dbPath - absolute path to the SQLite file (':memory:' for tests)
 * @param {object} [opts]
 * @param {boolean} [opts.tuneForLargeReads=false] - apply the same
 *   large-reads tuning that applyPragmas.js applies to the main handle
 * @param {number}  [opts.stmtCacheLimit=500] - max prepared statements to
 *   keep cached. Eviction is "drop oldest" (insertion order). Bumped from
 *   the napkin estimate of 200 after counting the actual unique SQL strings
 *   across the 357 callsites.
 * @returns {{ db: object, runAsync: Function, getAsync: Function, allAsync: Function, close: Function, walActive: boolean }}
 */
function createBetterSqlite3Adapter(dbPath, { tuneForLargeReads = false, stmtCacheLimit = 500 } = {}) {
    const db = new Database(dbPath);

    // Apply the same per-connection PRAGMAs that applyPragmas.js applies
    // to the sqlite3 handle. `journal_mode = WAL` is the contract — if it
    // doesn't take, we keep synchronous=FULL to avoid the corruption
    // hazard NORMAL+rollback-journal creates on power loss.
    db.pragma('journal_mode = WAL');
    const journalMode = db.pragma('journal_mode', { simple: true });
    const walActive = journalMode === 'wal';

    if (walActive) {
        db.pragma('synchronous = NORMAL');
    } else {
        logger.error(
            { actualMode: journalMode },
            'better-sqlite3: did not enter WAL mode; keeping synchronous=FULL'
        );
    }

    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    if (tuneForLargeReads) {
        db.pragma('temp_store = MEMORY');
        db.pragma('mmap_size = 268435456');  // 256 MB
        db.pragma('cache_size = -64000');    // 64 MB
    }

    // Prepared-statement cache. Keyed on verbatim SQL text. Insertion-order
    // eviction once the size hits stmtCacheLimit; not strict-LRU but good
    // enough — the 357 callsites use a small bounded set of distinct
    // strings, so the cache effectively never evicts in practice.
    //
    // No eviction race: the entire prepareCached() → stmt.run/get/all()
    // path inside each wrapper is synchronous; the cache cannot evict a
    // statement between the lookup and its execution because nothing yields
    // the event loop between those calls. Async wrappers' Promise.resolve
    // only fires AFTER the sync execution completes.
    const stmtCache = new Map();
    let cacheHits = 0;
    let cacheMisses = 0;

    function prepareCached(sql) {
        const cached = stmtCache.get(sql);
        if (cached) {
            cacheHits++;
            return cached;
        }
        cacheMisses++;
        const stmt = db.prepare(sql);
        if (stmtCache.size >= stmtCacheLimit) {
            // Drop oldest insertion. JS Maps preserve insertion order.
            const firstKey = stmtCache.keys().next().value;
            stmtCache.delete(firstKey);
        }
        stmtCache.set(sql, stmt);
        return stmt;
    }

    /**
     * runAsync — DML (INSERT/UPDATE/DELETE) without consuming rows.
     * Return shape matches sqlite3's `{id, changes}` — `id` is the
     * `lastInsertRowid` from better-sqlite3's RunResult.
     */
    function runAsync(sql, params = []) {
        try {
            const stmt = prepareCached(sql);
            const info = params.length ? stmt.run(...params) : stmt.run();
            return Promise.resolve({ id: info.lastInsertRowid, changes: info.changes });
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * getAsync — SELECT or UPDATE/INSERT/DELETE ... RETURNING.
     * Returns the first row (or `undefined` on no-match). The PR 5.1
     * atomic-points code path relies on `undefined` for no-match — that
     * behavior matches better-sqlite3's `.get()` exactly.
     */
    function getAsync(sql, params = []) {
        try {
            const stmt = prepareCached(sql);
            const row = params.length ? stmt.get(...params) : stmt.get();
            return Promise.resolve(row);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * allAsync — SELECT or RETURNING that yields multiple rows.
     * Returns an array (empty array on no-match, never `null` or `undefined`).
     */
    function allAsync(sql, params = []) {
        try {
            const stmt = prepareCached(sql);
            const rows = params.length ? stmt.all(...params) : stmt.all();
            return Promise.resolve(rows);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    function close() {
        stmtCache.clear();
        db.close();
    }

    function cacheStats() {
        return { size: stmtCache.size, hits: cacheHits, misses: cacheMisses, limit: stmtCacheLimit };
    }

    return { db, runAsync, getAsync, allAsync, close, walActive, cacheStats };
}

module.exports = { createBetterSqlite3Adapter };
