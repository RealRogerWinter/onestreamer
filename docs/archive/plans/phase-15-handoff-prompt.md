> [!NOTE]
> **COMPLETED — historical.** This roadmap/handoff/inventory has been executed and is preserved for the record only; it is **not maintained** and its file/line references reflect the tree at the time it was written (pre-ADR-0024). _Archived 2026-06-01._

# Phase 15 handoff prompt (for a fresh Claude instance)

Copy the block below verbatim into a fresh Claude session at `/root/onestreamer/`.

---

You are starting Phase 15 of the autonomous refactor of `/root/onestreamer/`. Phases 1–14 are done. Phase 15 is a tightly-scoped recovery + completion brief: finish work that Phase 12 claimed but didn't fully deliver, then resume the `server/index.js` decomposition that Phase 9 only sampled. It is NOT new domain work.

## How Phase 15 came to exist (do NOT redo this discovery)

A post-Phase-14 audit ran six adversarial subagents and surfaced two issues that warranted a new phase:

1. **PR 12.3 (`fbb543e`, "tail sweep + _traceId propagation + CI check") was incomplete.** Its body claimed `"Tail console.* sweep: 1664 -> 0 in server/"`. Reality at HEAD: **652 callsites remain** — 367 in `server/index.js`, 256 across `server/sockets/`, 29 in `server/config/`. The regression test that ships with the codebase at `server/tests/observability/no-console.test.js` only checks `services / routes / bootstrap / middleware / database`. The 652 leftover callsites all live in directories the test deliberately omits. The "1664 → 0" claim was technically true for the test's scope but not for `server/` as a whole. The CI workflow check the PR title promised was never added.

2. **`server/index.js` is 5726 lines** — slightly larger than the Phase-5 baseline (5708). Phase 9 promised ~5100 via the MediaSoup/LiveKit extraction; it landed 25% of that target. Routes, helper functions, socket-handler registration, and the shutdown sequence still live inline.

Two additional smaller findings: `ModerationNotifier` doesn't propagate `_traceId` while peers do; `ViewerCountNotifier`'s exclusion is documented only in a PR body, not in code.

The audit, the plan, and two adversarial red-team passes are all already done. Do not re-do them.

## The Phase 15 plan

**Read this in full before any work:**

```
docs/architecture/plans/phase-15.md
```

It is the canonical roadmap for Phase 15. Two workstreams (15A: observability sweep, honestly; 15B: `index.js` decomposition), 9 PRs total. The doc was red-teamed by two adversarial subagent passes; the eight findings that survived are encoded as **Locked decisions** near the top of the doc. The sequencing constraints in the doc are load-bearing — do not interleave 15A and 15B, and within 15B do not start 15B.3 (routes) before 15B.2 (helpers) closes.

Pay special attention to these locked decisions:

