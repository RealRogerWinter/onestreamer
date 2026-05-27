# ADR-0015: Transaction shape for multi-statement DB operations

_Status: accepted_
_Date: 2026-05-27_
_Phase: 7 (Money flow atomic + repo extraction)_
_PR: 7.1 (`withtransaction-helper`)_
_Cross-references: [ADR-0013a](0013a-atomic-sql-for-mutable-counters.md)
(single-statement atomicity for counters; what this ADR extends to multi-
statement scopes), [ADR-0014](0014-better-sqlite3-adapter.md) (the
multi-handle WAL topology this helper interacts with via the writer lock)._

## Context

PR 5.1 ([ADR-0013a](0013a-atomic-sql-for-mutable-counters.md)) closed
the lost-update race on `addPoints` / `subtractPoints` by collapsing the
read-compute-write loop into a single relative-arithmetic SQL statement
(`UPDATE … SET points_balance = points_balance ± ? … RETURNING
points_balance`). That fix is sufficient for **single-statement** atomicity.

It is NOT sufficient for the next hazard the Phase 7 roadmap calls out:
`ShopService.purchaseItem` is a **multi-statement** flow:

1. `subtractPoints(userId, price)` — already atomic (PR 5.1).
2. `INSERT INTO user_inventory …`
3. `INSERT INTO item_transactions …` (audit log).

If the process crashes between (2) and (3), or between (1) and (2), the
user has paid for an item the audit log doesn't record (and possibly that
the inventory doesn't carry either). That's a direct user-visible loss
of points. The Phase 7 roadmap classifies this as the highest-risk
hazard in the entire roadmap.

Multi-statement atomicity requires a transaction (`BEGIN … COMMIT`). The
question is HOW to expose that transaction shape to the codebase such
that it composes with:

- both the sqlite3 NPM (async, libuv-pool-backed) AND the better-sqlite3
  adapter (sync, in-process) — per [ADR-0014](0014-better-sqlite3-adapter.md),
  the active backend is operator-selected via `USE_BETTER_SQLITE3`;
- the existing repository pattern, where repo methods accept `{getAsync,
  runAsync, allAsync}` as a constructor dep override so they can be
  redirected to a tx-scoped wrapper inside a transactional body without
  knowing they're in a transaction;
- the four-or-more open handles to the WAL'd DB file from the same
  process (the connection-count topology from ADR-0014), where one
  handle holding the writer lock causes the others to SQLITE_BUSY-spin
  up to `busy_timeout` ms.

## Decision

Add a helper at `server/database/transaction.js`:

```js
const withTransaction = createWithTransaction({ runAsync, getAsync, allAsync });

await withTransaction(async (tx) => {
    await tx.runAsync('UPDATE user_stats SET points_balance = points_balance - ? WHERE user_id = ? AND points_balance >= ?', [price, userId, price]);
    await tx.runAsync('INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)', [userId, itemId, 1]);
    await tx.runAsync('INSERT INTO item_transactions (user_id, item_id, transaction_type, quantity, price_per_item, total_cost) VALUES (?, ?, "purchase", 1, ?, ?)', [userId, itemId, price, price]);
}, { busyTimeoutMs: 5000 });
```

The helper:

1. **Mutex.** Holds a process-wide Promise-chain mutex so two concurrent
   `withTransaction` calls cannot interleave their statements on the
   shared connection. The chain is private state inside the closure
   returned by `createWithTransaction`; nothing outside the helper can
   reorder scopes.
2. **`BEGIN IMMEDIATE … COMMIT` (or ROLLBACK on throw).** IMMEDIATE
   acquires the RESERVED writer lock at BEGIN time. If another handle
   holds the lock, the BEGIN itself fails (SQLITE_BUSY) bounded by the
   connection's `busy_timeout`. Failing at BEGIN is a cleaner error
   shape than the DEFERRED alternative's "BEGIN succeeded, mid-tx
   UPDATE failed, body half-done" shape.
3. **`tx` proxy.** The body fn receives `tx = { runAsync, getAsync,
   allAsync }`, identical in shape to the module-level wrappers. Repo
   methods constructed with `{getAsync: tx.getAsync, ...}` as deps run
   their queries inside the transaction without knowing they're in one.
   This is what lets the existing repos (UserRepository,
   UserInventoryRepository, ShopRepository, …) be reused for both
   transactional and non-transactional paths without per-method tx
   variants.
