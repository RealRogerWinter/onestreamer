# ADR-0035: user_stats uniqueness (dedup + UNIQUE index + upsert) and fail-loud migrations

_Status: accepted_
_Date: 2026-07-15_

Related: [ADR-0013a](0013a-atomic-sql-for-mutable-counters.md) (atomic
counters), [ADR-0022](0022-schema-migrations-layout.md) (numbered migration
runner), [ADR-0030](0030-single-source-schema-ddl.md) (schema.js is the sole
boot DDL source), audit findings **DB5** and **DB6**.

## Context

Two related integrity holes from the 2026-07 audit:

- **DB5 — duplicate user_stats rows.** `user_stats.user_id` had **no
  uniqueness constraint**, and the economy's first-credit path
  (`PointsManager.addPoints`: atomic `UPDATE … RETURNING` per ADR-0013a,
  falling back to a **plain INSERT** when the UPDATE matched no row) let two
  concurrent first-credits for the same user each miss the UPDATE and each
  INSERT a row. From then on every `UPDATE … WHERE user_id = ?` (credits,
  debits, the 1 Hz earning tick) mutated **all** of that user's rows while
  every read (`SELECT`/`RETURNING`) saw only one — permanent, compounding
  balance corruption with no self-healing path. The signup-time
  `insertEmptyStats` INSERT racing a first credit was a second producer of
  the same duplicates.
- **DB6 — the migration runner swallowed every failure.** `_runner.js`
  `continue`d past modules that failed to load or lacked `run()`, logged and
  proceeded when `run()` threw synchronously, and `addColumn`/`dropColumn`
  logged-and-proceeded on **non-benign** statement errors. The boot call site
  (`database.js` → `initializeSchema().catch(log)`) swallowed the rest. A
  half-applied schema therefore booted and served traffic — the failure mode
  that turns a bad deploy into data corruption. (Proof it was live: the
  better-sqlite3 test shim lacked `db.get`, so migration `202605270010` had
  been silently skipped under that shim for weeks — surfaced only when this
  fix made the runner loud.)

## Decision

### 1. `user_stats.user_id` is UNIQUE, first-credit is an upsert (DB5)

- **Migration `202607150900-user-stats-unique-user-id.js`** dedups existing
  duplicates, then `CREATE UNIQUE INDEX IF NOT EXISTS
  idx_user_stats_user_id_unique ON user_stats(user_id)`. **Dedup keeps the
  row with `MAX(points_balance)` per user** (lowest `id` as deterministic
  tie-break). Rationale: once duplicates exist, every subsequent UPDATE hits
  all of a user's rows equally, so the rows differ only by what each captured
  at INSERT time — there is no reconstructably "correct" row, and we resolve
  the ambiguity **in the user's favor**. The discarded rows' cumulative stat
  columns are lost (they differ by at most their INSERT-time defaults).
- **`schema.js` creates the same index for fresh DBs** — queued **after**
  `migrationRunner.runAll` deliberately, because on a stale DB the dedup must
  run before the index can build (same ordering pattern as the
  `202607140011` users indexes). Both creations are `IF NOT EXISTS`;
  whichever runs second is a no-op.
- **The INSERT fallback is now a race-safe upsert**:
  `AccountStatsRepository.upsertStatsWithBalance` —
  `INSERT … ON CONFLICT(user_id) DO UPDATE SET points_balance =
  points_balance + excluded.points_balance … RETURNING points_balance`,
  executed through `getAsync` (which consumes RETURNING rows on both the
  sqlite3 and better-sqlite3 drivers — the same ADR-0013a/0014 contract
  `atomicAddPoints` already relies on). The racing loser folds into an atomic
  increment instead of a second row, and `PointsManager` reports the true
  post-write balance from RETURNING instead of assuming `amount`.
  `insertEmptyStats` (signup) becomes `INSERT OR IGNORE` so a stats row
  upserted by a racing credit survives with its balance and signup doesn't
  throw on the new constraint.

### 2. Migrations fail LOUD (DB6)

- **`_runner.runAll` throws** (after logging) when a migration module fails
  to load, lacks `run()`, or throws synchronously — no more skip-and-
  continue. The throw propagates out of the `db.serialize` scope and rejects
  `initializeSchema`'s promise.
- **Async statement failures** can't throw into `runAll` (migrations queue
  callback-style statements), so the runner gains an **async-failure sink**:
  `addColumn`/`dropColumn` record non-benign errors via
  `recordAsyncFailure()`, and `initializeSchema`'s flush marker — which by
  construction runs after every migration callback has fired — drains the
  sink and **rejects** when anything was recorded.
- **The boot call site aborts**: `database.js` now logs FATAL and
  `process.exit(1)` on schema-init rejection instead of catch-and-log.
  (Exception: under `NODE_ENV === 'test'` it logs without exiting, because
  the module's self-boot can race jest's environment teardown — a
  test-harness artifact that would otherwise kill a whole worker; tests
  exercise the schema through `initializeSchema` directly and still see the
  rejection.)
- **Benign idempotency errors are tolerated exactly as before**: `duplicate
  column` on ADD COLUMN, `no such column` on DROP COLUMN — the ADR-0022
  every-boot idempotency contract is unchanged.

## Consequences

- Duplicate `user_stats` rows are impossible at the schema level; the two
  application-level producers are upserts. First-credit races now land the
  exact arithmetic sum in one row (pinned by tests on both drivers).
- Existing duplicates are resolved once, in the user's favor, by an
  idempotent every-boot migration; on a healthy DB it's a no-op DELETE plus
  a no-op index build.
- A migration that cannot apply now stops the process with a clear FATAL log
  instead of serving traffic on a half-applied schema. **Downtime replaces
  silent corruption — that trade is the point.** Operators will see boot
  failures they previously never knew about (the runbook answer is: fix the
  migration/DB, don't loop the restart).
- The better-sqlite3 test schema shim (`db-fixture.js`) had to grow `get()`
  — the fail-loud runner immediately exposed that migration `202605270010`
  never ran under it.
- Tests asserting runner behavior can inject a migrations directory
  (`runAll(db, logger, dir)`); the boot path is unchanged (defaults to
  `server/migrations/`).

## Alternatives considered

- **Dedup keeping `MIN(id)` (the oldest row)** — rejected: the oldest row is
  not more correct (all rows received every subsequent UPDATE equally), and
  when rows differ it typically holds the *smaller* balance (it predates the
  racing credit) — resolving ambiguity against the user.
- **Summing balances across duplicate rows** — rejected: double-counts. Both
  racing first-credits' UPDATEs hit *all* duplicate rows once the second row
  exists, so each row already contains most credits; `MAX` is the closest
  single-row approximation of the true balance.
- **`UNIQUE` constraint in the `CREATE TABLE` DDL instead of an index** —
  rejected: SQLite cannot add a table constraint via `ALTER TABLE`, so live
  DBs would need a rebuild-and-copy migration; a unique index is
  byte-equivalent for enforcement and `ON CONFLICT` targeting, and keeps
  fresh/stale DDL convergent (ADR-0030 snapshot unchanged — indexes aren't
  in `table_info`).
- **A `schema_migrations` tracking table + transactional migrations** —
  rejected here for the same reasons as ADR-0022: every migration is
  idempotent and re-runs each boot; fail-loud closes the actual audit gap
  (silent failure) without buying the tracking table's bug surface.
- **Retrying/quarantining failed migrations instead of aborting** — rejected:
  any automatic continuation leaves the process running on a schema it does
  not understand, which is the exact DB6 hazard.
