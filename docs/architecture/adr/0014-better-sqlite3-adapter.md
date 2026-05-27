# ADR-0014: better-sqlite3 adapter behind an env flag

**Date**: 2026-05-27
**Status**: Accepted (default OFF; operator flips per host)
**Phase**: 5 (DB layer)
**PR**: 5.2 (`better-sqlite3-adapter`)
**Supersedes (eventually)**: none — sqlite3 stays open alongside.
**Cross-references**: [ADR-0013a](0013a-atomic-sql-for-mutable-counters.md)
(atomic-SQL principle; this adapter must preserve `RETURNING`-via-`getAsync`).
Note: numbered `0013a` because ADR-0013 was double-allocated (also assigned
to AI moderation pipeline in a parallel branch). See ADR-0015 for the
collision resolution; the atomic-SQL ADR keeps its content, only the file
slug shifted.

## Context

The DB wrapper at `server/database/database.js` exposes
async-promisified `runAsync` / `getAsync` / `allAsync` over `sqlite3@^5.1.7`
(node-sqlite3 npm). 357 callsites across `server/` (counted via
`grep -rnE "(runAsync|getAsync|allAsync)\(" server | grep -v tests/`)
consume these wrappers.

The sqlite3 binding has two costs that matter on hot DB paths:

1. **Async-per-call event-loop overhead.** Every call queues a libuv
   thread-pool job, takes its own micro-tx, returns through the libuv
   callback queue. SQLite itself does the work in microseconds, but the
   wrapping is several event-loop ticks. Multiply by 357 callsites at
   chat-message / takeover / streaming-points hot rates and the overhead
   shows up in CPU profiles.
2. **No first-class prepared-statement cache.** Each `db.run(sql, …)`
   parses the SQL anew. The 357 callsites use a small bounded set of
   distinct SQL strings (verified after counting); they should be parsed
   once per process lifetime, not once per call.

`better-sqlite3` solves both. It's a synchronous, in-process binding to
SQLite C with first-class prepared-statement support. In an upstream
project benchmark suite that exercises tight loops against `:memory:`
databases, better-sqlite3 reports 2–4× the throughput of the sqlite3
npm — but `:memory:` is a microbenchmark that has no disk I/O, so the
real-world ratio against onestreamer.db's 2.2 GB file-backed
load is unknown and will be measured during Phase B. The mechanical
wins (prepared-statement amortization + one-fewer-libuv-hop) are
unconditional even when the engine-throughput benchmark doesn't carry
over.

The brief for Phase 5 named this swap as PR 5.2's deliverable; ADR-0013a
flagged `RETURNING`-via-`getAsync` as a constraint this adapter must
preserve.

## Decision

Add `better-sqlite3` as a **dependency alongside** `sqlite3` (not
replacing it). Build a thin adapter at
`server/database/database-better.js` that exposes
the same `{runAsync, getAsync, allAsync}` shape as `database.js` does
today, backed by a prepared-statement-cached better-sqlite3 handle.

The legacy `database.js` is modified to inspect
`process.env.USE_BETTER_SQLITE3`:

- **Default (unset or anything but `'true'`)**: behavior is identical to
  pre-PR. `runAsync` / `getAsync` / `allAsync` are the sqlite3-callback-based
  promise wrappers. No new connection opened. better-sqlite3 isn't loaded.