4. **Optional `busyTimeoutMs`.** Applied to the connection for the
   scope via `PRAGMA busy_timeout = N` and restored to 5000 ms on exit
   (success OR failure). Lets callers fail fast under writer-lock
   contention; defaults to the standard 5000 ms when not passed.

## Why a helper, not inline `BEGIN IMMEDIATE`

The original Phase 7 sketch called for "just `await runAsync('BEGIN
IMMEDIATE'); … await runAsync('COMMIT');` inside the service method."
The red-team review caught a critical flaw with that shape under the
sqlite3 backend:

Each `runAsync(...)` queues a libuv-thread-pool job. Between the
BEGIN's resolution and the next statement's submission, the JS event
loop runs other tasks. Any of those tasks that calls `runAsync(...)`
submits a statement that the binding will execute on the same
connection — INSIDE the open transaction context — and it will commit
or roll back with our scope. That's a correctness hazard, not a
theoretical one: the codebase has dozens of `runAsync` call paths
firing on timers, socket events, and HTTP handlers; any one of them
that lands inside a transaction window mutates our tx.

The helper closes this by holding a JS-level mutex around the entire
`BEGIN`/body/`COMMIT` sequence. While the mutex is held, no other
`withTransaction` scope can start. The remaining hazard — a code path
that calls the bare module-level `runAsync` (not via a `withTransaction`
scope and not via a repo invoked inside one) while a scope is open — is
documented in the helper's doc-comment and acknowledged as a sharp
edge.

The follow-up that would close this gap entirely is "open a dedicated
sqlite3 handle for transactions"; that's deliberately out of scope for
PR 7.1 because:

- the practical risk is low under both backends: the codebase's hot
  writes are scoped to specific services, and Phase 7's whole point
  is to funnel money-flow writes through `withTransaction`. Other
  write paths (chat-message inserts, view-bot heartbeats) don't
  compete for the same rows. **Note**: the hazard is backend-
  independent — a bare `await runAsync(...)` from a timer or socket
  handler during an open scope executes on the same handle inside
  the open tx regardless of whether `USE_BETTER_SQLITE3` is on. The
  better-sqlite3 backend doesn't make this safer; the mutex defends
  both backends equally;
- adding a dedicated handle adds a fourth-or-fifth open connection to
  the same WAL'd file, which interacts with the connection-count
  trade-off discussed in ADR-0014 and would itself need an ADR.

If the sharp edge ever bites in production (operator reports of
"writes mysteriously rolled back during a buff-purchase tx"), the
dedicated-handle migration is a follow-up ADR with one PR's worth of
work.

## Why BEGIN IMMEDIATE (not BEGIN / BEGIN DEFERRED)

SQLite has three transaction modes:

- **DEFERRED (default)**: no lock acquired at BEGIN. First write
  attempt inside the body upgrades to RESERVED; if another writer has
  it, the inner statement fails.
- **IMMEDIATE**: RESERVED lock acquired at BEGIN time. If another
  writer has it, the BEGIN itself fails (bounded by `busy_timeout`).
- **EXCLUSIVE**: full lock at BEGIN. Blocks readers too. Overkill for
  WAL-mode DBs.

IMMEDIATE wins because it fails at BEGIN (a discrete, retryable error
shape) rather than mid-body (where the body has already run some
statements that the ROLLBACK then has to undo). The retry semantics are
also cleaner: a SQLITE_BUSY on BEGIN means "another writer is in flight;
back off and try again"; a SQLITE_BUSY on a mid-body statement means
the same thing but the caller has already committed JS-level
side-effects (object updates, logging, return value computation) that
have to be unwound.

## Why NOT better-sqlite3's `db.transaction(fn)`

The better-sqlite3 library ships a `db.transaction(fn)` helper that
returns a transaction-wrapped function. It's synchronous, atomic, and
the obvious choice — except it requires a **sync body**. Our extracted
repos return promises (the adapter's `runAsync` is
`Promise.resolve(syncResult)`), and the body fn that calls them is
async. Mixing `await` into a `db.transaction(fn)` body is explicitly
unsupported by better-sqlite3 and will reorder statements relative to
the transaction scope in surprising ways.

