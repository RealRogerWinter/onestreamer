# ADR-0013: Atomic SQL for mutable per-row counters

**Date**: 2026-05-27
**Status**: Accepted
**Phase**: 5 (DB layer)
**PR**: 5.1 (`atomic-points-updates`)

## Context

`AccountService.addPoints` / `subtractPoints` were a read-compute-write loop:

```js
const stats = await this.getUserStats(userId);
const currentBalance = stats?.points_balance || 0;
const newBalance = currentBalance + amount;
await runAsync('UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
               [newBalance, userId]);
```

Two concurrent callers — e.g. a buff purchase that subtracts and a chat
points award that adds in the same tick — both `SELECT`, both compute against
the same stale `currentBalance`, both `UPDATE` with their own absolute value.
The second write overwrites the first. Points get lost or duplicated
depending on which writer wins.

The race was documented (and reproducible) in
`server/tests/services/AccountService.points-race.test.js` with a 20-way
concurrent `Promise.all` of `addPoints(userId, 5)` against a microtask-
interleaving DB mock. Pre-PR-5.1 the test asserted `toBeLessThan(N*amount)`
— the bug was the contract.

Other per-row mutable counters in the codebase (`user_stats.total_stream_time`,
`user_stats.chat_message_count`, `user_inventory.quantity` for stack-able
items, `clips.view_count`, …) have the same shape and the same hazard, but
none of them are on the same hot path as points; PR 5.1 fixes points first
and codifies the principle here so future counter additions land atomic
from the start.

## Decision

**Any mutation of a per-row mutable counter MUST be a single atomic SQL
statement using relative arithmetic, never a JS-side read-compute-write
round trip.**

The canonical shapes:

```sql
-- Increment
UPDATE <table>
   SET <counter> = <counter> + ?,
       updated_at = CURRENT_TIMESTAMP
 WHERE <row-key> = ?
RETURNING <counter>;

-- Decrement with floor guard
UPDATE <table>
   SET <counter> = <counter> - ?,
       updated_at = CURRENT_TIMESTAMP
 WHERE <row-key> = ?
   AND <counter> >= ?
RETURNING <counter>;
```

`RETURNING` (SQLite 3.35+; the Node process here links `node-sqlite3@5.1.7`
which statically bundles engine 3.44.2 — verified with
`SELECT sqlite_version()`) gives the post-write value in the same
statement, eliminating the follow-up `SELECT` round-trip and the second
race window it would open.

For the upsert case (counter row may not exist yet), the rule is:

1. Try the relative-arithmetic `UPDATE … RETURNING`.
2. If `RETURNING` yields no row, the target didn't exist — fall through to
   an `INSERT` with the increment as the initial value.

The narrow second-tick race here (two concurrent first-time `addPoints`
callers both seeing no row, both `INSERT`ing) has two viable closures:

1. **Add a `UNIQUE(<row-key>)` constraint** and switch to
   `INSERT … ON CONFLICT(<row-key>) DO UPDATE SET <counter> = <counter> + ?
   RETURNING <counter>`. One statement, atomic, idiomatic.
2. **Guard the INSERT** with `INSERT INTO <table> (<row-key>, <counter>)
   SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM <table> WHERE <row-key> = ?)`
   then re-issue the UPDATE…RETURNING. Two statements, atomic per
   statement, loops once on first-INSERT contention, does **not** need a
   schema change. Acceptable when adding a UNIQUE constraint is heavier
   than the residual race is worth.

PR 5.1 ships *neither* — the residual race is bounded (only fires on the
first `addPoints` ever called against a brand-new user, and production
data shows zero duplicate user_stats rows on the 2026-05-27 snapshot). A
follow-up PR will pick option 1 or option 2 when the wider schema
cleanup lands and can be staged with a deduplication pre-check.

