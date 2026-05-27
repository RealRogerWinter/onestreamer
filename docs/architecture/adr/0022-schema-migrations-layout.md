# ADR-0022: Schema migrations layout (light-weight, no framework)

* **Status:** Accepted
* **Date:** 2026-05-27
* **Phase:** 14 (schema cleanup)
* **PR:** 14.1 (`schema-migrations-extract`)
* **Related:** [`server/database/database.js`](../../../server/database/database.js), [`server/migrations/`](../../../server/migrations/), [`server/migrations/_runner.js`](../../../server/migrations/_runner.js)

## Context

`server/database/database.js` started as a single function that issued every `CREATE TABLE IF NOT EXISTS` the project needs. Over time, columns were added by appending an inline `db.run("ALTER TABLE … ADD COLUMN …", catch-duplicate)` next to the relevant `CREATE`. By the close of Phase 13 there were **21 such inline ALTERs** spread across ~600 lines of `initializeDatabase()` — interleaved with `CREATE` statements, occasionally guarded by a `PRAGMA table_info(…)` lookup, occasionally not. The pattern worked but had three operational costs:

1. **Hard to read.** "Which columns has this table ever had?" required scrolling through `database.js` and grepping for ALTERs. The schema was implicit in the file's history, not in a discoverable set of artefacts.
2. **Hard to add to.** A new column meant inserting a new ALTER block next to the existing ones, paying attention to `PRAGMA table_info` vs raw `ALTER` style mixing, and remembering to also update the `CREATE TABLE` for fresh-clone bootstrap.
3. **Risky to refactor.** The Phase 14 red-team noted that any structural change to `database.js` had to keep the schema bit-identical for existing deployments. Without a separation between *ground-state schema* and *forward-only changes*, every refactor was load-bearing.

`server/migrations/` already existed alongside `database.js` but held only **ad-hoc one-shot scripts** (`add-avatar-description.js`, `setup-recording-tables.js`, etc.) that operators ran by hand against a particular DB at a particular time. There was no convention for "the next column I need to add" to live in.

## Decision

### 1. Two artefacts, one boot path

`database.js` keeps the **ground-state schema** — every `CREATE TABLE IF NOT EXISTS` and every `CREATE INDEX IF NOT EXISTS`. This is the shape `npm start` produces against an empty DB.

A new directory of **numbered migration files** under `server/migrations/2026MMDDHHMM-<description>.js` holds every forward-only change. A small runner enumerates them in lexicographic filename order and invokes each file's exported `run(db, logger)` function from inside the bootstrap's `db.serialize()` block, so migrations execute *after* every `CREATE TABLE` has been queued.

```
applyPragmas  →  initializeDatabase() creates ground-state tables  →  migrations run  →  app code consumes db handle
```

Fresh-clone onboarding remains a single command: `npm start` against an empty DB runs CREATE → migrations → done. No `npm run migrate` step.

### 2. Filename convention

```
2026MMDDHHMM-<short-kebab-description>.js
```

The 12-digit `YYYYMMDDHHMM` prefix makes lexicographic order = chronological order. The runner picks up *only* files matching this regex — pre-Phase-14 ad-hoc scripts (e.g. `add-avatar-description.js`, `setup-viewbot-tables.js`, `migrate-points-system.js`) sit in the same directory but are deliberately ignored: their effects are already baked into deployed databases, and they had their own ad-hoc invocation pattern that we are not retroactively converting.

### 3. Idempotency over tracking

Every migration is **idempotent**: each `ADD COLUMN` is guarded with the "duplicate column" catch the inline code used; each `DROP COLUMN` swallows "no such column". Running every migration on every cold boot — and converging to the same end state regardless of whether the columns are already present — is the cheapest correct implementation at single-host single-tenant scale.

We do **not** maintain a `schema_migrations` tracking table. The trade-off:

* **What we give up:** the ability to "run only what hasn't run." Each migration pays one no-op `ALTER` per boot.
* **What we gain:** no bug surface around tracking-table drift, no "this migration was marked applied but the column isn't actually there" failure mode, no migration-locking subsystem, no concept of "down" migrations.

At the project's scale (one host, one streamer at a time, ~30 tables), the cost of a per-boot no-op ALTER is well under one millisecond. Adding tracking would buy us nothing operationally and would itself need testing and maintenance.

### 4. Shared helpers, not a framework

A module-internal `_runner.js` exposes two helpers — `addColumn(db, table, column, definition, logger)` and `dropColumn(db, table, column, logger)` — that consolidate the catch-duplicate idiom each migration would otherwise re-implement. Migration files import these and call them once per column.

Migration files use callback-style `db.run`, not promises. They are invoked from inside `db.serialize(...)`, so callback-queued statements execute in order on the same sqlite3 handle. Promise wrappers would force the runner to await each migration, which would either require lifting the bootstrap out of `serialize()` (a bigger refactor) or block the boot.

### 5. Bit-identical guarantee

Phase 14 was rated MEDIUM-risk specifically because the bootstrap is load-bearing — production DBs at every deployment age must come out the other side with the exact same schema shape. A `server/tests/database/migrations.runner.test.js` suite pins this:

* A committed `schema-snapshot-pre-pr-14-1.json` fixture is `PRAGMA table_info` for every user table produced by the **pre-PR** bootstrap (captured against `:memory:` before the refactor).
* The post-PR `database.js` is booted against `:memory:` from inside Jest and its schema diffed against the fixture.

The diff must be empty. A second test runs the migration runner against a legacy-shape DB (no migration columns) to prove the backfill path still works for older deployments.

## Consequences

**Wins.**

* **Cleaner `database.js`.** ~150 lines of inline ALTER blocks (and four `PRAGMA table_info(...)` wrappers) move out into named, single-purpose files. `database.js` reads as a schema declaration, not a schema declaration plus a small migration framework.
* **One obvious place for new columns.** "Add a new column" is now: create `server/migrations/<next-timestamp>-<desc>.js`, copy a sibling file's shape, add the line to `addColumn(...)`, optionally update the `CREATE TABLE` in `database.js` if the column should also exist on fresh clones.
* **The PR-14.1 test net.** Future structural changes to `database.js` have a regression test that fails fast if the schema drifts.

**Costs.**

* **One more concept.** Future contributors have to know that `database.js` holds ground-state and `server/migrations/2026*` holds forward-only changes. This ADR is the place we explain it.
* **Two migration conventions in flight.** The pre-Phase-14 ad-hoc scripts (`add-X.js`, `setup-X-tables.js`, `migrate-X.js`) sit alongside the new numbered files. The runner ignores the legacy ones — they're effectively documentation of past migrations. We do not rename or convert them; this would risk breaking the contract that "these ran at some point against deployed DBs" and would mix two conventions in test scope.

## Alternatives considered

* **knex-migrate / Umzug / db-migrate.** Real migration frameworks. They bring schema-tracking, up/down hooks, CLI tooling, and a much bigger conceptual surface — including the failure modes the tracking-table approach has. At single-host single-tenant scale with ~30 tables, the framework is overhead. The Phase 14 red-team flagged this explicitly: "the 'schema is painful' signal is a vote to clean up the inline sprawl, not to adopt a framework."
* **Convert the legacy scripts to the new convention.** Tempting for uniformity, but every legacy script ran at a specific point against specific deployments. Re-running them (especially the data-shape `migrate-*.js` ones, which aren't pure DDL) under a new boot path risks side effects we cannot enumerate. The cheaper, safer convention is "legacy scripts are documentation; new changes follow the new convention."
* **Hold all bootstrap inside an async boot function** rather than `db.serialize()` + callback-style migrations. Cleaner in isolation, but the existing bootstrap shape is depended on by every consumer that calls `require('./database')` immediately after import. Moving to async-boot would either introduce a new race window or require a much larger surface refactor. Outside Phase 14's scope.
