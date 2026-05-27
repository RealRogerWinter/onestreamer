# Phase 6+ handoff prompt (for a fresh Claude instance)

Copy the block below verbatim into a fresh Claude session at `/root/onestreamer/`.

---

You are starting Phase 6 of the autonomous refactor of `/root/onestreamer/`.

## Where Phases 1–5 left off (do NOT redo any of this)

**Phase 1** — uniform `async stop()` lifecycle on 12 services, shutdown loop that drains a `stoppables` registry, BotEventBus to decouple ChatBot ↔ MovieBot.

**Phase 2** — failing test documenting the points-balance lost-update race (`server/tests/services/AccountService.points-race.test.js`). TakeoverService concurrent-claim coverage. Bootstrap fail-fast guard for the service-factory DAG. Recording cleanup races recording upload (PR 2.6, gated on `b2_file_id IS NOT NULL` — partial; full fix is Phase 8.4). Stream-generation monotonic counter on stream-status emits.

**Phase 3** — three socket-emit chokepoints collapsing 58 sites: `StreamNotifier` (17 `stream-ended`), `ViewerCountNotifier` (13 `viewer-count-update`), `BuffNotifier` (28 buff/inventory). PR 3.4 deleted three module-scope dead helpers + the `global.viewBotIntervals` Map. URL-relay whitelist series (PRs W1–W6) added `WhitelistService` + `WhitelistEnforcer` with admin UI + ADR-0010.

**Phase 4** — three PRs against `server/index.js`: PR 4.1 socket-listener sweep, PR 4.2 LifecycleManager (ADR-0011), PR 4.3 partial startServer() decomposition (ADR-0012). `server/index.js` went 6198 → 5708. The biggest remaining concentration is the ~500-line MediaSoup-vs-LiveKit branch — **the headline Phase 9 target** in the Phase 6+ roadmap.

**Phase 5** — PR 5.1 atomic `addPoints`/`subtractPoints` via `UPDATE … RETURNING` (ADR-0013). PR 5.2 `better-sqlite3` adapter behind `USE_BETTER_SQLITE3` env flag (ADR-0014; default OFF; runbook at `docs/operations/runbooks/better-sqlite3-rebuild.md`). PR 5.3 `ChatBotRepository` extracts 40 inline SQL calls from `ChatBotService.js` (1364 → 1230 lines). Suite went 413 → 450. Three repository modules exist: `UserRepository`, `ItemRepository`, `ChatBotRepository`.

## The Phase 6+ plan

**Read this in full before any work:**

```
docs/architecture/plans/phases-6-plus.md
```

It is the canonical roadmap. Nine phases (6 through 14), ~25 PRs total, four priority axes (refactor & modularity / reliability & correctness / operational excellence / test coverage). The doc was red-teamed by two adversarial subagent passes before publication; the sequencing constraints at the bottom are load-bearing — do not interleave phases without checking them.

