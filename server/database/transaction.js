/**
 * withTransaction — multi-statement atomic operations on the main DB.
 *
 * Wraps a body fn in `BEGIN IMMEDIATE … COMMIT` (or `ROLLBACK` on throw),
 * serialized at the JS layer via a process-wide Promise-chain mutex so
 * two concurrent `withTransaction` calls cannot interleave their
 * statements on the shared connection.
 *
 * Why a helper, not inline `BEGIN IMMEDIATE`
 * ------------------------------------------
 * Under the sqlite3 binding, `await runAsync('BEGIN IMMEDIATE')` does
 * NOT by itself serialize subsequent `await runAsync(...)` calls. Each
 * `runAsync(...)` queues a libuv-thread-pool job; between the BEGIN's
 * resolution and the next statement's submission, any unrelated caller
 * elsewhere in the process that calls `runAsync(...)` can submit a
 * statement, and the binding will run it on the same handle — INSIDE the
 * open transaction context, committing or rolling back with our scope.
 * That's a correctness hazard.
 *
 * The mutex closes the in-process hole: at most one scope runs at a time.
 * The `BEGIN IMMEDIATE` then closes the cross-handle hole: other handles
 * to the same WAL'd DB (the four-handle topology from ADR-0014) see
 * SQLITE_BUSY on conflicting writes for up to `busy_timeout` ms.
 *
 * Discipline (NOT enforced by code — documented as a sharp edge):
 *   Code that runs a write via the bare module-level `runAsync` while
 *   a `withTransaction` scope is open will execute on the same
 *   connection inside that scope. That's mostly a non-issue because
 *   the helper holds the mutex and any honest caller goes through it,
 *   but a fire-and-forget `runAsync('UPDATE …')` from a timer or
 *   socket handler IS a leak. Funnel atomic-needing writes through
 *   `withTransaction`; leave fire-and-forget writes to non-atomic
 *   paths only.
 *
 * Do NOT nest withTransaction calls
 * ---------------------------------
 * Calling `withTransaction` from inside another `withTransaction`
 * body deadlocks: the inner call waits for the outer's mutex
 * release, which can only happen when the outer's body returns,
 * which is itself waiting on the inner. SQLite also rejects nested
 * `BEGIN`. If a body needs to delegate work that wants a tx, pass
 * the existing `tx` argument through to the delegate — repo methods
 * already accept it via the dep-injection shape.
 *
 * Why BEGIN IMMEDIATE (not BEGIN / BEGIN DEFERRED)
 * -----------------------------------------------
 * IMMEDIATE acquires the RESERVED lock at BEGIN time. If another writer
 * holds the lock, the BEGIN itself fails (SQLITE_BUSY) bounded by the
 * connection's `busy_timeout`. Failing at BEGIN is a cleaner error shape
 * than DEFERRED's "BEGIN succeeded, mid-tx UPDATE failed, body half-done"
 * shape.
 *
 * Why NOT better-sqlite3's `db.transaction(fn)`
 * --------------------------------------------
 * `db.transaction(fn)` requires a synchronous body. The callers we're
 * extracting are async (they `await` repo methods, which return
 * promises even when the underlying adapter call is sync). Using
 * `BEGIN`/`COMMIT` statements via the adapter's `runAsync` (which is
 * `Promise.resolve` over a sync better-sqlite3 call) composes with
 * async bodies and preserves byte-identical semantics across both
 * backends.
 *
 * Optional `busyTimeoutMs`
 * -----------------------
 * Callers that prefer to fail fast under writer-lock contention can
 * pass `{ busyTimeoutMs: 500 }` etc. The PRAGMA is applied to the
 * connection for the duration of the scope and restored to the
 * standard 5000 ms default on exit (success OR failure). The default
 * matches `applyPragmas.js` / `database-better.js`.
 *
 * @param {object} deps
 * @param {Function} deps.runAsync - module's `runAsync` wrapper
 * @param {Function} deps.getAsync - module's `getAsync` wrapper
 * @param {Function} deps.allAsync - module's `allAsync` wrapper
 * @returns {(fn: (tx: {runAsync,getAsync,allAsync}) => Promise<*>, opts?: {busyTimeoutMs?: number}) => Promise<*>}
 */
function createWithTransaction({ runAsync, getAsync, allAsync }) {
    let mutex = Promise.resolve();
    // Stuck-state flag (reviewer concern #2): if a ROLLBACK ever fails, the
    // connection is left in an open-tx state. Subsequent `BEGIN IMMEDIATE`
    // calls will fail cryptically with "cannot start a transaction within
    // a transaction." Capture that explicitly so the next caller sees a
    // helper-shaped error instead. There is no automatic recovery; an
    // operator restart is the only safe way back.
    let stuckError = null;

    async function withTransaction(fn, { busyTimeoutMs } = {}) {
        const prev = mutex;
        let release;
        mutex = new Promise((r) => { release = r; });
        try {
            await prev;
            if (stuckError) {
                throw new Error(
                    `withTransaction is stuck: a prior ROLLBACK failed and the connection ` +
                    `may have an open tx. Restart required. Original error: ${stuckError.message}`
                );
            }
            return await runScope(fn, busyTimeoutMs);
        } finally {
            release();
        }
    }

    async function runScope(fn, busyTimeoutMs) {
        // Reviewer concern #1: read the prior busy_timeout so we can restore
        // it exactly, instead of clobbering to a hardcoded 5000. Today every
        // handle in the codebase uses 5000 (applyPragmas.js / database-better.js),
        // but a future operator override or follow-up helper that picks a
        // different value would silently lose it under the hardcoded path.
        let priorBusyTimeoutMs = null;
        if (busyTimeoutMs != null) {
            try {
                const row = await getAsync('PRAGMA busy_timeout');
                if (row && typeof row.timeout === 'number') priorBusyTimeoutMs = row.timeout;
            } catch (_) { /* leave prior=null → restore skipped */ }
            await runAsync(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
        }
        try {
            await runAsync('BEGIN IMMEDIATE');
        } catch (e) {
            if (busyTimeoutMs != null) await restoreBusyTimeout(priorBusyTimeoutMs);
            throw e;
        }
        let result;
        let txError;
        try {
            const tx = { runAsync, getAsync, allAsync };
            result = await fn(tx);
            await runAsync('COMMIT');
        } catch (e) {
            txError = e;
            try {
                await runAsync('ROLLBACK');
            } catch (rollbackErr) {
                // Concern #2: a failed ROLLBACK leaves the connection in
                // an open-tx state. Log loudly and mark the helper stuck
                // so the next scope sees a clear error.
                stuckError = rollbackErr;
                try {
                    // Use a lazy require so transaction.js stays usable in
                    // contexts without the bootstrap logger (tests, isolated
                    // factory instantiation).
                    require('../bootstrap/logger').error(
                        { err: rollbackErr, originalBodyError: txError && txError.message },
                        'withTransaction: ROLLBACK failed; helper marked stuck until restart'
                    );
                } catch (_) { /* logger missing — accept silent in test env */ }
            }
        } finally {
            if (busyTimeoutMs != null) await restoreBusyTimeout(priorBusyTimeoutMs);
        }
        if (txError) throw txError;
        return result;
    }

    async function restoreBusyTimeout(priorMs) {
        if (priorMs == null) return;
        try { await runAsync(`PRAGMA busy_timeout = ${priorMs}`); } catch (_) { /* swallow */ }
    }

    return withTransaction;
}

module.exports = { createWithTransaction };