For the decrement-with-floor case, the guarded `WHERE` makes the
insufficient-balance check part of the same statement, so two concurrent
debits can't both pass a JS-side `if (currentBalance < amount)` check and
then both subtract. The trade-off: when the guarded `UPDATE` returns
nothing, the service has to do a follow-up `SELECT` to populate the error
message ("Has: X, Needs: Y"). That `SELECT` can race with concurrent
mutations and report a slightly stale balance in the error string. We
accept this — the *guard* is atomic; the *error message* is best-effort
diagnostics. No business invariant depends on the error string.

## Consequences

### Positive

- **Lost-update race closed for points.** The headline win. PR 5.1's race
  test now asserts the exact atomic answer (`toBe(N*amount)`) where the
  pre-fix gate asserted `toBeLessThan`.
- **One SQL round-trip instead of three.** Old path: SELECT (existence
  check) + UPDATE + `recordTransaction`'s INSERT. New path: UPDATE
  RETURNING + INSERT. Hot paths (buff purchase, chat-points award) get a
  ~30 % round-trip-count reduction even before PR 5.2's better-sqlite3
  switch.
- **Pattern is repeatable.** When PR 5.3 (or a future PR) refactors
  TimeTrackingService's `total_stream_time` accumulator or the inventory
  `quantity` updates, the SQL shape is already established.

### Negative / Trade-offs

- **Insufficient-balance error string can be stale.** As above: the
  follow-up SELECT after a guarded-UPDATE miss races with concurrent
  mutations. The error message may show a balance that's already moved on.
  Acceptable because the *decision* (refuse the debit) is correct; only
  the *narrative* drifts.
- **`UNIQUE(user_id)` on `user_stats` not added.** A first-time `addPoints`
  for a brand-new user has a narrow window where two concurrent callers
  both INSERT and the table ends up with duplicate rows for the same
  user_id. Production data shows zero duplicates today (verified via
  `SELECT user_id, COUNT(*) FROM user_stats GROUP BY user_id HAVING COUNT(*) > 1`
  on the 2026-05-27 snapshot), and the realistic concurrency for a *first*
  award to a *new* user is essentially zero (it's gated behind signup +
  one of: first chat message, first viewing minute, first stream). A
  follow-up PR can add the constraint + a backfill-safe migration when a
  more comprehensive schema cleanup lands.
- **`RETURNING` shifts the call from `runAsync` to `getAsync`.** Both wrap
  the same sqlite3 connection, but `db.run` discards rows while `db.get`
  reads the first one. The wrapper signatures are unchanged; the only
  visible difference at call sites is which helper the SQL is passed to.
  PR 5.2's better-sqlite3 adapter will need to preserve `RETURNING`-via-
  `getAsync` semantics — flagged for that ADR; no hard constraint imposed
  from here.
- **`updated_at = CURRENT_TIMESTAMP` is now bumped on every points
  change.** The pre-PR `UPDATE` didn't touch the column, so `updated_at`
  on `user_stats` rows could be older than the last `points_balance`
  mutation. Strictly more truthful now; a behavior change for any
  consumer that filters or orders `user_stats` by `updated_at` (a `grep`
  finds none today, but flagged so a future query author isn't surprised).
- **`ShopService` pre-check is now redundant.** `ShopService.purchaseItem`
  (around `server/services/ShopService.js:207`) reads `getPointsBalance`
  and gates the purchase in JS before calling `subtractPoints`. That
  read-then-decide window is racy by definition, but harmless: the
  authoritative refusal is now the guarded `UPDATE`, and the pre-check
  only serves as an early-return for the cheap "definitely too poor"
  case. Leaving it in place — removing it is its own micro-PR that should
  also reshape the "insufficient balance" error path to read the
  exception's `.message`.

## Alternatives considered

### A. Wrap read-compute-write in a `BEGIN IMMEDIATE` transaction

```js
await runAsync('BEGIN IMMEDIATE');
try {
  const stats = await getAsync(...);
  await runAsync('UPDATE ... = ?', [stats.points_balance + amount, ...]);
  await runAsync('COMMIT');
} catch (e) { await runAsync('ROLLBACK'); throw e; }
```

Rejected because:
1. **Same number of round-trips, more locking.** `BEGIN IMMEDIATE` acquires
   a reserved lock on the DB, serializing every other writer for the
   duration of the JS round-trip. The relative-arithmetic UPDATE acquires
   the lock only for the statement's duration.
2. **Bigger blast radius for a stuck transaction.** A pre-`COMMIT` error
   that doesn't propagate into the `catch` (e.g. an event-loop hiccup
   between the UPDATE and the COMMIT) leaves the lock held until the
   sqlite3 driver's idle timeout. Single-statement updates can't get
   stuck in this way.
