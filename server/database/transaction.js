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
 * The gate (ADR-0029; closes audit DB2)
 * -------------------------------------
 * The above discipline used to be documented-but-unenforced: a bare
 * module-level `runAsync('UPDATE …')` from a timer or socket handler
 * while a scope was open executed on the same connection INSIDE that
 * scope — committed or destroyed by a foreign COMMIT/ROLLBACK.
 *
 * `withTransaction.gated` now exposes gated versions of all three
 * primitives (runAsync/getAsync/allAsync — getAsync included because
 * writes flow through it via UPDATE … RETURNING). database.js exports
 * THOSE as the module-level wrappers, so every repo/service that falls
 * back to module primitives is gated automatically:
 *
 *   - An op issued OUTSIDE any scope joins the same promise-chain mutex
 *     the scopes use — it serializes behind any open scope (and scopes
 *     serialize behind it), so it can never land inside a foreign
 *     BEGIN … COMMIT.
 *   - An op issued INSIDE the currently-open scope (detected via
 *     AsyncLocalStorage token identity, not a boolean — so a
 *     fire-and-forget promise born in scope A that runs while scope B
 *     is open is correctly gated, not treated as B's own) executes
 *     directly on the raw wrapper: it joins its own tx exactly as
 *     before, and logs a one-time-per-statement warning so unplumbed
 *     in-scope paths surface instead of self-deadlocking. Scope bodies
 *     SHOULD write through their `tx` handle (which is the raw,
 *     ungated wrappers) — the warning is the migration pressure.
 *
 * ALS context propagates through await chains; it is only lost across
 * user-land callback queues, which none of the economy paths use. If it
 * ever were lost inside a scope, the op gates and waits for the scope's
 * release — a deadlock — which is why in-scope code must use `tx`.
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
    const { AsyncLocalStorage } = require('async_hooks');

    let mutex = Promise.resolve();
    // Stuck-state flag (reviewer concern #2): if a ROLLBACK ever fails, the
    // connection is left in an open-tx state. Subsequent `BEGIN IMMEDIATE`
    // calls will fail cryptically with "cannot start a transaction within
    // a transaction." Capture that explicitly so the next caller sees a
    // helper-shaped error instead. There is no automatic recovery; an
    // operator restart is the only safe way back.
    let stuckError = null;

    // Scope identity for the gate (ADR-0029). `als` carries the open scope's
    // token down its async call tree; `activeScopeToken` is the token of the
    // scope that currently holds the connection. Token IDENTITY comparison
    // (not a boolean) distinguishes "this op belongs to the open scope"
    // from "this op was born in some other/closed scope".
    const als = new AsyncLocalStorage();
    let activeScopeToken = null;

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

    // ── The gate (ADR-0029) ─────────────────────────────────────────────
    // Gated primitives for module-level export. Outside any scope: join the
    // same mutex chain the scopes use (so a bare op can never interleave
    // into a foreign BEGIN…COMMIT). Inside the open scope (ALS token match):
    // execute directly — the op joins its own tx, with a one-time warning
    // per statement so unplumbed paths surface.
    const warnedStatements = new Set();
    function warnInScopeStraggler(name, sql) {
        const key = `${name}:${sql}`;
        if (warnedStatements.has(key) || warnedStatements.size > 200) return;
        warnedStatements.add(key);
        try {
            require('../bootstrap/logger').warn(
                { sql: String(sql).slice(0, 200) },
                `withTransaction: in-scope ${name} went through the gated module wrapper — ` +
                `plumb the tx handle through instead (ADR-0029)`
            );
        } catch (_) { /* logger missing — accept silent in test env */ }
    }

    function makeGated(raw, name) {
        return async function gated(sql, params) {
            const store = als.getStore();
            if (store !== undefined && store === activeScopeToken) {
                warnInScopeStraggler(name, sql);
                return raw(sql, params);
            }
            const prev = mutex;
            let release;
            mutex = new Promise((r) => { release = r; });
            try {
                await prev;
                return await raw(sql, params);
            } finally {
                release();
            }
        };
    }

    withTransaction.gated = {
        runAsync: makeGated(runAsync, 'runAsync'),
        getAsync: makeGated(getAsync, 'getAsync'),
        allAsync: makeGated(allAsync, 'allAsync'),
    };

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
        const scopeToken = Symbol('withTransaction-scope');
        activeScopeToken = scopeToken;
        try {
            // The tx handle is the RAW wrappers — in-scope writes through it
            // bypass the gate by construction (ADR-0029).
            const tx = { runAsync, getAsync, allAsync };
            result = await als.run(scopeToken, () => fn(tx));
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
            activeScopeToken = null;
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
