# Plan 04 — Database & economy integrity

_Part of the [2026-07 codebase audit](README.md). Owner area: `server/database/*` (adapter, transactions, migrations, schema), `server/database/repository/*`, `server/services/AccountService.js` + `account/*`, `InventoryService.js`, `ShopService.js`, `GameMechanicsService.js`, `server/routes/internal/*`._

> Status: **proposed**. These two areas share a root cause — the transaction/atomicity story is half-built — so they are planned together. The economy's per-statement writes are atomic (ADR-0013a is honored at the repository layer), but **multi-write operations that must be atomic are not**, and the `withTransaction` primitive has a hole that can silently destroy unrelated writes.

## The transaction model, and its hole

`database.js` opens **one shared `sqlite3` connection** and exports both bare `runAsync/getAsync/allAsync` and a `withTransaction` built over the same wrappers. `better-sqlite3` exists but is gated behind `USE_BETTER_SQLITE3=true` (default **off**), so prod runs the async `sqlite3` driver and both drivers ship in `package.json`.

The `withTransaction` mutex (`transaction.js`) only serializes `withTransaction`-vs-`withTransaction`. **Bare `runAsync` writers are not covered.** Because it is one connection, a bare write issued while a transaction scope is open executes *inside that BEGIN…COMMIT* — so:

- a 1 Hz timer's points write, or a `points_transactions` audit row, can be **silently rolled back** by an unrelated `withTransaction` scope that happens to fail; the caller saw success, and
- conversely a bare write can be committed as part of a foreign transaction it never joined.

This is the substrate under the economy findings: wrapping some paths in `withTransaction` while others write bare is not just "some paths unprotected" — it actively corrupts the protected ones.

## Confirmed findings

### Database layer

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| DB1 | high | Fresh-DB boot never provisions the points economy schema (`points_balance` col, `points_transactions` table); the legacy migration that would refuses to run on fresh DBs — clone/DR restore is hard-broken | `database/database.js:66` |
| DB2 | high | `withTransaction`'s mutex doesn't cover bare `runAsync` writers on the shared connection → timer/socket writes destroyed by unrelated ROLLBACKs | `database/transaction.js:87` |
| DB3 | medium | Schema defined in four unsynchronized places with live drift (`recording_events` has two conflicting boot definitions; test fixture declares columns prod never creates) | `database/recording-schema.sql:15` |
| DB4 | medium | Boot ordering race: query wrappers usable before table creation; recording indexes created via `setTimeout(1000)`; the better-sqlite3 adapter bypasses the serialize queue | `database/database.js:600` |
| DB5 | low | `user_stats` has no `UNIQUE(user_id)` — the addPoints UPDATE-miss-then-INSERT fallback can create duplicate balance rows → permanent balance corruption | `services/account/PointsManager.js:44` |
| DB6 | low | Migration runner swallows every failure and continues — a half-applied schema boots as "healthy" | `migrations/_runner.js:71` |
| DB7 | low | PointsManager balance UPDATE + `points_transactions` INSERT are non-atomic on all non-shop paths → ledger can't be trusted for drift detection | `services/account/PointsManager.js:49` |

### Economy

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| E1 | **critical** | Negative `quantity` in `/gift-item` (unvalidated body) inverts both inventory writes → mint items for self, steal from any other user | `services/InventoryService.js:325` |
| E2 | high | `transferPoints` is non-atomic (debit-then-credit, no transaction) → points destroyed on partial failure | `services/GameMechanicsService.js:324` |
| E3 | high | `sellItem`/`giftItem`/`transferItem` move inventory and points without a transaction → item loss on partial failure | `services/ShopService.js:295` |
| E4 | medium | Un-wrapped economy writes leak into an open purchase transaction on the shared connection (cross-user contamination) | `database/transaction.js:25` |
| E5 | medium | `useItem` applies the buff/debuff effect **before** the atomic inventory decrement → double-effect race (one item, two effects) | `services/InventoryService.js:176` |
| E6 | medium | No server-side integer/positive validation on gamble/slots/award/transfer amounts | `routes/internal/points.js:46` |
| E7 | low | gamble/transfer race surfaces as an opaque 500 instead of a clean insufficient-funds 400 | `services/GameMechanicsService.js:113` |

> Note for reconciliation: the audit did **not** find a `points_balance` overdraft/double-spend — `AccountStatsRepository` uses a guarded atomic decrement (`SET points_balance = points_balance - ? WHERE user_id = ? AND points_balance >= ? RETURNING points_balance`). The economy's balance floor is sound; the exposure is **input validation** (E1, E6) and **multi-write atomicity** (E2–E4), not the decrement itself.