The "use `BEGIN`/`COMMIT` SQL statements via the adapter's `runAsync`"
shape composes with async bodies and preserves byte-identical semantics
across both backends. The cost — losing better-sqlite3's
known-atomic-block guarantee — is bounded by the mutex (no two scopes
can interleave). The bare-`runAsync`-during-scope hazard discussed
above applies equally to both backends: an unrelated handler that
calls `runAsync(...)` during an open scope executes on the same handle
inside the open tx, whether the binding is sqlite3 (libuv-async) or
better-sqlite3 (sync). The mutex prevents helper-vs-helper
interleaving on either backend; discipline prevents non-helper writes
from polluting either backend.

## Interaction with the multi-handle WAL topology (ADR-0014)

`USE_BETTER_SQLITE3=true` opens at least four connections to the same
WAL'd `onestreamer.db`:

- the main sqlite3 handle in `database.js`;
- the better-sqlite3 adapter handle;
- `WhitelistService`'s own sqlite3 handle;
- `URLStreamDatabaseService`'s own sqlite3 handle.

When `withTransaction` runs, its `BEGIN IMMEDIATE` acquires the writer
lock on ONE of those handles (whichever backend the helper's `runAsync`
points at). The other three see SQLITE_BUSY on conflicting writes and
spin up to their own `busy_timeout` (5000 ms by default). For a
buff-purchase transaction at human-click cadences, the writer lock is
held for milliseconds — contention is theoretical. For batch operations
or future heavy-write paths, the contention is real: `withTransaction`'s
`busyTimeoutMs` option exists exactly so a caller can choose to fail
fast (`busyTimeoutMs: 500`) instead of stalling its own event loop for
five seconds.

The mitigation if this trade-off ever bites: drop the `busy_timeout` on
the contending handle to a smaller value (sub-second) so SQLITE_BUSY
surfaces as a discrete error instead of a stall. Documented for ops in
the helper's doc-comment.

## Consequences

### Positive

- **Multi-statement atomicity is a first-class primitive.** PR 7.4 can
  collapse the non-atomic three-statement `purchaseItem` flow into one
  `withTransaction` call. PR 10.2 (`ClipRepository` atomic CREATE)
  consumes the same helper. Future flows that need atomicity have a
  shape to copy.
- **No per-method `withTx` variants in repos.** Repo methods stay
  ignorant of whether they're in a transaction; the dep-injection
  shape from PR 5.3 forward already accepts `{getAsync, runAsync,
  allAsync}` as constructor overrides. The `tx` proxy is shape-
  identical to those overrides.
- **Both backends supported.** No env-flag-conditional code paths in
  callers. The same `withTransaction(fn)` body runs unchanged whether
  sqlite3 or better-sqlite3 is active.
- **Crash safety relies on SQLite's standard recovery, not on this
  helper's code.** A process crash mid-tx leaves the file-backed WAL'd
  DB in a state that SQLite's next-open recovery rolls back; the
  helper does not own this property — it inherits it from SQLite. For
  Phase 7's specific hazard (server crash between subtractPoints and
  the inventory INSERT), the user's points are NOT debited because the
  COMMIT didn't fire and SQLite's recovery undoes the partial work.
  **What the PR 7.4 integration tests actually verify** is the
  JS-level ROLLBACK path: a thrown error inside the body fn causes
  the helper to issue a `ROLLBACK` statement that undoes all
  uncommitted writes against the same connection. The tests run
  against `:memory:` connections (no WAL, no rollback journal on
  disk), so they exercise the in-process rollback only. The actual
  cross-process crash-recovery property is not tested by this PR;
  it's the contract SQLite has already provided for years on
  file-backed WAL'd databases. If a future regression in either
  SQLite's recovery or the way the helper interacts with WAL needs
  to be caught, a dedicated test would have to spawn a subprocess,
  kill it mid-tx, reopen the file, and assert no committed delta.

### Negative / Trade-offs

- **Sharp edge: bare-`runAsync` writes during a scope window.** As
  detailed above, a write that calls the module-level `runAsync`
  during a `withTransaction` scope runs inside the transaction. This
  is discipline-enforced, not code-enforced. The follow-up to close
  it would be a dedicated tx handle (out of scope for PR 7.1, tracked
  for a future ADR if it bites).
- **Writer-lock contention is real on multi-handle topology.** The
  mitigation is the `busyTimeoutMs` option. The default (5000 ms) is
  the right choice for click-driven flows like buff purchases; batch
  flows should pass a smaller value.
- **Mutex serialization caps tx throughput at one-at-a-time.** For
  the kind of writes Phase 7 covers (single-user, click-driven,
  money-flow) this is exactly the right shape: bursts of concurrent
  purchases from one user are vanishingly rare, and inter-user
  isolation is provided by per-row WHERE clauses inside the tx.
  Bulk-import or backfill flows that need higher tx throughput would
  need a different shape (dedicated handle + connection pool); that's
  out of scope.