- **Pino structured form for the sweep**: `logger.info({ userId, action }, 'msg')`, not mechanical string-concat.
- **CHANGELOG names PR 12.3 explicitly**: "completed the sweep promised by PR 12.3 (`fbb543e`)" — not the softer framing. Acknowledge the test-scope nuance (claim was true for the test's scope, not `server/` overall) so the entry is accurate, not just punitive.
- **Helpers extract BEFORE routes** (15B.2 before 15B.3). Routes call helpers like `broadcastGlobalCooldown` at `index.js:1791,1825`; reversing the order forces a back-import phase.
- **Orchestration helpers go to a new `server/services/StreamOrchestration.js`**, not scattered across domain services. `broadcastGlobalCooldown` / `enrichStreamStatus` / `verifyAndEmitStreamReady` coordinate across ≥2 services each.
- **Middleware extraction (15B.6) is downgraded to a section-header pass**, not a full extraction. Pure `app.use(...)` wiring is wiring.
- **The "CI check" promised by PR 12.3 → expand the existing Jest test, don't add a workflow grep.** One source of truth.

### Phase 15A (your immediate scope)

Three sequential PRs, each independent in mechanics but ordering-pinned:

- **PR 15A.1 — `sockets/` sweep** — ~256 `console.*` callsites across 8 socket-handler files. Mechanical, follow PR 12.2's `const logger = require('../bootstrap/logger').child({ svc: 'StreamHandler' })` pattern. Pino structured form for multi-operand sites.
- **PR 15A.2 — `server/index.js` + `config/webrtc.config.js` sweep** — ~369 callsites in one big diff. Solo PR (will conflict with anything concurrent on `index.js`). Mark `uncaughtException` / `unhandledRejection` fallbacks with `// console-allowed: uncaughtException fallback` — this is a grep-allowlist marker, not an eslint exception (no eslint config in the repo).
- **PR 15A.3 — Expand the existing Jest test + observability tail** — edit `server/tests/observability/no-console.test.js` to add `index.js`, `sockets/`, `config/` to its directory list AND implement the `// console-allowed:` per-line skip. Same PR: add `_traceId` propagation to ModerationNotifier (4 emits at `services/ModerationNotifier.js:59,76,98,122`); add the in-file exclusion comment to `ViewerCountNotifier.js:51`. CHANGELOG honesty entry.

### After Phase 15A

Phase 15B opens. **Do not start any 15B PR until 15A.3 has merged** — once 15A.3 expands the no-console test's directory coverage, any 15B PR moving code carrying `console.*` would fail the test on land. The plan's sequencing diagram makes this explicit.

15B order: 15B.1 (inventory + closure audit) → 15B.2 (helpers, 3 sub-PRs) → 15B.3 (routes, 6–10 sub-PRs). 15B.4 (shutdown), 15B.5 (socket-handler registration), 15B.6 (middleware headers) are independent and parallel-eligible after 15B.1.

Read the full Phase 15B section of the plan before starting 15B.1.

## Constraints (still in effect from prior phases)

- CI red OK; merge with `gh pr merge <num> --squash --delete-branch --admin`.
- Single-host single-tenant; no `pm2 restart` in any PR.
- Don't touch `.bak-*` files, `.db-shm`, `.db-wal`. They show up as untracked; leave them.
- Don't write to `server/data/onestreamer.db` directly. Production DB is large.
- No new `.md` files at repo root — everything except the six canonical files goes under `/docs/`.
- Phase 15 does not anticipate new ADRs. Two surfaces *could* warrant one (`StreamOrchestration.js` if the maintainer accepts 15B.2.a's extraction; the middleware-stays decision from 15B.6) — defer the call to maintainer review at the relevant PR.
- Spawn a reviewer subagent (harsh prompt) for non-trivial PRs before merge — pattern continues from Phases 5–14. Required for: 15A.2 (large `index.js` diff), 15B.2.a (orchestration module decision), 15B.2.c (closure-audit verification), 15B.4 (shutdown ordering).
- Address reviewer findings in a follow-up commit on the SAME branch (NOT amended). This is load-bearing — amending a commit whose pre-commit hook failed loses work.
- CHANGELOG honesty bias: "byte-equivalent" is reserved for actually-byte-equivalent. Default to "behavior-preserving" and name any textual deltas.

## Workflow per PR (unchanged from prior phases)

1. Branch from main with kebab-case name (e.g. `console-sweep-sockets`).
2. Implement; `node --check`; `npx jest --config config/jest/jest.config.js <path>`.
3. Update CHANGELOG.md under `## [Unreleased]`.
4. Commit (HEREDOC body explaining WHY) → push → `gh pr create`.
5. Spawn a code-reviewer subagent (`general-purpose` subagent_type) with a harsh prompt for non-trivial PRs.
6. Address blockers + honesty issues in a follow-up commit on the branch (NOT an amend).
7. `gh pr merge <num> --squash --delete-branch --admin`.
8. `git checkout main && git pull origin main`.
9. If origin/main has moved during your work, merge it in before pushing — CHANGELOG conflicts are common.

## Tips specific to Phase 15

- **The pino convention is established.** Read `server/bootstrap/logger.js` first to confirm the child-logger shape, then read 2–3 files swept by PR 12.2 (`07a84f4`) for the established pattern. Don't reinvent the convention.

- **Pino structured form is mandatory for multi-operand sites.** `console.log('user', userId, 'did', action)` becomes `logger.info({ userId, action }, 'user did action')` — NOT `logger.info(\`user ${userId} did ${action}\`)`. The structured shape is what makes the logs queryable; that's the entire point of the sweep.

- **The `uncaughtException` exception is the ONLY exception.** Two callsites in `server/index.js` (the `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers) keep raw `console.error` because if pino itself faulted, you still want stderr output. Each gets a `// console-allowed: uncaughtException fallback` marker on the preceding line.

- **Verify your sweep was actually complete.** After PR 15A.1 lands:
  ```bash
  grep -rcE "console\.(log|error|warn|info|debug)" server/sockets/
  ```
  Every file should report 0 (or the marker-allowed count). The expanded no-console test in 15A.3 will eventually enforce this, but at the time you're writing 15A.1 the test still skips `sockets/` — verify by hand.

- **15A.2 is a solo PR.** ~370 callsite touches in one file. Will conflict with any concurrent work on `index.js`. Don't open another PR touching `index.js` during the 15A.2 window. Rebase + merge fast.

- **The closure audit in 15B.1 is the load-bearing piece for 15B.2.** Helpers in `index.js` (lines 432–1122) close over module-scope state. Some of that state is initialized eagerly (before line 432). Some is lazily initialized inside `startServer()` at ~line 4870+ — `viewbotService`, `randomStreamRotationService`, `viewBotURLService`. Helpers that close over the lazy services can't be extracted until either (a) the destination service accepts those deps as args, or (b) you move the lazy init earlier. The PR-15B.1 closure audit records which is which; 15B.2 uses that audit. Skipping the audit means 15B.2's first sub-PR ships an undefined-service bug at startup.

## Reviewer subagent prompt template (for 15A.1)

```
You are a senior reviewer giving an independent, harsh review of PR 15A.1 of the OneStreamer
autonomous refactor. Repo at /root/onestreamer. PR branch: <branch>. PR #<num>.

The claim: this PR replaces ~256 `console.*` callsites across `server/sockets/` (8 files) with
namespaced pino child loggers, following the convention established by PR 12.2 (07a84f4).
Multi-operand sites use pino structured form: `logger.info({ ctx }, 'msg')`. Behavior should
be preserved (logs still emit; only the transport + shape change).

Files in the diff: <list>

Check:
1. Are all ~256 callsites actually migrated? `grep -rcE "console\.(log|error|warn|info|debug)"
   server/sockets/` should return 0 for every file. Report any leftovers.
2. Is the structured form actually used where the original site had multiple operands? Spot-check
   5 callsites per file. A site like `console.log('user', userId, 'joined', roomId)` becoming
   `logger.info(\`user ${userId} joined ${roomId}\`)` (template literal) is a failure — should
   be `logger.info({ userId, roomId }, 'user joined room')`.
3. Did anything other than `console.* → logger.*` change? The sweep is meant to be behavior-
   preserving except for log transport. Any new conditionals, suppressed log levels, or message
   rewrites must be called out in the CHANGELOG.
4. Was the child-logger declaration shape correct? Each file should have
   `const logger = require('../bootstrap/logger').child({ svc: 'HandlerName' });` near the top.
   The `svc` binding must match the handler's role for log filterability.
5. Are tests still passing? In particular `server/tests/observability/no-console.test.js`
   (it currently doesn't check sockets/, so it'll pass either way — but no new failures elsewhere).

Report findings in three buckets: blockers / honesty issues / nits. Under 500 words. Specific.
```

## First action

```bash
cd /root/onestreamer
git status                                                       # check for uncommitted local state
git log --oneline -5                                             # confirm clean
git checkout main && git pull origin main                        # sync

# Confirm the plan + handoff exist on main:
ls docs/architecture/plans/phase-15.md docs/architecture/plans/phase-15-handoff-prompt.md

# Read the plan in full:
cat docs/architecture/plans/phase-15.md | less

# Verify the audit's numbers are still true at HEAD before starting PR 15A.1:
grep -rcE "console\.(log|error|warn|info|debug)" server/sockets/      # should ~match: 256 total
grep -cE "console\.(log|error|warn|info|debug)" server/index.js       # should ~match: 367
grep -cE "console\.(log|error|warn|info|debug)" server/config/webrtc.config.js  # should ~match: 2

# Confirm the no-console test currently exists and what it covers:
cat server/tests/observability/no-console.test.js | grep -E "server/" | head
# Should show: services routes bootstrap middleware database  (NOT index.js / sockets / config)
```

Then read `docs/architecture/plans/phase-15.md` in full. Pay attention to the **Locked decisions** section.

Then start PR 15A.1 — branch `console-sweep-sockets`, sweep all 8 files under `server/sockets/`, ship.

## When to stop

Phase 15 closes after the last 15B PR lands. The plan's "When to stop" section spells out the post-15 picture.

There is no Phase 16 in this plan. If you find yourself reaching for one (e.g., `routes/internal.js` business-logic extraction, chat-service refactor stream), stop and write a new brief for the maintainer — don't keep going without explicit re-authorization. The pattern set by `phases-6-plus.md` and `phase-15.md` is the convention.

If any 15A or 15B success criterion isn't met, that's a phase incomplete — open a follow-up PR within that same phase, don't roll into a new one. Specific watch-points:
- 15A.3 must leave `server/tests/observability/no-console.test.js` covering `index.js`, `sockets/`, `config/`. If it doesn't, the gap reopens.
- 15B.2.c must include a verification step confirming the closure audit's predictions held. If a helper extraction shipped with an undefined-service bug, that's a 15B.2 fix, not a 15B.3 problem.

Good luck. After Phase 15A closes, the codebase has zero `console.*` outside one explicit-marker exception, and the regression test gates every directory. After Phase 15B closes, `server/index.js` is a wiring file with section headers and the structural debt Phase 9 didn't address is resolved. The plan was red-teamed twice; trust the locked decisions and don't re-litigate them mid-flight.

---

## End of fresh-Claude prompt
