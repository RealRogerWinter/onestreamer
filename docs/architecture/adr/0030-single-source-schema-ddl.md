# ADR-0030: database.js (schema.js) is the sole boot DDL source

* **Status:** Accepted
* **Date:** 2026-07-14
* **Related:** [ADR-0022](0022-schema-migrations-layout.md) (numbered migrations), [`server/database/schema.js`](../../../server/database/schema.js), [`server/database/database.js`](../../../server/database/database.js), [`server/migrations/`](../../../server/migrations/), audit plan [`04-database-and-economy-integrity.md`](../plans/2026-07-audit/04-database-and-economy-integrity.md) (findings DB1, DB3)

## Context

The 2026-07 audit confirmed the schema was defined in **four unsynchronized places**, with live drift between them (findings DB1/DB3):

1. `server/database/database.js` — the boot bootstrap (authoritative: runs first).
2. `server/database/recording-schema.sql`, replayed at boot by `server/migrations/setup-recording-tables.js` over a **second connection** from `server/index.js`. Its `recording_events` definition (user_id TEXT, FK to recordings) **conflicted** with database.js's (user_id INTEGER, FK to users) and was a permanent silent no-op; its `recording_settings` was a duplicate; only its settings **seed** did real work.
3. `server/migrations/setup-clips-tables.js` (boot-invoked from index.js) — a near-duplicate `clips`/`clip_views` DDL, also a silent no-op after database.js. `setup-transcription-tables.js` was worse: not in any boot path, and its shapes **contradicted the live DB** (DATETIME columns, extra tables `transcription_events`/`transcription_settings` that exist nowhere) — a trap for anyone re-running it.
4. Hand-copied test DDL: `server/tests/integration/_helpers/db-fixture.js` plus per-test copies in several service tests — an admitted "approximation" that declared columns prod never creates.

The hand copies are what **masked DB1**, the severe half of the finding: a fresh database (clone or DR restore) booted with no working economy — `user_stats.points_balance`, `points_transactions`, `transcriptions`/`transcription_chunks`, and 13 load-bearing `users` columns (profile + deletion lifecycle + the login path's `username_changed`/`avatar_url`/`description`) were only ever created by the legacy one-shot `migrate-points-system.js` (not in the boot path, and whose guard *refuses* to run on exactly the fresh DBs that need it) or by nothing at all except live-DB drift. Tests stayed green because their private DDL invented the missing columns.

## Decision

### 1. One boot DDL source

The production schema bootstrap lives in **`server/database/schema.js`** (`initializeSchema(db, log)`), required and invoked by `database.js` at module boot and re-exported from it. It queues every `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, seed row, and the numbered migrations (ADR-0022) in one serialize scope, and resolves when the queue flushes. It is a separate, side-effect-free module so tests can require it without triggering database.js's self-boot against the real data file.

Rules going forward:

* **New tables and columns go in `schema.js`** — plus a numbered `server/migrations/2026MMDDHHMM-*.js` migration when existing DBs need a backfill (`ALTER TABLE ADD COLUMN`). `CREATE TABLE/INDEX IF NOT EXISTS` needs no migration: it runs every boot and converges stale DBs by itself.
* **`*-schema.sql` files may only hold seeds or service-owned isolated schemas.** The surviving three — `url-stream-schema.sql`, `ai-moderation-schema.sql`, `url-relay-whitelist-schema.sql` — are applied at boot by their owning services against tables nothing else defines, and are explicitly grandfathered. No new ones.
* **Test schemas must come from `initializeSchema`.** The integration fixture (`db-fixture.js`) boots the full prod schema against `:memory:` (via a small callback shim for the better-sqlite3 backend). Never hand-copy DDL into a test.
* **New DDL must match the live DB byte-for-byte** when promoting drifted columns. The committed snapshot fixture (`server/tests/fixtures/schema-snapshot-pre-pr-14-1.json`, regenerated only via `scripts/ops/regenerate-schema-snapshot.js`) and `server/tests/database/fresh-boot-schema.test.js` pin the shapes.

### 2. What was deleted / promoted (the DB1+DB3 remediation)

* Deleted: `recording-schema.sql`, `setup-recording-tables.js`, `setup-clips-tables.js`, `setup-transcription-tables.js`, and both invocation blocks in `server/index.js` (this also removes the second boot-time connection that raced the main serialize queue). The recording_settings seed and the recording_events indexes moved into `schema.js`.
* Promoted into `schema.js`, shapes verified read-only against the live DB: `user_stats.points_balance`; `points_transactions` (+2 indexes); `transcriptions` + `transcription_chunks` (+3 indexes, **live** shapes — not the deleted script's); 13 `users` columns (+2 indexes, created in migration `202607140011`); `items.category`. New (behavior-preserving): `items.is_tradeable BOOLEAN DEFAULT 0` — `InventoryService.giftItem` gates on it but nothing ever created it, so gifting was dead against the real schema; DEFAULT 0 keeps it blocked until a product decision seeds tradeable items. Backfill migrations: `202607140010`–`202607140012`.
* The recording-index `setTimeout(…, 1000)` hack is gone — those indexes now queue after `migrationRunner.runAll` in the same serialize scope, which is ordering-guaranteed.
* `migrate-points-system.js` stays (forensic value, per the `_runner.js` doctrine) but its fresh-DB guard message no longer claims "migration is complete" on a DB that simply never had the legacy column.

### 3. Deliberate live↔fresh differences (allowlist)

* `users.points_balance` — live-only legacy dead weight (the real counter is `user_stats.points_balance`; no code references it). Fresh boot does not create it; the fresh-boot test asserts its absence.
* `idx_clips_user_id`, `idx_clips_created_at`, `idx_clips_is_public`, `idx_clip_views_clip_id` — redundant live-only duplicates of database.js's differently-named clips indexes (`idx_clips_user`, `idx_clips_created`, `idx_clips_public`, `idx_clip_views_clip`), left over from the deleted `setup-clips-tables.js`. Same columns are indexed either way; not recreated fresh.
* Conversely, `idx_recording_events_recording` / `idx_recording_events_recording_id` are BOTH kept (live has both; dropping one on live is a separate operator decision).

## Consequences

* A fresh clone / DR restore boots a complete, working schema — economy, login, transcription, recording — from `npm start` alone. This is the prerequisite for the DB2/E2/E3 regression tests, which boot `:memory:` through the production path.
* The schema tripwire (bit-identical snapshot test) now covers 41 tables and runs without sleeps; every deliberate DDL change requires exactly one regenerated fixture commit.
* **Deferred cleanup:** `ShopService.purchaseItem.atomic.test.js`, `ShopService.purchaseItem.realAccount.test.js`, `InventoryService.giftItem*.test.js`, `GameMechanicsService*.test.js` still carry private DDL copies. They are touched by other in-flight audit PRs, so migrating them onto `bootstrapProductionSchema` is deferred to avoid cross-PR conflicts — do it opportunistically once those land.

## Alternatives considered

* **A single schema.sql as the source instead of JS** — rejected: the bootstrap needs parameterized seeds (`chatbot_config` default prompt), and the numbered-migration runner (ADR-0022) is already JS-callback-shaped on the same handle.
* **Keeping recording-schema.sql as a seed-only file** (doc-minimal option) — rejected in favor of full promotion: it kept a second boot connection and a second place for DDL to creep back into.
* **Creating `users.points_balance` fresh for exact parity** — rejected: parity with dead weight has no value and would invite code to start using the wrong column.