## Remediation plan

### P0 — the mints (hours)

There are **two** independent mints, and input validation only closes one:

- **E1 — negative quantity.** Validate `quantity`/amount as a positive integer at every economy route and service entry (`if (!Number.isInteger(n) || n < 1) 400`). Ship a shared `assertPositiveInt` guard and apply to gift, purchase, sell, transfer, gamble, slots. Self-inflation reachable by any authenticated user; goes with the [Plan 02](02-security-and-access-control.md) P0.
- **E1b — unauthorized self-award (separate finding, `points.js:46`/`:69`).** `POST /api/internal/award-points` checks only `decoded.id !== userId`, then credits the body `amount` with **no cap and no authorization** — any authenticated user can award themselves arbitrary points (`award-points` of 1e9 sails through `assertPositiveInt`). The `/api/internal` router is mounted with no guard middleware, so it's reachable by any client holding a user JWT, not just the chat-service. **`assertPositiveInt` does NOT close this** — it needs authorization (only the chat-service/admin may grant points) or a cap. Fix alongside E1 and cross-reference [Plan 02](02-security-and-access-control.md)'s internal-route exposure.

### P1 — atomicity & the transaction hole (this is a real refactor, not "days, medium risk")

> **Correction from red-team:** the flagship "already atomic" path, `ShopService.purchaseItem`, **depends on the DB2 hole**. It opens `withTransaction(async (_tx) => …)` but every write inside runs through the **bare** module-level wrappers (`subtractPoints`, `addItemToInventory`, `decrementStockLimit`, `insertPurchase`) — the `_tx` handle is literally unused (comment at `ShopService.js:194`). Those writes land in the transaction *only* because they share the one connection. So `purchaseItem` is a **demonstration of the bug, not a template to mirror**, and both DB2 options break it as-is. Budget DB2 + E2 + E3 + DB7 as **one layered refactor of the entire economy write path**, not a set of local wraps. Blast radius = the economy write layer.

- **DB2 (foundational, but not self-contained).** Close the shared-connection implicit-join, but you must convert `purchaseItem` (and every path below) to write through the tx handle **as part of the same change**:
  - **Option (b) — dedicated second connection for `withTransaction`.** Cleaner end state (bare writers just block on `BEGIN IMMEDIATE`), but it **moves the tx's writes onto connection B while `purchaseItem`'s bare writes stay on connection A** → the "atomic" purchase becomes non-atomic *and* can deadlock (tx holds a RESERVED lock on `user_stats` via B while the bare `subtractPoints` on A blocks to `busy_timeout`). Requires re-plumbing all bodies first.
  - **Option (a) — bare `runAsync` awaits the tx mutex when a scope is open.** More compatible with existing code, but a scope's *own* bare writes would then await a mutex the scope already holds → **self-deadlock** unless you add async-context reentrancy tracking (`AsyncLocalStorage`) to distinguish a scope's own writes from a concurrent timer's. The plan's earlier "(b) is cleaner/recommended" ranking is reversed by this: (a) is likely the safer migration, with the reentrancy mechanism made explicit.
  - Land with a test that a failing scope cannot roll back a concurrent bare write, **and** that `purchaseItem` stays atomic.
- **E2, E3 — the plumbing is the work.** `AccountService.addPoints/subtractPoints` → `PointsManager` → `AccountStatsRepository` accept **no per-call tx** today; the repo takes `{runAsync,getAsync,allAsync}` only at **construction**. So threading a tx means either adding an optional `tx` parameter through all three layers, or building tx-scoped repos inside the scope (`new AccountStatsRepository(tx)`) and plumbing them down through `AccountService`. This is a cross-cutting signature change, not a call-site tweak. Do **not** "mirror purchaseItem" — fix purchaseItem the same way. Guard `totalEarnings === 0` before removing on sell.
- **E4 is not separate work** — it is the DB2 hole seen from the economy side (same `transaction.js:25` anchor). It is subsumed by DB2 + E2/E3; don't double-count it.
- **E5** — Consume the item first (atomic decrement) and only apply the effect if the decrement returned a row.
- **E7** — Have `PointsManager` throw a typed insufficient-funds error mapped to 400 in the game handlers.

**Sequencing:** the **driver decision below is a prerequisite of DB2**, not a P2 tail — `withTransaction` is built over whichever driver won the `USE_BETTER_SQLITE3` swap, and the two drivers have different transaction/error semantics (`transaction.js:45`), so choosing after DB2 means building the transaction layer twice. And **DB1 (fresh-boot schema) must land before the DB2/E2/E3 regression tests** — those tests boot `:memory:` via the production path, which today can't provision `points_balance` (only the hand-copied test fixture masks it).