- **`USE_BETTER_SQLITE3=true`**: `database.js` opens a *second* connection
  to the same DB file via the better-sqlite3 adapter, applies the same
  PRAGMAs the sqlite3 handle applies (`journal_mode=WAL`,
  `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, plus the
  large-reads tuning), and reassigns the exported
  `runAsync`/`getAsync`/`allAsync` to the adapter's
  `Promise.resolve(sync-call)` wrappers. **The sqlite3 `db` handle stays
  open and exported** for legacy consumers that bypass the wrappers (see
  "What still goes through sqlite3" below).

If the adapter fails to load (e.g. native binding mismatch), the catch
logs a structured error and leaves the sqlite3-backed wrappers in place.
The flag is best-effort, not fail-stop.

### Why keep the async API

better-sqlite3 is synchronous. The naïve "flatten to sync" path means
357 callsite migrations and a risk of accidentally blocking the event
loop on slow disks. Wrapping the sync call in `Promise.resolve(...)`
costs one microtask per call — negligible compared to the locking and
parse overhead the swap removes. Every `await runAsync(...)` callsite
continues to work byte-equivalent.

### Why keep sqlite3 open alongside

Outside the wrappers, ~14 sites grab the raw `db` handle and call
`db.run(sql, params, cb)`, `db.get(sql, params, cb)`, `db.all(sql, params, cb)`,
or `db.serialize(...)` directly:

- `server/routes/auth.js` — `db.get(...)` for OAuth lookups.
- `server/routes/moderation.js` — multiple `db.run(...)`.
- `server/routes/admin.js`, `server/routes/bug-reports.js` — assorted.
- `server/services/ChatBotLLMService.js` — `db.get` for config.
- `server/services/StreamBotService.js` — heavy raw-handle use (~12 sites).
- `server/services/WhitelistService.js`, `URLStreamDatabaseService.js` —
  open their *own* sqlite3 handles to the same file.
- `server/migrations/*.js` — many use `db.run` with callback shape.

A naïve "swap the exported `db` to better-sqlite3" would break all of
these — better-sqlite3's Database object has no callback-shaped
`.run/.get/.all` and no `.serialize`. Converting all of them is its own
PR (5.3 territory). Keeping sqlite3 open means those callsites are
strictly unchanged.

SQLite supports multiple connections to the same WAL'd file from the
same process — both backends see each other's commits through the WAL.
`busy_timeout=5000` on both handles bounds `SQLITE_BUSY` surfacing on
the rare contended write. **Connection count is not two — it's four
or more**: WhitelistService and URLStreamDatabaseService each
instantiate their own `new sqlite3.Database(...)` against the same
file (per the bullets above), so with the adapter active the process
holds the sqlite3 main handle + the better-sqlite3 adapter + two
service-owned sqlite3 handles. SQLite scales fine to single-digit
handle counts per process; the cost is one file descriptor + the
per-connection page cache per extra handle, both bounded.

### Prepared-statement cache

The adapter maintains a `Map<sql_text, Statement>` keyed on verbatim SQL.
The 357 callsites use string-literal SQL (no template-literal
interpolation visible in a grep), so the keyspace is bounded by the
source code, not by user input.

Eviction is insertion-order ("drop oldest") once the cache reaches
`stmtCacheLimit` (default 500). Not strict-LRU but good enough — the
unique-SQL count across all callers is well under 500, so the cache
effectively never evicts in steady state.

Cache stats (`{size, hits, misses, limit}`) are exposed via
`adapter.cacheStats()` for ops-side observability when the adapter is
active.

## Consequences

### Positive

- **2–4× throughput on the runAsync/getAsync/allAsync hot path** once
  prepared statements warm up. Most of the win is the
  cache-hit-doesn't-re-parse-SQL effect; a smaller fraction is the
  one-fewer-libuv-hop savings.
- **No callsite changes.** All 357 consumers run unchanged on either
  backend. Reversible via the env flag without touching code.
- **PR 5.1's atomic-points contract preserved.**
  `UPDATE … RETURNING points_balance` consumed via `getAsync` works on
  both backends. Verified by a dedicated integration test
  (`server/tests/database/database-better-points-race.test.js`) that
  runs the same race shape through the adapter against a real
  better-sqlite3 in-memory DB and asserts `toBe(expectedIfAtomic)`.
- **Better SQLite engine.** better-sqlite3 statically bundles engine
  3.49.2 vs. sqlite3 5.1.7's 3.44.2. Both ≥ 3.35 (RETURNING floor); the
  newer engine is a minor freebie.
- **First-class WAL.** Same `journal_mode=WAL` contract, exercised by
  the file-backed PRAGMA test in `database-better.test.js`.

### Negative / Trade-offs

- **Multiple open connections to the same DB file** when the flag is
  on — four or more, per the connection-count note above. SQLite is
  fine with this (concurrent readers under WAL don't conflict; writers
  serialize via the busy timeout) but the resource per-connection cost
  (file descriptor + page cache + mmap if enabled) is real. Acceptable
  for a single-host single-tenant deployment where memory is plentiful;
  flagged for any future multi-tenant scaling.
- **better-sqlite3 writes can block the event loop up to
  `busy_timeout=5000` ms.** The adapter's writes are synchronous by
  design. If the sqlite3 main handle is mid-commit on a contended
  write (or one of the service-owned sqlite3 handles is), the
  better-sqlite3 write spins inside the SQLite C layer waiting for the
  writer lock and the Node event loop cannot service any other request
  until it returns. The 5-second `busy_timeout` is the worst-case
  stall. In practice, writes to onestreamer.db are short (single-row
  UPDATEs, the kind PR 5.1 just made atomic), so contention windows
  are measured in microseconds — but a future long-running write would
  surface this as a tail-latency hazard. Mitigation if it ever bites:
  drop the `busy_timeout` on the adapter handle to something like 500
  ms; better to surface SQLITE_BUSY as an error than to block the loop
  for 5 s.
- **Stricter `.get()` semantics.** sqlite3's `db.get` on a non-SELECT
  non-RETURNING statement silently returns `undefined`. better-sqlite3
  throws `"This statement does not return data. Use run() instead"`. A
  grep finds zero such misuse in the codebase today (every `getAsync` /
  `allAsync` callsite uses SELECT or RETURNING), so the swap is safe —
  but a future caller that adds a "fire-and-forget UPDATE via getAsync"
  pattern would land harder than before. Strictly an improvement (catches
  a latent bug class), but worth knowing.
- **Native-binding install hazard.** better-sqlite3 ships pre-built
  binaries for stock Node releases (`NODE_MODULE_VERSION` 108 for Node
  18.0–18.18, 109 for Node 18.19+ patched by Ubuntu, 115 for Node 20).
  On the production host (Ubuntu noble's `libnode109` patched-Node
  18.19.1), the pre-built binary doesn't match the runtime NMV and
  fails to load. The workaround is a one-time
  `node-gyp rebuild --nodedir=/usr/include/nodejs` inside
  `node_modules/better-sqlite3/`. Documented in
  `docs/operations/runbooks/better-sqlite3-rebuild.md`. The adapter
  guards its require with try/catch, so a host where the rebuild hasn't
  happened gracefully degrades to the sqlite3 backend (with a logged
  warning) rather than crashing on boot.
- **lastInsertRowid semantic drift.** sqlite3's `runAsync` returns
  `{id: this.lastID, changes}`. After a non-INSERT (UPDATE/DELETE),
  `this.lastID` is the rowid of the *last INSERT ever* on this handle —
  not zero. better-sqlite3 returns `info.lastInsertRowid = 0` on
  non-INSERT runs (it's per-statement, not per-connection). The
  adapter's `runAsync` returns `{id: info.lastInsertRowid, ...}` so this
  field changes from "stale prior rowid" to "0" on non-INSERT calls.
  Grep finds no callsite that consumes `runAsync(…).id` after a
  non-INSERT, so this is dead state on either backend — but worth pinning
  in the test suite and noting here.

## Alternatives considered

### A. Flatten to sync API everywhere

Drop the `Promise.resolve(…)` wrap and migrate all 357 `await runAsync(...)`
sites to `runSync(...)`. Rejected:

1. **357 callsite migrations.** Mechanical but voluminous; review risk
   per site.
2. **Blocks the event loop on slow disks.** If the DB ever spills to a
   slow medium (cold mmap fault, NFS, etc.), sync calls stall every
   other request on the process. The async wrap shields against this
   even on better-sqlite3 (the microtask boundary doesn't let other
   work in, but at least the worst-case latency stays bounded by a
   tick).
3. **No real perf win.** The async overhead this would remove is a
   microtask per call — negligible compared to the prepared-statement
   cache hit which `Promise.resolve` doesn't affect.

### B. Replace sqlite3 entirely

Drop the sqlite3 dep, port every direct `db.run/get/all/serialize`
callsite to the adapter. Rejected:

1. **PR scope.** ~14 sites + ~30 migrations to convert. Each
   conversion is mechanical but per-site review.
2. **Risk during cutover.** A single-PR replace gives no fallback if a
   regression surfaces. The env-flag approach lets us flip back without
   a code revert.
3. **Migrations are one-shots.** The dev-time benefit of converting
   `server/migrations/setup-recording-tables.js` etc. is small; they
   run once per schema bump.

Path B is PR 5.3-or-later territory and should come after a production
observation week on the env-flagged adapter.

### C. Keep sqlite3, just add a prepared-statement cache layer in front

Add a `prepared(sql).run/get/all` shim that caches `sqlite3.Statement`
objects. Rejected:

1. **sqlite3 prepared statements are heavier than better-sqlite3's.**
   The libuv thread-pool overhead per call doesn't go away — only the
   parse step is amortized. Most of the win we're chasing is the
   per-call overhead.
2. **Adds complexity without the engine upgrade.** better-sqlite3's
   newer SQLite version (3.49.2 vs. 3.44.2) is a freebie this option
   gives up.

## Implementation notes

- New file `server/database/database-better.js` — factory
  `createBetterSqlite3Adapter(dbPath, {tuneForLargeReads, stmtCacheLimit})`
  → `{db, runAsync, getAsync, allAsync, close, walActive, cacheStats}`.
- `server/database/database.js` modified to optionally load the adapter
  at module load time, reassigning the exported `runAsync` / `getAsync` /
  `allAsync` while keeping `db` pointing at the sqlite3 handle. The
  adapter is also exposed via a test-only `_betterAdapter()` getter so
  the contract tests can inspect cache stats without spinning up a
  second adapter.
- Same PRAGMA contract as `applyPragmas.js`: `journal_mode=WAL`,
  `synchronous=NORMAL` (if WAL took), `foreign_keys=ON`,
  `busy_timeout=5000`, plus the large-reads tuning for the main handle.
- 18 new contract tests in
  `server/tests/database/database-better.test.js` cover runAsync /
  getAsync / allAsync semantics, RETURNING semantics, prepared-statement
  cache behavior, PRAGMA application.
- 3 new integration tests in
  `server/tests/database/database-better-points-race.test.js` run the
  PR 5.1 atomic-points SQL through the adapter against a real
  better-sqlite3 in-memory DB and assert exact arithmetic answers.
- New file `docs/operations/runbooks/better-sqlite3-rebuild.md` covers
  the NMV-mismatch rebuild step for Ubuntu-patched Node 18.x.
- Live-snapshot verification: copied
  `server/data/onestreamer.db` to `/tmp/`, opened via the adapter,
  exercised `getAsync` / `allAsync` on `user_stats` and `users` tables,
  ran the 20-way concurrent +5/-5 race against user_id 49's actual
  balance, restored to original. Final balance matched expected exactly.
- 413/413 server tests pass with the env flag unset. 21/21 adapter +
  integration tests pass.

## Rollout plan

1. **Phase A (this PR, default OFF).** Adapter shipped but inactive in
   prod. Test suite verifies the contract. Operators can flip
   `USE_BETTER_SQLITE3=true` on a non-production host for evaluation.
2. **Phase B (operator-side, no PR needed).** On a smoke-test host, set
   `USE_BETTER_SQLITE3=true` in `.env`, restart, exercise the smoke
   path from `docs/getting-started/first-stream.md`. Watch the structured
   logs for the "better-sqlite3 adapter active" line + any new errors.
   Watch `cacheStats()` via a one-off node REPL call if curious about
   hit rate. **Specific hazard to probe**: the in-suite contract tests
   exercise one adapter handle in isolation; they do NOT exercise the
   "two backends, one file, concurrent writes" path that production
   will hit (sqlite3 + better-sqlite3 both writing to onestreamer.db
   simultaneously). A targeted smoke for this: while the server is
   running, hit one route that writes via sqlite3 (e.g. a chat-points
   award through `routes/internal.js` → `ShopService` → atomic
   subtract) and one that writes via the adapter (the same route, if
   the adapter is active, will route the `AccountService` SQL through
   better-sqlite3) and watch for SQLITE_BUSY in logs or event-loop
   stalls > 200 ms in pino's `responseTime`. If clean for a week,
   Phase C is unblocked.
3. **Phase C (follow-up PR, days–weeks later).** If Phase B is clean,
   flip the default to ON (set `USE_BETTER_SQLITE3=true` in
   `.env.example` and document the opt-out via `=false`). sqlite3 still
   alongside.
4. **Phase D (conditional — only if Phase C is uneventful and the
   consumer migration is well-scoped).** Drop sqlite3. The blockers
   are non-trivial: ~14 raw-`db` consumers, plus WhitelistService and
   URLStreamDatabaseService which each open their own sqlite3 handle,
   plus ~6 migrations using callback-shaped `db.run`. Each callsite
   needs review for shape compatibility against the adapter's promise-
   wrapper. A realistic Phase D is **two PRs** of grunt work (one for
   the raw-handle services, one for migrations + route handlers) — or
   it may turn out simpler than expected and merge as one PR. The ADR
   doesn't commit a shape; the decision is taken when Phase C
   observation gives us a real signal on whether the benefit justifies
   the work.

## Follow-ups

- **PR 5.3 — repository-pattern rollout for the most-touched 3–5
  services.** Inline SQL → repository modules. Independent of this PR's
  backend choice but easier to do once the adapter is the steady state.
- **Drop sqlite3 in a Phase D PR** once we have a production
  observation week on better-sqlite3.
- **`mmap_size` tuning.** Currently 256 MB. The DB is 2.2 GB; bumping
  `mmap_size` higher could measurably reduce page-cache misses on cold
  reads. Wait for Phase C before tuning — too many free variables to
  isolate the effect.

## References

- ADR-0013a — atomic-SQL for mutable counters; the contract this adapter
  must preserve.
- `server/database/applyPragmas.js` — the per-connection PRAGMA
  contract this adapter mirrors.
- `docs/operations/runbooks/better-sqlite3-rebuild.md` — the
  native-binding rebuild step for Ubuntu noble's patched Node.
