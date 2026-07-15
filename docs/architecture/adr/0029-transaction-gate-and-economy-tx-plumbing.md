# ADR-0029: Gate module-level DB primitives behind the transaction mutex; plumb per-call tx handles through the economy write layer

_Status: accepted_
_Date: 2026-07-14_

## Context

`withTransaction` (ADR-0015) serialized scope-vs-scope with a promise-chain mutex, but the module-level `runAsync`/`getAsync`/`allAsync` wrappers `database.js` exports were ungated: a write issued from a timer or socket handler while a scope was open executed on the same shared connection **inside** that scope — committed or destroyed by a foreign COMMIT/ROLLBACK (audit DB2; the sharp edge was self-documented in `transaction.js`). Live bare writers include TimeTrackingService's 25 s points interval, per-chat-message point awards, and BuffDebuffService's tick.

Worse, the economy paths *depended* on the hole. `ShopService.purchaseItem` opened a scope but ignored its `tx` handle; every write inside went through bare module wrappers and was atomic only via the shared-connection implicit join. `transferPoints` (E2) and `sellItem`/`giftItem`/`transferItem` (E3) had no transaction at all — a mid-flow failure destroyed points or items. The `AccountService → PointsManager → AccountStatsRepository` chain accepted no per-call transaction, so there was no way to write these paths correctly.

The audit weighed two designs (Plan 04 DB2) and its red-team pass reversed the original ranking: a **second dedicated connection** for scopes (option b) breaks purchaseItem outright — its bare writes would land on the other connection, making the "atomic" purchase non-atomic and deadlock-prone against the scope's own `BEGIN IMMEDIATE` lock. The safer migration is the **mutex gate with explicit reentrancy** (option a).

A prerequisite decision: sqlite3 vs better-sqlite3 (`USE_BETTER_SQLITE3`, default off). Building the gate *above* the promise wrappers makes it driver-neutral, so the transaction layer is built once; the flag cutover stays a separate operator decision (its own PR + ADR-0014 update, per the plan's "not a drive-by" warning). **better-sqlite3 remains the target default**; nothing here blocks or presumes the flip, and the whole layer is tested under both backends. _(Done 2026-07-15 — the Phase-C default flip landed with the ADR-0014 amendment.)_

## Decision

1. **The gate.** `createWithTransaction` now exposes `withTransaction.gated` — gated versions of all three primitives (all three because writes flow through `getAsync` via `UPDATE … RETURNING`). `database.js` exports the gated versions as the module-level wrappers, so every repo/service falling back to module primitives is covered with zero call-site changes.
   - An op issued **outside** any scope joins the same mutex chain the scopes use: it serializes behind an open scope (and scopes behind it) and can never land inside a foreign `BEGIN…COMMIT`.
   - An op issued **inside the currently-open scope** — detected by AsyncLocalStorage token *identity*, so a promise born in scope A that runs while scope B is open is gated rather than misread as B's own — executes directly, joining its own tx exactly as before, with a one-time-per-statement warning. That is the explicit reentrancy mechanism: unplumbed in-scope paths surface as warnings instead of self-deadlocking.
   - The `tx` handle passed to scope bodies remains the raw wrappers, so plumbed code bypasses the gate by construction.
2. **Per-call tx plumbing** (the ClipService/ADR-0015 tx-scoped-repo pattern, generalized): `AccountService.addPoints/subtractPoints/recordTransaction` and `InventoryService.getInventoryItem/addItemToInventory/removeItemFromInventory` accept an optional trailing `tx`; `PointsManager` builds `new AccountStatsRepository(tx)` when one is supplied (which also makes the balance UPDATE + audit INSERT atomic — audit DB7 — on every tx path).
3. **Conversions**: `purchaseItem` writes everything through `tx` (the implicit join is no longer load-bearing — pinned by test); `sellItem` wraps remove→credit→audit in one scope and rejects zero-earnings sells before any mutation; `transferPoints` wraps debit+credit; `giftItem`/`transferItem` wrap their swap + audit row.

## Consequences

- A failing scope can no longer destroy concurrent timer/socket writes, and bare writes can no longer contaminate a scope — pinned by new contract tests (queued-behind-scope, reentrancy, token identity, timer-shaped survival) run under both backends.
- All module-level DB ops now serialize on one JS-level chain. On this single-host deployment the underlying connection already executed statements sequentially, so the added cost is promise overhead; scopes are a handful of statements long.
- In-scope reads through module wrappers (e.g. `ItemService.getItemById` inside a purchase) log a one-time warning and join the tx — the migration pressure to plumb `tx` further, without behavior change.
- If ALS context were ever lost inside a scope (user-land callback queues — none in these paths), the op gates behind its own scope's release: a deadlock. In-scope code must use `tx`; the warning machinery exists to catch stragglers early.
- `sellItem` rejecting zero-earnings sells is a user-visible change (previously destroyed items for 0 points).
- Legacy direct `db.run/.get/.all` callers bypass the gate — pre-existing hole, unchanged, tracked in the audit separately.

## Alternatives considered

- **Dedicated second connection for scopes (option b)** — cleaner end state but unsafe until *every* scope body writes via `tx`; revisit after this migration has soaked.
- **Classifying read vs write SQL to gate only writes** — fragile (`RETURNING` writes flow through `getAsync`); gating all three is simpler and also closes bare dirty reads.
- **Boolean "a scope is open" reentrancy flag** — misattributes late writes from a *previous* scope to the current one; token identity is required for correctness.