### P1 — fresh-boot & schema single-source (days)

- **DB1** — Add `points_balance` to the inline `user_stats` DDL and `CREATE TABLE IF NOT EXISTS points_transactions` (+ index) to `database.js`, plus a numbered `addColumn` migration for existing DBs; do the same promotion for `transcriptions`/`transcription_chunks`; fix or delete the misleading fresh-DB guard in `migrate-points-system.js`. This is what makes a clone or DR restore actually work.
- **DB3** — Pick `database.js` (or one `schema.sql`) as the sole DDL source; delete the conflicting `recording_events` definition from `recording-schema.sql` (keep only the settings seed); make the test fixture build its schema by invoking the production init path against `:memory:` instead of a hand copy. (This is the trap that generated the recording-schema drift in [Plan 01](01-recording-and-clips-pipeline.md).)

### P2 — boot hardening & ledger trust (days)

- **DB4** — Expose a `ready` promise from `database.js` (resolved after `initializeDatabase` + migrations) and `await` it in `index.js` before service construction; replace the `setTimeout(1000)` index creation with in-order statements after the migration runner.
- **DB6** — Make the migration runner fail startup (preferred for DDL) or set a health flag surfaced on `/admin/status`; escalate non-benign `addColumn/dropColumn` errors loudly.
- **DB5** — Note SQLite **cannot** `ALTER TABLE … ADD UNIQUE`; adding `UNIQUE(user_id)` to `user_stats` is a **table rebuild** (create-new + copy + drop + rename, respecting the FK to `users`) on top of the one-time duplicate-row merge. So this is a real migration, not a one-line constraint add — and given the failure mode is "permanent balance corruption," it's arguably higher than P2-low. After the constraint exists, convert the addPoints fallback to `INSERT … ON CONFLICT(user_id) DO UPDATE SET points_balance = points_balance + excluded.points_balance RETURNING points_balance`.
- **DB7** — Wrap the PointsManager UPDATE+INSERT pair in `withTransaction` on every path. The repo's `{runAsync,getAsync,allAsync}` deps are injected at the **constructor only** — there is no per-call tx handle today — so this uses the tx-scoped-repo plumbing built for E2/E3 (`new AccountStatsRepository(tx)` inside the scope), i.e. DB7 rides the same refactor. Add a periodic `SUM(amount)` vs `points_balance` drift check as an admin integrity report.
- **Driver decision (prerequisite of DB2, not a P2 tail — pull forward).** Decide `sqlite3` vs `better-sqlite3` and commit to one *before* reworking `withTransaction`, or the transaction layer gets built twice under divergent semantics. Shipping both drivers also means tests and prod can run different code paths (interacts with the CI gap in [Plan 07](07-ai-transcription-and-platform-hygiene.md)). `better-sqlite3` (synchronous, prepared-statement cache, real `BEGIN`/`SAVEPOINT` transactions) is the better fit for a single-process app and materially simplifies DB2; if chosen, remove `sqlite3`, flip the flag on by default, and update ADR-0014.

## Risks & red-team notes

- **DB2 option (b) can deadlock** if a `withTransaction` body issues a bare write to the *same* rows it locked with `BEGIN IMMEDIATE` on the other connection — that bare write would block on the lock it itself holds. Audit `withTransaction` bodies for bare writes before switching; the correct pattern is that a scope only writes through its own tx handle. Ship behind the money-flow integration tests (`routes.internal.points.integration.test.js`, the gift/purchase suites).
- **DB1's fresh-boot DDL must exactly match the historical migration's shape** or existing prod and fresh clones drift again — verify column types/defaults against the live schema before adding the inline DDL.
- **E5's reorder (decrement-first) changes user-visible failure semantics** — a now-refunded effect that used to apply then fail. That's the correct behavior, but note it in CHANGELOG and cover with a concurrency test.
- **Switching drivers is not a drive-by.** If the driver decision lands, it deserves its own PR + ADR update (ADR-0014) and a full test pass under the chosen driver, because per-statement timing and error shapes differ.

## Success criteria

- A fresh `onestreamer.db` boots with a working economy (no "no such column: points_balance"); a test boots `:memory:` via the production path and runs a purchase.
- A failing `withTransaction` scope provably cannot roll back a concurrent bare write (regression test).
- transfer/sell/gift are atomic (crash injection between the two writes leaves balances/inventory consistent); the money-flow integration suite stays green.
- Negative/fractional economy amounts are rejected with 400 across all endpoints.
- One driver, one schema source; `recording_events` has a single definition.