3. **The whole point of relative arithmetic is to push the read-compute
   into the engine.** A transaction wrapper still does the compute in JS;
   it just makes the wrong shape safe instead of making the shape right.

### B. Application-level lock (mutex keyed by user_id)

```js
await this.userLocks.acquire(userId);
try { ...read-compute-write... } finally { this.userLocks.release(userId); }
```

Rejected because:
1. **In-process only.** The chat microservice (separate process, separate
   sqlite3 connection) also touches `user_stats` in some code paths. A
   mutex in the main process doesn't protect against the chat service's
   writes. Atomic SQL does.
2. **Memory growth.** A per-user lock map grows with the user count; needs
   eviction policy + a cache that never gets full enough to actually
   matter, then forgotten about until it does.
3. **The DB already has the right primitive.** Reaching past it to
   reinvent locking in JS is a category error.

### C. Optimistic-concurrency retry (version column + CAS)

Add a `version` column, read with version, UPDATE with `WHERE version = ?`,
retry on `changes === 0`. Rejected because:
1. **Adds a schema column for every counter.** Migration cost.
2. **Unbounded retry under contention** — could starve a writer on a hot
   row.
3. **Solves a problem we don't have.** Optimistic concurrency is for cases
   where the "compute" part is genuinely expensive enough to want to do
   outside the DB. `balance + amount` isn't.

## Implementation notes

- `AccountService.addPoints` / `subtractPoints` rewritten to use
  `UPDATE … RETURNING` via `getAsync`. INSERT fallback on `addPoints`
  when the target row didn't exist.
- `recordTransaction` is unchanged; it still inserts the (now atomically
  computed) post-write balance into `points_transactions.balance_after`.
- Test contract flipped: `AccountService.points-race.test.js` now asserts
  `toBe(expectedIfAtomic)` for both add and subtract; the test mock's
  `getAsync` understands the new relative-arithmetic UPDATE … RETURNING
  shape (longest pattern first so the guarded subtract matches before the
  plain add).
- No new dependency. No schema change.
- No callsite change in any of the ~14 `addPoints`/`subtractPoints`
  consumers (`server/routes/internal.js`, `server/services/ShopService.js`,
  `server/services/TimeTrackingService.js`) — the public method signatures
  and return values are byte-equivalent.

## Follow-ups

- **Close the first-INSERT race on `addPoints`.** Pick one of the two
  options listed in "Decision" above (UNIQUE + ON CONFLICT, or the
  `WHERE NOT EXISTS` guarded INSERT + UPDATE retry). The UNIQUE-index
  variant requires an `ALTER TABLE` and a duplicate-row pre-check; the
  WHERE NOT EXISTS variant doesn't. Choice depends on whether the
  broader schema cleanup is already shipping migrations at the same
  time — if yes, UNIQUE is cleaner; if no, WHERE NOT EXISTS is cheaper.
- **Apply the same pattern to TimeTrackingService.** `total_stream_time`
  and related accumulators have the same read-compute-write shape; the
  race is less obvious because the per-second accumulator is tied to a
  single session, but a session-handoff edge case could still lose
  seconds. PR 5.3 territory.
- **PR 5.2 better-sqlite3 adapter** must preserve `RETURNING`-via-getAsync.
  Cross-referenced in that ADR.

## References

- ADR-0011 — LifecycleManager (Phase 4): same "centralize a hazard"
  shape, applied to deferred-work instead of counter mutations.
- `server/tests/services/AccountService.points-race.test.js` — the
  regression gate.
