# Phase 6+ refactor roadmap

_Last revised: 2026-05-27 against `main` at commit `a7891d0` (PR 5.3 merged)._
_Red-teamed: two adversarial subagent passes (scope/over-engineering + execution/risk) before publication._

This document captures the multi-phase refactor plan after Phase 5 closed. Where Phase 5 was scoped tightly (the DB layer: atomic counters, better-sqlite3 adapter, ChatBotRepository), Phase 6+ is a longer horizon — nine phases covering the four priority axes the maintainer signalled (modularity, reliability, operational excellence, test coverage). Each phase ships in the Phase 5 cadence: 2–4 small focused PRs per phase, one ADR when the decision warrants it, CHANGELOG entry per PR, reviewer subagent pass before merge.

The phases are ordered by a deliberate sequencing — the red-team flagged several interleave hazards (logging sweep can't precede decomp; money atomic must precede reliability bundle; etc.) and the order below respects those. **Phases are not interchangeable. Read the "Sequencing constraints" section at the bottom before re-ordering anything.**

---

## Where we are at end-of-Phase-5

- **server/index.js**: 5708 lines. Phase 4 chipped off ~500. The remaining ~500-line MediaSoup-vs-LiveKit branch in `startServer()` is the ADR-0012-flagged target — and per the maintainer's "huge services" pain signal, the headline Phase 6+ decomposition target.
- **ViewBotClientService.js**: 6015 lines. The single largest server file. Per ADR-0012's precedent, this is a service-level decomp problem — different shape from `startServer()`'s orchestrator decomp.
- **Repositories in place**: `UserRepository`, `ItemRepository`, `ChatBotRepository` (3 of ~10 candidates).
- **DB layer**: atomic-SQL principle codified (ADR-0013). better-sqlite3 adapter shipped behind env flag (ADR-0014); awaiting Phase B operator-side smoke.
- **Top hazards** (from runbooks + ADR follow-ups, with owners assigned in this plan):
  - ShopService.purchaseItem non-atomic multi-statement (lost-item-after-paid risk) → **Phase 7**.
  - Recording cleanup vs upload race → **Phase 8.4**.
  - ViewBot rotation stuck-loop → **Phase 8.2** (watchdog, log-and-alert only).
  - ViewBot child-process leaks on shutdown → **Phase 8.3** (force-reap).
  - Secret rotation (LiveKit default creds) → **Phase 8.5** (one-PR operator task).
- **Tests**: 450/450 green. ~30 services have zero coverage; the highest-risk untested surface is money-flow (ShopService, parts of AccountService).
- **Maintainer signal**: all four priority axes matter, small focused PRs, the headline pain is huge files / orchestrator size, full latitude on scope.

### What this roadmap does NOT cover

- **Client-side refactoring.** The discovery agent confirmed the client (`/root/onestreamer/client/src/`) is already modular — components in `components/`, services in `services/`, hooks in `hooks/`. No file > 800 lines in steady state. Client work is out of scope by design, not oversight.
- **MediaSoup/LiveKit protocol changes.** Streaming-core protocol behavior is preserved across all phases. Where the orchestrator decomp (Phase 9) touches the streaming branch, alignment is behavior-preserving, not semantic.
- **New feature work.** Refactor only.

---

## Themes

| Theme | What it means | Phases that lean here |
|-------|---------------|----------------------|
| **Refactor & modularity** | Repositories, decompose huge services, finish the orchestrator decomp. The maintainer's #1 pain. | 6, 7, 9, 10, 11 |
| **Reliability & correctness** | Atomic-SQL audit beyond points, race-fix the runbook-flagged hazards, transactional safety where it matters (money). | 7, 8 |
| **Operational excellence** | Structured logging sweep, watchdogs for stuck loops, force-reap on shutdown, secret rotation. | 8, 12 |
| **Test coverage hardening** | Backfill the highest-risk untested surfaces — money flow, ViewBot lifecycle, recording pipeline. | 13 |

---

## Phase 6 — Repository rollout wave 1 (low-risk warm-up)

**Theme**: Refactor & modularity. **Risk**: LOW. **Cadence**: 3 PRs.

Three independent extractions, no inter-dependencies, no business-logic risk. Pure SQL-shim moves. Builds confidence + establishes consistency for the higher-risk waves.

### PR 6.1 — `ViewBotRepository`

Extract 20 inline SQL calls from `server/services/ViewBotDatabaseService.js` into a new repository. Tables: `viewbots`, `viewbot_sessions`, `viewbot_metrics`, `viewbot_rotation_history`, `viewbot_system_state`. The discovery agent confirmed this service uses the shared primitives (not its own sqlite3 handle), so it's fully mechanical.

- Size: ~120 LoC repo + tests.
- Risk: LOW.
- No ADR.

### PR 6.2 — `BuffRepository`

Extract 12 inline SQL calls from `server/services/BuffDebuffService.js`. Single table: `active_buffs`. In-memory cache already covers the hot path, so DB writes are infrequent.

- Size: ~90 LoC.
- Risk: LOW.

### PR 6.3 — `ContinuousRecordingRepository`

Extract 12 inline SQL calls from `server/services/ContinuousRecordingService.js`. Tables: `recording_sessions`, `recording_stream_segments`. 1:N relationship, single repo.

- Size: ~100 LoC.
- Risk: LOW.

**Success criteria**: 32+ inline SQL callsites removed from services, three new repo unit-test files, suite green. Repository pattern proven across 6 services total (UserRepo, ItemRepo, ChatBotRepo, ViewBotRepo, BuffRepo, ContinuousRecordingRepo).

---

## Phase 7 — Money flow atomic + repo extraction

**Theme**: Reliability + refactor. **Risk**: HIGH (money). **Cadence**: 4 PRs.

The most delicate phase in Phase 6+. ShopService.purchaseItem has a residual non-atomic multi-statement hazard: points debit succeeds, then the server crashes between the inventory INSERT and item_transactions INSERT, and the user paid for nothing. That's a direct user-visible loss. Sequencing matters: build the infrastructure first, atomic-refactor second, extraction third.

### PR 7.1 — `withTransaction` helper

Add a `withTransaction(fn)` helper to `server/database/database.js`. Works under **both** sqlite3 and better-sqlite3 backends; the latter is sync so its implementation is trivial, the former needs explicit `BEGIN IMMEDIATE` + try/finally with ROLLBACK on throw. **Why a helper, not inline `BEGIN IMMEDIATE`**: red-team #2 caught that under sqlite3, `runAsync('BEGIN IMMEDIATE')` does NOT serialize subsequent `await runAsync(...)` calls against the same handle — they go through libuv and other unrelated callers can interleave. A helper owns a single statement chain (under sqlite3) or a single sync block (under better-sqlite3), guaranteeing serialization. **Connection-count interaction**: with `USE_BETTER_SQLITE3=true`, the four open handles (main sqlite3 + adapter + WhitelistService + URLStreamDatabaseService) share the WAL'd file; a `BEGIN IMMEDIATE` on the adapter holds the writer lock and other connections SQLITE_BUSY-spin up to 5 s. Documented in the helper's doc-comment; the helper accepts an optional `busyTimeoutMs` for callers that want to fail-fast.

- Size: ~80 LoC helper + ~120 LoC test (both backends, both code paths).
- Risk: MEDIUM (foundational; bugs in the helper compound elsewhere).
- ADR: **ADR-0015** — "Transaction shape for multi-statement DB operations." Documents the helper API, the busy-timeout trade-off, the writer-lock contention with the multi-handle shape from ADR-0014.

### PR 7.2 — `UserInventoryRepository`

Extract 12 inline SQL calls from `server/services/InventoryService.js`. Single table: `user_inventory` (plus JOIN to `items`, already covered by ItemRepository). The `item_transactions` INSERT stays in place (covered by PR 7.3 below).

- Size: ~120 LoC.
- Risk: LOW (inventory mutations are non-financial).
- No ADR.

### PR 7.3 — `ItemTransactionRepository` + `ShopRepository` (read-only methods)

Extract the read-only ShopService SQL (8 SELECT-shaped queries) into `ShopRepository` + the 5 `item_transactions` callsites scattered across services into `ItemTransactionRepository`. ShopService's MUTATION path stays inline for PR 7.4 — separating read from write keeps this PR mechanical and reviewable.

- Size: ~150 LoC repos + ~60 LoC tests.
- Risk: LOW.
- No ADR.

### PR 7.4 — ShopService.purchaseItem atomic refactor + mutation-half ShopRepository

Re-do `purchaseItem` via the `withTransaction` helper from PR 7.1. The transaction wraps: `subtractPoints` (already atomic per PR 5.1, but the call still happens inside the tx for rollback safety), `INSERT into user_inventory`, `INSERT into item_transactions`. Crash recovery: if the server dies mid-tx, sqlite3 rolls back on next open; the user's points are not debited because the COMMIT didn't fire. After the atomic refactor, extract the mutation-half SQL into ShopRepository (the inserts/updates that weren't in PR 7.3).

- Size: ~150 LoC service refactor + ~100 LoC ShopRepository additions + ~80 LoC tests.
- Risk: **HIGH** — money flow. Reviewer subagent pass mandatory. Live smoke (the `docs/getting-started/first-stream.md` walk-through, focused on the buff-purchase step) before close.
- ADR: cross-reference ADR-0015 only.

**Success criteria**: ShopService.purchaseItem is atomic across the full debit→credit chain. New integration test exercises happy path + simulated mid-tx crash → no points debited. Buff-purchase smoke passes. Reviewer subagent reports zero blockers.

**Sequencing note**: The user-visible nature of this hazard (lost paid item) pushes Phase 7 ahead of Phase 8's runbook hazards — red-team feedback. Operational hazards degrade ops; money loss directly costs users.

---

## Phase 8 — Reliability hardening (runbook-flagged hazards)

**Theme**: Reliability + operational. **Risk**: MEDIUM. **Cadence**: 4 PRs (+ one optional operator-task PR).

Closes the runbook-flagged hazards that have been "living with us" — none are new but all degrade ops or reliability. **PR 8.1 (atomic-SQL audit closure) was deleted from this phase after red-team #2 verified the supposed hazard does not exist**: `TimeTrackingService` writes flow through `AccountService.updateUserStats()` which already uses relative-arithmetic `UPDATE … SET col = col + ?`. There is no read-compute-write race to fix.

### PR 8.1 — Atomic-SQL audit (verification PR)

A short verification PR that DOCUMENTS what was audited. Run `grep -rE "(SELECT|getAsync).*(stream_time|view_time|chat_message_count|stream_count|quantity|view_count)" server/` and confirm every consumer either (a) reads for display or (b) uses the relative-arithmetic write path. Output: an entry under `docs/architecture/background-work.md` ("Atomic-SQL audit closure") naming the checked counters + the verified safe pattern. NO code change.

- Size: ~30 lines of docs.
- Risk: NONE.
- ADR: cross-reference ADR-0013 only.

### PR 8.2 — ViewBot rotation watchdog (log + alert only)

Per `docs/operations/runbooks/viewbot-fleet-misbehaving.md`: an unhandled exception in `UnifiedViewBotRotation`'s tick loop stops advance indefinitely. Add a watchdog: each tick records `lastTickAt`; a separate `setInterval` checks if `Date.now() - lastTickAt > rotationIntervalMs * 2` and **logs a `level: error` event** with rotation-state context. **Does NOT restart the rotation loop** — red-team #2 caught that "restart" on top of a still-hung promise just queues a second hung promise, since `rotationLock` is still held. The watchdog is observability infrastructure for an existing supervisor (pm2) to do the right thing; the supervisor restart, not the watchdog, is what recovers.

- Size: ~80 LoC + ~50 LoC test.
- Risk: LOW (purely additive; no behavior change to the rotation itself).
- ADR: ADR-0016 — "Tick-loop watchdog pattern (observability only)." Codifies log-and-alert as the chosen recovery mode; documents why active-restart is the wrong choice for hung event-loop code.

### PR 8.3 — ViewBot child-process force-reap on shutdown

Track all `gst-launch-1.0` / `chrome` child PIDs spawned by ViewBot services. On `LifecycleManager.stop()`, send SIGKILL to any that haven't exited within ~2 s grace. Closes the orphan-process leak documented in the runbook.

- Size: ~100 LoC service additions + LifecycleManager hook + ~60 LoC test.
- Risk: MEDIUM (killing processes during shutdown can corrupt state if mid-write — needs recording-pipeline test).
- ADR: cross-reference ADR-0011 (LifecycleManager). New section on child-process tracking; ~30 lines appended.

**Cross-phase pin**: PR 8.3 must close before PR 12.3 starts. If Phase 12 (observability + trace IDs) lands first, PR 8.3 has to retrofit trace IDs into child-process logging. Conversely if 8.3 lands first, Phase 12 retrofits. Pin 8.3 first.

### PR 8.4 — Recording cleanup vs upload race

`RecordingCleanupScheduler` deletes by age with no `b2_file_id IS NOT NULL` check; uploads run on a separate cadence. Failed uploads can lose local segments before the retry window. Fix: clean up only files where `b2_file_id IS NOT NULL` OR `created_at < (cutoff - retry_window)`. New test: simulate failed upload + cleanup tick; segment survives.

- Size: ~40 LoC service change + ~80 LoC test.
- Risk: MEDIUM (data loss avoidance — straightforward fix).
- No ADR.

### PR 8.5 — LiveKit secret rotation (operator-task PR)

Rotates the default LiveKit devkey/devsecret used in `config/livekit.yaml`. Generates a new random pair, updates the config, updates the runbook (`secret-rotation.md`) to point at the new values, smokes the URL-relay path. **This is mostly a procedure-execution PR**, not a code change — but tracking it as a PR ensures it actually happens.

- Size: ~20 LoC config change + runbook update.
- Risk: MEDIUM (rotating creds wrongly breaks the LiveKit pipeline).

**Success criteria**: All five runbook entries get "Resolution" lines pointing at the closing PRs. ViewBot fleet recovery time on stuck-loop = pm2 restart latency (no longer "manual intervention"). Recording segments survive failed B2 uploads.

---

## Phase 9 — server/index.js MediaSoup/LiveKit alignment + extraction

**Theme**: Refactor & modularity. **Risk**: HIGH. **Cadence**: 3 PRs.

The ADR-0012-flagged headline target, and the maintainer's #1 pain. The ~500-line MediaSoup-vs-LiveKit branch in `startServer()` is "90% identical but diverging in 6+ places that look symmetric but aren't" — ADR-0012's own warning. Two-step: align first (behavior-preserving dedup), THEN extract. Red-team #2 caught that the alignment is HOURS of investigation per divergence, not "~50–150 LoC of changes" — splitting into a dedicated archaeology PR + apply-fixes PR makes the work shape honest.

### PR 9.1 — Divergence archaeology

Read both branches line by line, annotate each of the 6+ identified divergences (and any new ones discovered during the read). For each: `git blame` the introduction, find the original PR/intent, classify as bug/intentional/accidental. NO code changes. Output: a structured doc at `docs/architecture/plans/mediasoup-livekit-divergences.md` listing each divergence + classification + recommended action.

- Size: ~400 lines of analysis doc. May take 2–3 days wall-clock.
- Risk: LOW (read-only; the risk is the wall-clock time, not the work).
- ADR: ADR-0017 — "MediaSoup/LiveKit branch alignment plan." References the archaeology doc.

### PR 9.2 — Apply alignment fixes

For each divergence classified in PR 9.1: apply the fix, run the test suite, **smoke both branches** (toggle `USE_WEBRTC_ADAPTER` between true/false and walk the streaming smoke). PR description names every divergence resolved + the alignment outcome.

- Size: ~100–200 LoC total (small changes across many sites).
- Risk: HIGH. Reviewer subagent pass mandatory. Live smoke on BOTH backends mandatory.

### PR 9.3 — Extract aligned branch

Move the now-aligned ~500-line branch into `server/bootstrap/start-streaming-backend.js`. Same shape as PR 4.3's `start-listeners.js` extraction. ViewBotClientService / MediasoupService / LiveKitService instances are constructed in the new module and threaded back through the bootstrap deps bag.

- Size: ~500 LoC moved + ~30 LoC shim + bootstrap test additions.
- Risk: MEDIUM (the hard work was PR 9.2).

**Success criteria**: `server/index.js` drops to ~5100 lines or below. The "intentional differences" between MediaSoup and LiveKit are all behind explicit `if (backend === 'mediasoup')` switches with comments naming the original reason. Both backends pass the smoke walk-through.

---

## Phase 10 — Repository rollout wave 2

**Theme**: Refactor & modularity. **Risk**: MEDIUM. **Cadence**: 3 PRs.

Closes the remaining major repository candidates. After Phase 10, every DB-touching service in the top-8 has a repository.

### PR 10.1 — `RecordingSessionRepository` + `AdminReviewSettingsRepository`

Extract 24 inline SQL calls from `server/routes/admin-recordings.js`. Two repos because they cover different concerns (sessions vs settings). One JOIN at line 1034 needs thought — handle in the repo or stay in the route? Recommend route, repo only owns single-table queries.

- Size: ~250 LoC repos + ~60 LoC tests.
- Risk: MEDIUM (read-mostly admin endpoints; clip + recording UIs depend on the shape).

### PR 10.2 — `ClipRepository` (with atomic CREATE)

Extract 18 inline SQL calls from `server/services/ClipService.js`. Three tables (`clips`, `clip_chat_messages`, `clip_views`). The multi-step CREATE path that's currently not transactional gets atomicized in the same PR via the `withTransaction` helper from PR 7.1. Lower risk than ShopService because clips don't move points, but same shape.

- Size: ~250 LoC repo + ~80 LoC tests.
- Risk: MEDIUM (user-visible creation failures).
- ADR: cross-reference ADR-0015.

### PR 10.3 — `AccountStatsRepository` + `UserSessionRepository`

Extract the non-users-table AccountService SQL (`user_stats`, `user_sessions`, `points_transactions`, `account_deletion_logs`, `ip_to_user_transfers`). Two repos because the concerns are separable. PR 5.1's atomic-points SQL stays untouched — it's behavior-preserved through the new repo methods.

- Size: ~200 LoC + ~60 LoC tests.
- Risk: LOW-MEDIUM.

**Success criteria**: Top-8 DB-touching services + admin-recordings route all have repositories. AccountService becomes a thin orchestrator over UserRepository, AccountStatsRepository, UserSessionRepository.

---

## Phase 11 — ViewBotClientService decomposition

**Theme**: Refactor & modularity. **Risk**: HIGH (state ownership). **Cadence**: 2 PRs + contingency.

The 6015-line ViewBotClientService is the single largest server file. The codebase-hotspot agent's read suggests "2–3 separate rotation modes tangled together." **The red-team caught a critical contingency**: if the modes share state (`this.activeBots`, `this.botCooldowns`, `this.rotationLock`, `this.pendingTakeoverTimer` — visible at lines 44–115), extracting one mode breaks the other two. The plan needs an EXPLICIT fallback for the non-separable case.

### PR 11.1 — Mode discovery (combined with extraction prep)

Unlike Phase 9's archaeology-as-separate-PR pattern, this is the EXTRACTION PR with discovery as its prep. Read the file fully, identify modes and their state ownership, decide:
- **Path A (separable modes)**: extract mode #1 into `server/services/viewbot/mode-<name>.js`. ViewBotClientService becomes a thin dispatcher.
- **Path B (non-separable, shared state)**: don't extract modes. Instead, reorganize the file into clearly-marked regions, extract pure helpers (state-free utilities) into a `viewbot/helpers.js` module, and pull DB code into the existing ViewBotRepository (PR 6.1). The file might only shrink from 6015 to 5000 — accept that and document why.

Whichever path the discovery picks, the PR's diff is the path-A extraction OR the path-B reorg. NO standalone discovery doc; the analysis lives in the PR description. Saves one PR vs. the prior version of this roadmap.

- Size: variable; path A is ~800 LoC moved + ~100 LoC dispatcher + bootstrap test rewrites (called out by red-team #2 as +200 LoC of test rewrites the original estimate missed); path B is ~400 LoC reorganized + helper extraction + ~50 LoC test.
- Risk: HIGH. Reviewer subagent pass mandatory.
- ADR: ADR-0018 — "ViewBotClientService decomposition outcome." Documents which path was taken + why.

### PR 11.2 — Second mode extraction OR follow-up cleanup

If PR 11.1 took path A and a clean second mode exists, extract it. Otherwise, PR 11.2 is general cleanup of the post-11.1 state. The branch + PR shape is decided in PR 11.1's wrap-up.

- Size: similar to 11.1.
- Risk: HIGH.

**Success criteria**: ViewBotClientService is structurally improved — either decomposed into modules (path A) or reorganized into navigable regions (path B). Operator able to find what they're looking for in <60 s.

---

## Phase 12 — Observability sweep (logging + tracing)

**Theme**: Operational excellence. **Risk**: LOW (per-PR), HIGH coordination cost if interleaved with decomps. **Cadence**: 3 PRs.

**STRICT SEQUENCING CONSTRAINT** (red-team #1 finding): Phase 12 lands **after Phases 7, 8, 9, 10, 11**. The logging sweep touches every service file; if it lands before those decomps, every Phase 7–11 diff is contaminated by logger churn. Conversely, if those phases land first, the sweep retrofits ALL their new code at once. Both are bad — but "after" is less bad because the post-decomp file boundaries are settled.

### PR 12.1 — Logging convention ADR + inventory

ADR-0019 codifies: every service gets a namespaced pino child logger. Conventions for level usage. Inventory of current `console.*` callsites grouped by service. NO code changes.

- Size: ADR ~100 lines + inventory ~50 lines.
- Risk: LOW.

### PR 12.2 — Sweep top 20 services

Replace `console.*` with namespaced pino in the 20 highest-density services. Includes `StreamService`, `ViewBotClientService` (post-decomp), `ContinuousRecordingService`, etc.

- Size: ~500 lines touched.
- Risk: LOW.

### PR 12.3 — Sweep remainder + trace IDs

Finish the sweep. Add `_traceId` to every socket-event payload via the chokepoint notifiers (StreamNotifier, ViewerCountNotifier, BuffNotifier from Phase 3). Trace IDs propagate from the originating HTTP route through the socket emit, so a production debugging session can grep one ID across both layers.

- Size: ~400 lines touched + ~80 LoC trace-ID helper.
- Risk: LOW.

**Success criteria**: Zero `console.log`/`console.error` outside of `bootstrap/logger.js` and migration scripts. Every socket event carries a `_traceId`. A "what happened" production query becomes a single `grep <traceId>` against the pino output.

---

## Phase 13 — Test coverage hardening

**Theme**: Test coverage. **Risk**: LOW. **Cadence**: 3 PRs + budget constraint.

Backfill the highest-risk untested surfaces. Per the discovery: ~30 services have zero coverage; only the loudest-failure ones get covered here.

**Wall-clock budget constraint** (red-team #2 finding): the suite is 450 tests / 8–15 s today. Phase 13 targets ~600 tests. Integration tests are 10–100× slower than units. Split the suite: `npm test` runs units (target stays <20 s); `npm run test:integration` runs the new integration suite (no time target). CI runs both.

**Test-env-flag matrix** (red-team #2 finding): every new repository test must run under both `USE_BETTER_SQLITE3=true` and `USE_BETTER_SQLITE3=false`. Trivial Jest helper: a `describe.each([{flag: 'true'}, {flag: 'false'}])` wrapper.

### PR 13.1 — Money flow integration tests

Cover: `ShopService.purchaseItem` (atomic path + failure path, after Phase 7 ships), `AccountService.addPoints/subtractPoints` end-to-end through the route layer, the inventory + buff flows triggered by a purchase. Uses in-memory better-sqlite3 backend.

- Size: ~300 LoC test + integration scaffolding.
- Risk: LOW.

### PR 13.2 — ViewBot lifecycle tests

Cover: `UnifiedViewBotRotation` watchdog behavior (after Phase 8.2 ships), ViewBot force-reap (after Phase 8.3 ships), the extracted mode modules from Phase 11.

- Size: ~250 LoC.
- Risk: LOW.

### PR 13.3 — Recording pipeline tests

Cover: `ContinuousRecordingService` lifecycle, `RecordingCleanupScheduler` vs upload race (closes the integration-test gap for Phase 8.4), `B2` upload retry behavior.

- Size: ~250 LoC.
- Risk: LOW.

**Success criteria**: Suite splits into unit + integration. Unit pass stays <20 s. Money + ViewBot + recording surfaces have integration coverage. Total combined suite ~600 tests.

---

## Phase 14 — Schema cleanup (NOT a migration framework)

**Theme**: Reliability + tooling. **Risk**: LOW. **Cadence**: 1 PR.

Red-team #1 flagged the original Phase 13 plan as over-engineered for the single-host single-tenant posture. The user's "schema is painful" signal is a vote to clean up the inline `ALTER TABLE catch duplicate column` sprawl in `database.js`, not to adopt a migration framework. Collapse to one PR.

### PR 14.1 — Extract inline ALTER TABLE block

Move the ~30 inline `ALTER TABLE ... CATCH duplicate column` calls out of `server/database/database.js` and into properly-shaped numbered migration scripts under `server/migrations/2026MMDDHHMM-<description>.js`. Each migration is idempotent (the same "if column doesn't exist, add it" check it has today). The schema bootstrap at the top of `database.js` (CREATE TABLE IF NOT EXISTS) stays — those are the ground-state schema, not migrations. The `applyPragmas` flow runs FIRST, then `initializeDatabase()` creates ground-state tables, then any pending migrations under `server/migrations/` execute in filename order. **Fresh-clone onboarding preserved**: `npm start` against an empty DB does CREATE TABLE → migrations → done. No manual `npm run migrate` step required.

- Size: ~200 LoC moved + ~50 LoC migration-runner code + ~50 LoC test.
- Risk: MEDIUM (the schema bootstrap is load-bearing; the diff must produce a bit-identical schema state).
- ADR: ADR-0020 — "Schema migrations layout (light-weight, no framework)." Documents the in-filename-order convention and why we DIDN'T adopt knex-migrate/umzug/db-migrate at this scale.

**Success criteria**: New schema changes are written as numbered migration files, not as inline ALTERs in `database.js`. `database.js` shrinks ~150 lines. `npm start` against an empty DB produces a working schema with no manual steps.

---

## Sequencing constraints

**Strict ordering** (do not interleave):

```
Phase 6  ──▶  Phase 7  ──▶  Phase 8  ──▶  Phase 9  ──▶  Phase 10  ──▶  Phase 11  ──▶  Phase 12  ──▶  Phase 13  ──▶  Phase 14
```

Specific cross-PR pins:

- **PR 7.1 (`withTransaction`) before PR 7.4** — the helper is the foundation.
- **PR 7.1 before PR 10.2** — ClipRepository's atomic CREATE uses the helper.
- **PR 8.3 (force-reap) before PR 12.3 (trace IDs)** — otherwise the trace-ID sweep retrofits force-reap, doubling work.
- **Phase 12 (observability sweep) AFTER Phases 7–11** — the sweep touches files those phases decompose; ordering matters to keep diffs reviewable.
- **Phase 13.1 AFTER Phase 7 closes** — money tests need the atomic refactor to actually be in place.
- **Phase 13.2 AFTER Phases 8.2/8.3/11 close** — ViewBot tests need watchdog + force-reap + decomp targets.

Phases CAN run in parallel against each other ONLY across separate branches, AND only where the cross-PR pin is respected.

---

## Cross-cutting concerns

### ADR discipline
- ADR-0015 — Transaction shape (PR 7.1).
- ADR-0016 — Tick-loop watchdog (PR 8.2).
- ADR-0017 — MediaSoup/LiveKit alignment (PR 9.1).
- ADR-0018 — ViewBotClientService decomp outcome (PR 11.1).
- ADR-0019 — Logging conventions (PR 12.1).
- ADR-0020 — Schema migrations layout (PR 14.1).

### Reviewer subagent discipline
Every non-trivial PR (Phase 7.1, 7.4, 8.3, 9.1, 9.2, 9.3, 10.1, 10.2, 11.1, 11.2, 14.1) spawns a `general-purpose` reviewer subagent with a harsh prompt before merge. Honesty fixes land in a follow-up commit on the same branch — NOT amended.

### CHANGELOG honesty bias
"Byte-equivalent" is reserved for actually-byte-equivalent. Default to "behavior-preserving" + name any textual deltas. Pattern set by PR 5.3's honesty fix.

### Live smoke before close (per phase)
- Phase 7: buff purchase end-to-end (`docs/getting-started/first-stream.md`).
- Phase 8: ViewBot fleet smoke (`viewbot-fleet-misbehaving.md`).
- Phase 9: full streaming walk on BOTH backends (toggle `USE_WEBRTC_ADAPTER`).
- Phase 11: streaming smoke (ViewBot modes hit by the rotation).
- Phase 14: fresh-clone smoke (`rm -rf node_modules server/data/onestreamer.db && npm install && npm start`).

### Operational checklist per phase
- Update `docs/architecture/background-work.md` "Notable hazards" → strike through resolved entries.
- Update relevant runbook "Resolution" lines to point at the closing PR.
- Update `docs/architecture/plans/phases-6-plus.md` (this doc) with phase-close status.

---

## Phase risk summary

```
Phase 6  ──┬── PR 6.1  ViewBotRepository                    [LOW]   ▓
           ├── PR 6.2  BuffRepository                        [LOW]   ▓
           └── PR 6.3  ContinuousRecordingRepository         [LOW]   ▓

Phase 7  ──┬── PR 7.1  withTransaction helper (+ADR-0015)    [MED]   ▓▓
           ├── PR 7.2  UserInventoryRepository               [LOW]   ▓
           ├── PR 7.3  ItemTransaction + ShopRepo (RO)       [LOW]   ▓
           └── PR 7.4  ShopService atomic + ShopRepo (RW)    [HIGH]  ▓▓▓▓

Phase 8  ──┬── PR 8.1  Atomic-SQL audit (verification)       [NONE]  ▓
           ├── PR 8.2  ViewBot watchdog (+ADR-0016)          [LOW]   ▓
           ├── PR 8.3  ViewBot force-reap                    [MED]   ▓▓
           ├── PR 8.4  Recording cleanup vs upload           [MED]   ▓▓
           └── PR 8.5  LiveKit secret rotation               [MED]   ▓▓

Phase 9  ──┬── PR 9.1  Divergence archaeology (+ADR-0017)    [LOW*]  ▓▓
           ├── PR 9.2  Apply alignment fixes                 [HIGH]  ▓▓▓▓
           └── PR 9.3  Extract aligned branch                [MED]   ▓▓

Phase 10 ──┬── PR 10.1 admin-recordings repos               [MED]   ▓
           ├── PR 10.2 ClipRepository + atomic CREATE        [MED]   ▓▓
           └── PR 10.3 AccountStats + UserSession repos      [LOW]   ▓

Phase 11 ──┬── PR 11.1 ViewBotClientService decomp (+ADR-0018)[HIGH] ▓▓▓▓
           └── PR 11.2 Follow-up cleanup or 2nd mode         [HIGH]  ▓▓▓

Phase 12 ──┬── PR 12.1 Logging ADR (+ADR-0019)              [LOW]   ▓
           ├── PR 12.2 Sweep top 20                          [LOW]   ▓
           └── PR 12.3 Sweep remainder + trace IDs           [LOW]   ▓▓

Phase 13 ──┬── PR 13.1 Money flow integration tests          [LOW]   ▓
           ├── PR 13.2 ViewBot lifecycle tests               [LOW]   ▓
           └── PR 13.3 Recording pipeline tests              [LOW]   ▓

Phase 14 ──── PR 14.1 Extract inline ALTERs (+ADR-0020)      [MED]   ▓▓
```

LOW*  = read-only PR but high wall-clock cost (2–3 days of archaeology).

---

## When to stop

There is no Phase 15 in this plan. After Phases 6–14 close, the high-priority architectural debt the codebase carries today is largely addressed: huge files decomposed, money flow atomic, observability standardized, schema sprawl cleaned up, the most-touched DB surfaces all repo'd.

**Review trigger** (not a Phase 15): if ViewBotClientService is still >3000 lines after PR 11.2 closes, that's a Phase 11 follow-up, not a new phase. Similarly, if any of the runbooks still have un-Resolution-ed hazards after Phase 8, those are Phase 8 incomplete, not a new phase. The phase number only increments for genuinely-new scope.

If a Phase 6+ Claude instance finds itself reaching for a Phase 15, it should stop and write a new brief for the maintainer to review. Don't keep going without explicit re-authorization.