**If `docs/architecture/plans/phases-6-plus.md` is missing from main**, the roadmap is on branch `phase-6-plus-roadmap` (PR #123). Either merge it first or pull just the file: `git checkout phase-6-plus-roadmap -- docs/architecture/plans/phases-6-plus.md`.

### Phase 6 (your immediate scope)

Three independent repository extractions, all LOW risk. Continues PR 5.3's pattern (extract inline SQL into a per-service repository module that mirrors `UserRepository` / `ChatBotRepository`).

- **PR 6.1 — `ViewBotRepository`** — extract 20 SQL calls from `server/services/ViewBotDatabaseService.js`. Tables: `viewbots`, `viewbot_sessions`, `viewbot_metrics`, `viewbot_rotation_history`, `viewbot_system_state`. The service uses shared DB primitives (not its own sqlite3 handle), so it's mechanical. ~120 LoC + tests.
- **PR 6.2 — `BuffRepository`** — extract 12 SQL calls from `server/services/BuffDebuffService.js`. Single table `active_buffs`. ~90 LoC.
- **PR 6.3 — `ContinuousRecordingRepository`** — extract 12 SQL calls from `server/services/ContinuousRecordingService.js`. Tables: `recording_sessions`, `recording_stream_segments`. ~100 LoC.

All three: no business-logic change, no ADR, no service-side method-signature change. Each PR's success criterion: existing tests still pass + the new repo's unit tests cover every method's SQL shape + parameter ordering + default values (mirror `server/tests/database/repository/ChatBotRepository.test.js` which has 37 tests for the precedent).

### After Phase 6

Phase 7 (money flow atomic + repo extraction, HIGH risk, ADR-0015 required) is next. **Do not skip the `withTransaction` helper PR 7.1** — under sqlite3 (`USE_BETTER_SQLITE3=false`), inline `BEGIN IMMEDIATE` does NOT serialize concurrent calls because libuv queues them independently. The helper is the foundation that makes PR 7.4 (ShopService atomic refactor) safe.

Read the full roadmap before starting Phase 7.

## Constraints (still in effect)

- CI red OK; merge with `gh pr merge <num> --squash --delete-branch --admin`.
- Single-host single-tenant; no `pm2 restart` in any PR.
- Don't touch `.bak-*` files, `.db-shm`, `.db-wal`. They show up as untracked; leave them.
- Don't write to `server/data/onestreamer.db` directly. Copy to `/tmp` first if you need a snapshot for testing. Production DB is ~2.2 GB.
- No new `.md` files at repo root — everything except the six canonical files goes under `/docs/`.
- Write an ADR (`docs/architecture/adr/`) when you make a non-trivial design decision. Phase 7, 8, 9, 11, 12, 14 each have at least one ADR-required PR (numbered 0015 → 0020 in the roadmap).
- Spawn a reviewer subagent (harsh prompt) for non-trivial PRs before merge — the pattern that caught honesty issues in PRs 5.1, 5.2, 5.3.
- Address reviewer findings in a follow-up commit on the SAME branch (NOT amended).
- Test-env-flag matrix (per the roadmap): every new repository test must run under both `USE_BETTER_SQLITE3=true` AND `USE_BETTER_SQLITE3=false`. Trivial Jest helper: `describe.each([{flag: 'true'}, {flag: 'false'}])`.

## Workflow per PR (unchanged from Phase 5)

1. Branch from main with kebab-case name (e.g. `viewbot-repository`).
2. Implement; `node --check`; `npx jest --config config/jest/jest.config.js <path> --testPathIgnorePatterns=worktrees`.
3. Update CHANGELOG.md under `## [Unreleased]` — be honest about scope, what's tested, what's deferred. "Byte-equivalent" is reserved for actually-byte-equivalent refactors; default to "behavior-preserving" + name any textual deltas (precedent: PR 5.3's honesty fix).
4. Commit (HEREDOC body explaining WHY) → push → `gh pr create`.
5. Spawn a code-reviewer subagent (harsh prompt) for non-trivial PRs. Use `general-purpose` subagent_type. The reviewer reads the diff + ADRs + CHANGELOG and reports blockers / honesty issues / nits.
6. Address blockers + honesty issues in a follow-up commit on the branch (NOT an amend).
7. `gh pr merge <num> --squash --delete-branch --admin`.
8. `git checkout main && git pull origin main`.
9. If origin/main has moved during your work, merge it in before pushing — CHANGELOG conflicts are common.

## Tips specific to Phase 6

- **The repository pattern is established.** Read these in order before starting PR 6.1:
  - `server/database/repository/ChatBotRepository.js` (the newest exemplar — 5 tables, dynamic UPDATE).
  - `server/tests/database/repository/ChatBotRepository.test.js` (the 37-test precedent for repo unit tests).
  - `server/services/ChatBotService.js` (how the service consumes the repo).
  Don't reinvent the constructor shape. `constructor(deps = {})` with deps `{getAsync, runAsync, allAsync}`, fall back to `require('../database')` primitives when omitted. References captured at construction time — comment noting that the env-flag swap from ADR-0014 happens at module load before any service is constructed, so the captured refs are correct.

- **Serialization stays in the service.** If a column stores JSON (e.g. `personality_traits`), the service does `JSON.stringify(...)` before calling the repo. The repo only knows about strings.

- **Whitelisting stays in the service.** If a route handler accepts a partial update, the service whitelists which columns are mutable. The repo's `updateFields(id, fields)` builds the SET clause from whatever keys it receives — no implicit guard.

- **Bootstrap is NOT updated.** Repository instances are constructed inside their owning service's constructor (matching UserRepository's wiring inside AccountService, and ChatBotRepository's inside ChatBotService). `expectedKeys` in `server/tests/bootstrap/services.test.js` stays at 39. The trade-off: the bootstrap fail-fast guard cannot detect a missing or shimmed repo dep. Same trade-off the existing repos carry.

- **One textual delta to watch for.** When refactoring, double quotes `"now"` should NOT be silently changed to single quotes `'now'` in inline SQL — SQLite treats them equivalently, but it's a textual delta worth noting in the CHANGELOG. (Precedent: PR 5.3's reviewer caught this.)

## Reviewer subagent prompt template

For PRs 6.1, 6.2, 6.3 (mechanical, low-risk), the reviewer prompt can be shorter than the PR 5.3 prompt. Example:

```
You are a senior reviewer giving an independent, harsh review of PR <N> of the OneStreamer
autonomous refactor. Repo at /root/onestreamer. PR branch: <branch>. PR #<num>.

The claim: this PR extracts N inline `database.runAsync/getAsync/allAsync` calls from
`server/services/<ServiceName>.js` into a new `server/database/repository/<RepoName>.js`,
mirroring the UserRepository / ChatBotRepository pattern. Behavior should be byte-equivalent.

Files in the diff: ...

Check:
1. Are all N callsites actually migrated? `grep -nE "database\\.(runAsync|getAsync|allAsync)"
   on the modified service file should return zero matches.
2. Is the migration byte-equivalent? Any textual deltas (quote style, whitespace,
   reordering) must be called out in the CHANGELOG.
3. Are the repo's unit tests covering: SQL shape (whitespace-normalized), parameter
   ordering, default values, dep-injection, fallback path? Compare against
   ChatBotRepository.test.js as the bar.
4. Did the service's serialization choices (JSON.stringify, etc.) stay in the service,
   or did they leak into the repo? They should stay.
5. Are tests passing under both USE_BETTER_SQLITE3=true and =false? (See test-env-flag
   matrix in docs/architecture/plans/phases-6-plus.md.)

Report findings in three buckets: blockers / honesty issues / nits. Under 500 words. Specific.
```

## First action

```bash
cd /root/onestreamer
git status                                                       # check for any uncommitted local state
git log --oneline -10                                            # confirm you're on the right branch
git checkout main && git pull origin main                        # sync
ls docs/architecture/plans/phases-6-plus.md && head -50 $_       # confirm the roadmap is on main
                                                                 # if not, merge PR #123 or check out the doc:
                                                                 #   git checkout phase-6-plus-roadmap -- docs/architecture/plans/phases-6-plus.md
```

Then read the roadmap in full. Then:

```bash
# Confirm the Phase 6 target file is still the size the discovery agent saw:
wc -l server/services/ViewBotDatabaseService.js
# Count the callsites to migrate:
grep -cE "(runAsync|getAsync|allAsync)\(" server/services/ViewBotDatabaseService.js
# Should be ~20.
```

Then start PR 6.1 — branch `viewbot-repository`, mirror ChatBotRepository, ship.

## When to stop

There is no Phase 15 in the roadmap. After Phases 6–14 close, the architectural debt the codebase carries today is largely addressed. If you find yourself reaching for a Phase 15, stop and write a new brief for the maintainer to review — don't keep going without explicit re-authorization.

If any phase's success criteria aren't met (e.g. ViewBotClientService still >3000 lines after Phase 11.2 closes), that's a Phase incomplete — open a follow-up PR within that same phase, don't roll into a new one.

Good luck. After Phase 6 closes, three more services have moved to the repository pattern and the codebase has six repository modules in the canonical place. The pattern is by then well-grooved; subsequent phases get progressively harder but each phase you complete makes the next one easier.

---

## End of fresh-Claude prompt