- **Sharp edge: nested `withTransaction` calls deadlock.** The mutex
  holder calls `withTransaction` again from inside its scope. The
  inner call waits for the outer's mutex release, which can only
  happen when the outer's body returns, which is waiting on the
  inner. SQLite also rejects nested `BEGIN`. Documented in the
  helper's doc-comment; callers should never nest. If a body needs
  to delegate work that itself wants a tx, the inner work should
  accept the existing `tx` as a parameter and reuse it, not start a
  new scope.

## Alternatives considered

### A. Inline `BEGIN IMMEDIATE` / `COMMIT` per service method

Rejected by the red-team finding above. The sqlite3 backend's libuv
queuing model means bare inline BEGIN doesn't actually serialize
subsequent awaits on the same handle — other callers can interleave
statements into the open tx. The helper's mutex is the fix.

### B. better-sqlite3's `db.transaction(fn)` with sync repos

Would require rewriting every repo method to be sync — flattening
~6 repos and ~200 callsites for an architectural decision (sync vs.
async DB access) that ADR-0014 already considered and rejected. Out
of scope.

### C. Dedicated tx handle per scope

Open a new sqlite3 connection per `withTransaction` call, run
BEGIN/body/COMMIT on the new handle, close it. Closes the
bare-`runAsync`-during-scope hazard cleanly. Rejected for PR 7.1:

- one file descriptor + page cache per opened handle is non-trivial
  on a multi-tx workload (each open is ~50–100 ms wall-clock + small
  but real memory);
- the existing per-process handle topology is already at four-plus
  per ADR-0014; adding "N more" is its own ADR.

Tracked as a follow-up if the discipline-enforced sharp edge ever
bites in production.

### D. Use SQLite's SAVEPOINTs for nested scopes

Add SAVEPOINT support so nested `withTransaction` calls become nested
savepoints rather than deadlocks. Rejected: complicates the helper's
state machine, and the use case (a tx body calling code that wants its
own tx) is better solved by threading the existing `tx` through —
which is the pattern repo methods already follow via the dep-injection
shape.

## Implementation notes

- **New file**: `server/database/transaction.js` —
  `createWithTransaction({ runAsync, getAsync, allAsync })` →
  `(fn, { busyTimeoutMs }) => Promise<*>`.
- **Wired into `database.js`**: instantiated once at module-load time
  AFTER the `USE_BETTER_SQLITE3` swap, so the helper captures the
  active backend's wrappers. Exported as a singleton.
- **Tests**: `server/tests/database/transaction.test.js` — 20 tests
  under `describe.each([{flag:'true'},{flag:'false'}])` covering
  happy-path commit, body-throw rollback, statement-error rollback
  (UNIQUE constraint), post-rollback recovery, two-concurrent-scopes
  serialization order, error-scope-doesn't-block-next-scope,
  busy_timeout PRAGMA apply + restore on success + restore on
  failure. Each test runs against a fresh `:memory:` connection of
  the appropriate backend.
- **ADR-0013 number collision fix**: PR 7.1 also renames
  `0013-atomic-sql-for-mutable-counters.md` →
  `0013a-atomic-sql-for-mutable-counters.md` to resolve a parallel-
  branch number collision. The AI moderation ADR keeps the bare
  `0013`. Cross-references in ADR-0014 and CHANGELOG.md updated.

## Follow-ups

- **PR 7.2 — `UserInventoryRepository`.** Extracts the inventory-table
  SQL into a repository that PR 7.4 will compose under
  `withTransaction`.
- **PR 7.3 — `ItemTransactionRepository` + read-only `ShopRepository`.**
  Same shape, different tables.
- **PR 7.4 — `ShopService.purchaseItem` atomic refactor.** The first
  real consumer of `withTransaction`. Wraps subtractPoints + inventory
  INSERT + transactions INSERT in a single scope. Reviewer subagent
  pass mandatory; live smoke through the buff-purchase step of
  `docs/getting-started/first-stream.md` mandatory.
- **PR 10.2 — `ClipRepository` atomic CREATE.** Cross-phase consumer.
- **(Conditional follow-up ADR)** Dedicated tx handle if the
  bare-`runAsync`-during-scope sharp edge ever surfaces in production.
