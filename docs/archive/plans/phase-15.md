> [!NOTE]
> **COMPLETED — historical.** This roadmap/handoff/inventory has been executed and is preserved for the record only; it is **not maintained** and its file/line references reflect the tree at the time it was written (pre-ADR-0024). _Archived 2026-06-01._

## Phase 15 refactor roadmap

_Last revised: 2026-05-27 against `main` at commit `34a0354` (PR 14.1 merged, Phase 14 closed)._
_Red-teamed: two adversarial subagent passes (scope/over-engineering + execution/risk) before publication. Eight findings incorporated below — most consequential were (a) `server/tests/observability/no-console.test.js` already exists and is the right enforcement seam, (b) helpers must extract before routes due to a hidden dependency pin, (c) several "helpers" are orchestration code and should land in a dedicated module rather than scattered across domain services._
_Origin: this brief was triggered per the `phases-6-plus.md` "When to stop" clause, which says a Phase 15 requires a new brief for the maintainer to review. It exists because a post-Phase-14 audit surfaced (a) a load-bearing PR 12.3 claim that turned out to be false and (b) the residual `server/index.js` bulk that Phase 9 did not address._

This is a smaller-scope plan than Phase 6+ — two workstreams, nine PRs total, no new domain features. Workstream A finishes work that was claimed-but-not-done in Phase 12. Workstream B picks up where Phase 9 stopped on `server/index.js`. Strict ordering: A closes before B starts.

---

## Where we are at end-of-Phase-14

- **`server/index.js`**: 5726 lines. Phase 9 promised ~5100; it landed at 5726 (+18 net from the Phase-5 baseline). PR 9.3 extracted ~270 lines into `bootstrap/start-streaming-backend.js`; PR 9.2 added ~130 alignment lines back; subsequent VisionBot / OmniImageMod feature PRs added ~100 more directly into `index.js` instead of dedicated route modules. The headline maintainer pain ("huge orchestrator") is largely untouched.
- **Observability sweep is incomplete — but with nuance.** PR 12.3 (`fbb543e`, "tail sweep + _traceId propagation + CI check") claims in its body: _"Tail console.* sweep: 1664 -> 0 in server/."_ Audit at HEAD: **652 callsites remain** (367 in `server/index.js`, 256 across `server/sockets/`, 29 in `server/config/`). The "+ CI check" promised in the same PR title was never added as a workflow step — **however**, a Jest test at `server/tests/observability/no-console.test.js` was shipped as the enforcement mechanism. That test only checks `server/services`, `server/routes`, `server/bootstrap`, `server/middleware`, `server/database`. The 652 callsites all live in directories the test deliberately omits. The "1664 → 0" claim was technically true for the test's scope but not for `server/` as a whole.
- **Trace-ID propagation is 2-of-4.** `BuffNotifier` and `StreamNotifier` carry `_traceId`. `ViewerCountNotifier` intentionally cannot (bare-integer payload). `ModerationNotifier` silently does not, with no exclusion comment.
- **Repositories complete (14/14)**, schema migrations layout shipped, money flow atomic, ViewBotClientService split (6015 → 2300). Phases 6, 7, 8, 10, 11, 13, 14 closed substantively. Phase 9 hit ~25% of its numeric target; Phase 12 closed nominally but with the gap above.

Phase 15 is recovery + completion, not new scope.

---

## What this plan does NOT cover

- **`server/services/viewbot/ViewBotInstance.js`** (3752 lines post-Phase-11). It has clean internal seams (FFmpeg arg builders, child-process spawner, hard-coded SSRC constants) but the audit confirmed structural ownership is correct. Extracting it further is a Phase 11 follow-up if it ever becomes one — not Phase 15.
- **`chat-service/`**. Separate process, separate lifecycle. Phase 15 keeps the server-core-only scope of Phases 6–14. If the chat-service ever needs its own refactor stream, it gets its own brief.
- **`server/routes/internal.js` business-logic extraction.** Phase 10 ran out of runway before reaching it; it's a natural Phase 16 candidate but is not Phase 15 scope. Phase 15 is sweep + `index.js` decomp only.
- **New CI infrastructure beyond the one existing Jest test.** The red-team pass surfaced that this test already exists and is the right enforcement seam; Phase 15A expands its scope rather than adding a parallel workflow grep. Lint rules, metrics endpoints, codegen — all flagged in the audit but all out of scope here.
- **LoC targets.** The maintainer's explicit constraint. Success is structural: a reader landing on `index.js` cold can see the whole startup sequence in one screen, and every section of business logic lives in a clearly-named module they can navigate to. PR sizes appear below as work-shape estimates, not targets.

---

## Themes

| Theme | What it means | Phases that lean here |
|-------|---------------|----------------------|
| **Honesty fix** | Close the gap between what PR 12.3 said it did and what's true at HEAD. Expand the existing Jest gate to cover the directories it currently omits. | 15A |
| **Refactor & modularity** | Finish the `server/index.js` decomposition that Phase 9 only sampled. Routes to `server/routes/`, lifecycle to `server/bootstrap/`, orchestration helpers to a dedicated module, domain helpers to their domain services. | 15B |

---

## Locked decisions (encoded during planning)

1. **Pino structured form** (`logger.info({ userId, action }, 'user did action')`) is the sweep convention, not mechanical string-concat. Structured form is what makes the logs queryable; that's the point.
2. **CHANGELOG honesty fix names PR 12.3 explicitly.** Phrasing in PR 15A.3 below. Not the softer "completed the sweep started in PR 12.3" framing.
3. **15B.1 archaeology is fast triage** (couple hours), not Phase-9.1-depth (multi-day).
4. **"Microservices" means modular boundaries within the same process.** chat-service stays out of scope.
5. **Orchestration helpers go to a dedicated module, not scattered across domain services.** `broadcastGlobalCooldown`, `enrichStreamStatus`, `verifyAndEmitStreamReady` land in a new `server/services/StreamOrchestration.js` (or stay in `index.js` if the maintainer prefers — see PR 15B.2 for the explicit choice point). Other helpers go to their domain service.
6. **Helpers extract before routes**, not after. Routes today call helpers (e.g., `broadcastGlobalCooldown` at `index.js:1791,1825`); reversing the order would force a back-import phase.
7. **Middleware extraction is the lowest-leverage move and downgrades to a section-header pass**, not a full extraction. Pure `app.use(...)` wiring belongs in `index.js`; what was missing was navigability, which headers fix.

---

## Phase 15A — Observability sweep, honestly

**Theme**: Honesty fix. **Risk**: LOW–MEDIUM (one large mechanical diff). **Cadence**: 3 PRs.

Replaces 652 `console.*` callsites with the namespaced pino pattern PR 12.2 established. Expands the existing Jest gate to cover the directories the sweep just cleaned. Closes the trace-ID propagation tail.

### PR 15A.1 — `sockets/` sweep

Sweep the eight files under `server/sockets/` (~256 callsites total: `StreamHandler` 103, `ViewBotHandler` 83, `MediaSoupHandler` 41, `DisconnectHandler` 19, `GameHandler` 16, `BuffHandler` 9, `EffectHandler` 8, `AdminHandler` 5).

Convention: copy PR 12.2's pattern.

```js
const logger = require('../bootstrap/logger').child({ svc: 'StreamHandler' });
```

Replace `console.log` → `logger.info`, `console.error` → `logger.error`, `console.warn` → `logger.warn`. **Use pino structured form for sites with multiple operands**: `console.log('user', userId, 'did', action)` becomes `logger.info({ userId, action }, 'user did action')`. Don't mechanically string-concat into a template literal — the structured form is what makes the logs queryable, and that's the point of the sweep.

- Size: ~256 callsite touches across 8 files; aggregate diff ~600 LoC.
- Risk: **LOW.** Independent file unit; no cross-file coordination.

### PR 15A.2 — `server/index.js` + `config/webrtc.config.js` sweep

Sweep the 369 remaining callsites (367 in `index.js`, 2 in `webrtc.config.js`). Same pattern as 15A.1.

**Deliberate exception**: the `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers retain raw `console.error` as a fallback. If pino itself faulted, we still want stderr output. Mark each with a literal allowlist comment:

```js
// console-allowed: uncaughtException fallback
console.error('Uncaught exception', err);
```

The `// console-allowed:` prefix is a grep-only marker, not an eslint exception (there is no eslint config in the repo). The Jest test in 15A.3 will skip any line carrying this comment on the immediately-preceding line.

- Size: ~370 callsite touches in one file; aggregate diff ~700 LoC.
- Risk: **MEDIUM** — large single-file diff against `server/index.js`. Will conflict with any concurrent work on that file. Schedule as a solo PR, rebase + merge fast.
- Cross-PR pin: this PR creates the merge-conflict surface that motivates A-before-B ordering.

### PR 15A.3 — Expand the existing test + observability tail

Three concerns, one PR (all are short and thematically linked):

1. **Expand `server/tests/observability/no-console.test.js`**: add `server/index.js`, `server/sockets`, `server/config` to the directory list at line 33–34 of the test. Update the `ALLOWED` set with a one-line comment documenting the `// console-allowed:` marker convention. Implement the marker as a per-line filter (test reads the file, drops any matched line whose previous line contains `console-allowed:`). This is a few lines of Node — no shell pipeline, runs in Jest like the existing test.

   Why this and not a new `.github/workflows/ci.yml` grep: the enforcement seam already exists. Adding a parallel workflow check creates two sources of truth (one runs in CI step, one runs in Jest), one of which will silently drift. Expanding the existing test keeps a single gate.

2. **`ModerationNotifier._traceId`**: add `_traceId` propagation via the same conditional-spread pattern as `BuffNotifier.js:67` and `StreamNotifier.js:93` to all four emit sites (`ModerationNotifier.js:59,76,98,122`). Note: line 98's payload is structurally different from its peers — it spreads fields directly (`event_id, transcript_excerpt, categories, appeal_url`) rather than wrapping in `{ event }`. Adding `_traceId` is still a safe key-addition, but call this out in the PR description so a reviewer doesn't assume payload uniformity.

3. **`ViewerCountNotifier` exclusion comment**: add an in-file comment at `ViewerCountNotifier.js:51` documenting that `_traceId` is deliberately omitted because the payload is a bare integer. The exclusion is currently only documented in the PR 12.3 commit body, which is invisible to anyone reading the code.

- Size: ~40 LoC test changes + ~15 LoC notifier changes + ~3 LoC comment + CHANGELOG entry.
- Risk: **LOW.**

**CHANGELOG honesty** (per decision locked in this plan): the entry names PR 12.3 explicitly. Phrasing template:

> Completed the `console.*` → pino sweep promised by PR 12.3 (`fbb543e`). The original PR claimed "1664 → 0 in server/" but left 652 callsites at HEAD (367 in `server/index.js`, 256 in `server/sockets/`, 29 in `server/config/` — all in directories the regression test deliberately omitted). Phase 15A swept the remainder and expanded the existing `server/tests/observability/no-console.test.js` gate to cover the directories it had previously skipped, so the gap can't reopen.

### Phase 15A success criteria

- `server/tests/observability/no-console.test.js` covers `server/` end-to-end (services, routes, bootstrap, middleware, database, **index.js, sockets, config**) and passes.
- All four production notifiers carry `_traceId` OR have an in-file comment explaining why not.
- CHANGELOG entry truthfully describes the gap that existed and what closed it.

---

## Phase 15B — `server/index.js` decomposition

**Theme**: Refactor & modularity. **Risk**: LOW–MEDIUM per PR. **Cadence**: 6 PRs (one archaeology + five execution).

Phase 9 extracted the MediaSoup/LiveKit branch (~270 LoC) and stopped. The remaining bulk of `index.js` falls into clearly-different categories — route handlers, socket-handler registration, shutdown sequence, helper functions — each of which has a natural home that already exists in the directory layout (or, for orchestration helpers, gets a new dedicated module). Middleware setup stays in `index.js` with section headers because pure `app.use(...)` wiring is wiring.

**Explicit non-goal**: no LoC target. Success is structural — described per-PR via what the destination module owns, not via line counts in `index.js`.

### PR 15B.1 — Inventory + closure audit (read-only, fast triage)

The 143 inline route handlers in `index.js` lines 1123–4598, and the helper-functions block at lines 432–1122, both need an upfront read before extraction starts.

**Two deliverables, both lightweight:**

1. **A comment block at the top of `server/index.js`** that maps handler line ranges to their target files. Example:

   ```js
   // ============================================================================
   // Route inventory (Phase 15B). Handler line ranges → target files.
   //
   //   1180–1495   emoji CRUD                → routes/emojis.js          (15B.3.a)
   //   1698–1961   ViewBot HTTP admin bridge → routes/viewbot-admin.js   (15B.3.b)
   //   3640–3700   VisionBot admin           → routes/visionbot-admin.js (15B.3.c)
   //   ...
   // ============================================================================
   ```

   Each `15B.3.X` sub-PR removes its line from this block as it lands. By the end of 15B.3, the block is either empty (delete it) or holds residuals with explanations.

2. **A closure audit for helpers at lines 432–1122**, recorded in the PR description (not a separate `.md`). For each of the ~10 helpers, list: what module-scope state it closes over (`io`, `takeoverService`, `viewbotService`, etc.), whether that state is initialized eagerly (before line 432) or lazily inside `startServer()` (~line 4870+), and what its destination is in 15B.2.

   The closure audit is the load-bearing piece: helpers that close over lazily-initialized services (`viewbotService`, `randomStreamRotationService`, `viewBotURLService`) need their destination module to accept those services as args, or the helper's move waits until after the service is initialized.

- Size: ~40 LoC comment block in `index.js` + ~200-word section in PR description.
- Risk: **LOW** (read-only code change; the comment block has no runtime effect).
- No ADR.

### PR 15B.2 — Orchestration helpers + domain helpers extraction

Lines 432–1122 (~690 LoC). Helpers extract BEFORE routes because routes call them (e.g., `broadcastGlobalCooldown` is called from `index.js:1791,1825`). Reversing the order forces a back-import phase.

**Split by destination, ~3 sub-PRs:**

**15B.2.a — New `server/services/StreamOrchestration.js`** for the cross-service orchestration helpers:
- `broadcastGlobalCooldown` (closes over `takeoverService`, `io`)
- `enrichStreamStatus` (reads from StreamService + ViewBotClientService + TimeTrackingService)
- `verifyAndEmitStreamReady` (calls notifiers + persists state)

   These three helpers coordinate across ≥2 services each. Forcing them into a single domain service creates cross-imports between domain services that today don't know about each other. A dedicated orchestration module owns the cross-cutting glue.

   **Choice point for the maintainer**: an alternative is to keep these three helpers in `index.js` with a `// === ORCHESTRATION HELPERS ===` section header, on the argument that `index.js` legitimately owns wiring-glue. The plan defaults to extraction (per the modularity goal). Flag this in the PR description; defer to the maintainer's call at review time.

**15B.2.b — Domain helpers to their domain services:**
- `initializeRedis` → consolidate into `bootstrap/redis.js`.
- `getStreamerDisplayName` → `UserService` (or `UserRepository` if the body is a pure lookup).
- `getActiveVisualEffects` → `VisualFxService`.
- Any other helpers the closure audit surfaces.

**15B.2.c — Cleanup pass**: update `index.js` callsites to use the new locations; delete the original helper definitions; verify the closure audit's predictions held.

- Size: each sub-PR ~150–300 LoC. Risk: **MEDIUM** per sub-PR — closure-over-lazy-service is the hazard the audit flagged.
- Reviewer subagent pass on 15B.2.a (orchestration module decision) and 15B.2.c (callsite cleanup).

### PR 15B.3 — Extract independent route clusters

Routes at lines 1123–4598. One PR per cluster from the 15B.1 inventory, ordered by independence (extract clusters with the fewest cross-references first). Each PR:

- Creates `server/routes/<cluster>.js` following the convention in CLAUDE.md ("Sharing services across route modules").
- Mounts via `app.use('/api/...', require('./routes/<cluster>'))` in `index.js`.
- Stateful service deps come from `req.app.locals.<serviceName>` with the JSON-500 short-circuit pattern from `server/routes/audio.js`.
- Removes its line from the 15B.1 inventory comment block.
- One CHANGELOG entry per PR naming the cluster.

Numbered 15B.3.a, 15B.3.b, … as clusters extract. Expected count: 6–10 sub-PRs. Each is 100–300 LoC moved.

- Risk per sub-PR: **LOW–MEDIUM** — mechanical move, but the streaming/auth smoke walkthrough from `docs/getting-started/first-stream.md` runs after each one.
- Parallel-eligible across separate branches once 15B.2 lands (the helper deps are resolved), as long as each PR rebases before merge.

### PR 15B.4 — Shutdown sequence to `bootstrap/shutdown.js`

Lines 5452–5726 (~270 LoC): `shutdown()`, SIGINT / SIGTERM / `uncaughtException` / `unhandledRejection` handlers, cleanup helpers. Natural seam — pure lifecycle code with no business logic.

- New module exports `registerShutdownHandlers({ services, server, io, logger })`.
- `index.js` calls it once after the HTTPS server is listening.
- The `uncaughtException`-fallback `console.error` from PR 15A.2 lives here, with its `// console-allowed: uncaughtException fallback` marker.
- Risk: **MEDIUM** — shutdown ordering matters (LifecycleManager.stop() before sockets close before http server closes). New tests must cover the ordering invariant.
- Independent of 15B.2 and 15B.3; parallel-eligible.

### PR 15B.5 — Socket-handler registration to `bootstrap/register-socket-handlers.js`

Lines 4600–4863 (~264 LoC — verified against HEAD; the original audit estimate of ~160 LoC was wrong because the closing `});` is at 4863, not 4759). The `io.on('connection', ...)` block that auths, IP-bans, session-registers, and attaches every per-namespace `register*Handler(io, socket, …)` call.

Mirrors the `start-listeners.js` shape from PR 4.3.

- Risk: **LOW–MEDIUM** — touches every socket event but the registration code itself is mechanical. The 60%-larger-than-originally-thought volume doesn't change feasibility, just scope expectations.
- Independent of 15B.2, 15B.3, 15B.4; parallel-eligible.

### PR 15B.6 — Middleware section-header pass (NOT a full extraction)

Lines 188–374 (~186 LoC): compression, CORS, trace-context wiring, auth wiring, session, static-route registration.

**Downgraded from a full extraction to a section-header pass** based on red-team finding. Pure `app.use(...)` wiring is wiring; extracting it into `bootstrap/middleware.js` would force `index.js` to import a module to call `applyMiddleware(app, ...)` instead of seeing the middleware chain in plain Express idiom. The cognitive win is small (the middleware block is already visually coherent) and the ordering risk during extraction is real (middleware order is load-bearing).

Instead, add three section headers in `index.js`:

```js
// =========================================================================
// MIDDLEWARE SETUP — order matters; see ADR-0020 for trace-context placement
// =========================================================================
```

Around the middleware block, the routes-mount block, and the server-init block. This achieves the "navigable in one screen" success criterion at near-zero cost.

If a future phase needs middleware to be testable in isolation or reusable across multiple servers, revisit then. Today, neither is true.

- Size: ~15 LoC of comment blocks in `index.js`.
- Risk: **LOW.**

### Phase 15B success criteria (structural, not numerical)

- A reader landing on `server/index.js` cold can see the whole startup sequence (requires → middleware → routes → server → sockets → shutdown) in one screen, navigable via section headers.
- Every category of business-logic-bearing work (routes, orchestration helpers, domain helpers, socket setup, shutdown) lives in a clearly-named module under `server/routes/` or `server/bootstrap/` or its domain service.
- The PR-15B.1 inventory comment block is either empty (deleted) or holds explicitly-justified residuals.
- Full streaming smoke (`docs/getting-started/first-stream.md`) passes after each extraction PR.

The final PR in the 15B sequence (typically the last route cluster or 15B.5, whichever lands last) carries a description section titled "Phase 15B residual" listing what remains in `index.js` and why. No separate checkpoint PR.

---

## Sequencing constraints

Strict ordering:

```
15A.1 ──▶ 15A.2 ──▶ 15A.3   ║   15B.1 ──▶ 15B.2 ──▶ 15B.3
                                       └────▶ 15B.4 (parallel)
                                       └────▶ 15B.5 (parallel)
                                       └────▶ 15B.6 (parallel)
```

- **All of 15A closes before 15B opens.** Reason: once 15A.3 expands the `no-console.test.js` directory list to include `server/index.js` and `server/sockets/`, any 15B PR that moves code carrying `console.*` would fail the test on land. A-first removes that hazard. Additionally, 15A.2 is a 370-callsite single-file diff against `index.js`; any concurrent 15B PR touching `index.js` would collide.
- **Within 15A: 15A.1 before 15A.2 before 15A.3.** 15A.3 expands the test's coverage; if 15A.1/15A.2 hadn't already cleaned the new directories, the expanded test would fail on land.
- **Within 15B: 15B.1 archaeology before everything else** (provides the inventory + closure audit).
- **15B.2 (helpers) before 15B.3 (routes).** Hidden dependency pin: routes call helpers (e.g., `broadcastGlobalCooldown` at `index.js:1791,1825`). If routes extract first, the extracted route files import the helper from `index.js`; when 15B.2 moves the helper, every route file rewrites its import. Order matters.
- **15B.4 (shutdown), 15B.5 (socket-reg), 15B.6 (middleware headers) are independent** of 15B.2 and 15B.3 and of each other. All three are parallel-eligible after 15B.1 lands.

---

## Cross-cutting concerns

### CHANGELOG honesty (carries over from Phase 6+)

PR 15A.3's entry names PR 12.3 explicitly. Phrasing locked at planning time: "Completed the `console.*` → pino sweep promised by PR 12.3 (`fbb543e`). The original PR claimed '1664 → 0 in server/' but left 652 callsites at HEAD…" Don't soften to "completed the sweep started in PR 12.3." Acknowledge the test-scope nuance (the prior PR's claim was true for the test's scope but not for `server/` as a whole) so the framing is accurate, not just punitive.

### ADR discipline

Phase 15 does not anticipate new ADRs. Each PR's structural decisions are mechanical (sweep, extract) and reference existing ADRs:
- 15A.1, 15A.2 reference ADR-0020 (namespaced logging with pino).
- 15B.1–5 reference ADR-0012 (startServer decomposition, partial) and effectively close out the "partial" qualifier.

Two surfaces *could* warrant an ADR but the plan defers the call:
- **`server/services/StreamOrchestration.js` (new module from 15B.2.a).** If the maintainer accepts the extraction at review time, an ADR-0023 documenting "cross-service orchestration belongs in a dedicated module, not scattered across domain services" lands with that PR. If the maintainer prefers leaving the helpers in `index.js` with section headers, no ADR is needed.
- **Middleware-stays-in-index.js (15B.6 downgrade).** Worth a one-line note in `phases-6-plus.md` if the maintainer wants it on the record; not worth a full ADR.

### Reviewer subagent discipline

Every non-trivial PR spawns a `general-purpose` reviewer subagent before merge: PRs 15A.2 (large `index.js` diff), 15B.2.a (orchestration module decision), 15B.2.c (closure-audit verification), 15B.4 (shutdown ordering). Honesty fixes land in a follow-up commit on the same branch — NOT amended.

### Live smoke before close

- Phase 15A: after 15A.2, run `npm test` and confirm logger output to stdout (eyes-on, since the file is touched at 370 sites). After 15A.3, deliberately reintroduce a `console.log` in `server/sockets/StreamHandler.js`, confirm Jest fails, then revert.
- Phase 15B: full streaming walk (`docs/getting-started/first-stream.md`) after each extraction PR. The shutdown PR (15B.4) additionally needs a manual SIGTERM test (start server → SIGTERM → confirm clean exit + no orphan processes). The orchestration-helper PR (15B.2.a) needs the buff-purchase smoke (because `broadcastGlobalCooldown` runs during purchase).

---

## Phase risk summary

```
Phase 15A ─┬── PR 15A.1  sockets/ sweep                       [LOW]     ▓
           ├── PR 15A.2  index.js + config sweep              [MED]     ▓▓
           └── PR 15A.3  Expand Jest gate + notifier tail     [LOW]     ▓

Phase 15B ─┬── PR 15B.1  Inventory + closure audit            [LOW]     ▓
           ├── PR 15B.2.a Orchestration helpers (new module)  [MED]     ▓▓
           ├── PR 15B.2.b Domain helpers to services          [MED]     ▓▓
           ├── PR 15B.2.c Callsite cleanup + verification     [LOW-MED] ▓
           ├── PR 15B.3.a–N  Route cluster extractions        [LOW-MED] ▓▓
           ├── PR 15B.4  Shutdown to bootstrap/               [MED]     ▓▓
           ├── PR 15B.5  Socket registration to bootstrap/    [LOW-MED] ▓
           └── PR 15B.6  Middleware section headers           [LOW]     ▓
```

---

## When to stop

After 15B closes (the final route cluster or last parallel PR lands), Phase 15 closes. The post-15 picture:

- `console.*` is gone from `server/` (Jest-enforced via the expanded `no-console.test.js`).
- `_traceId` propagates or is explicitly excluded with an in-file comment in every notifier.
- `server/index.js` is a wiring file with section headers; routes, orchestration helpers, socket setup, and shutdown live in their natural homes.
- The Phase-9 "partial" qualifier on ADR-0012 is genuinely closable.

**Review trigger** (not a Phase 16): if the final 15B residual reveals that `startServer()` still contains business logic that should have been extracted, that's a Phase 15B follow-up, not a new phase. The phase number only increments for genuinely-new scope (e.g., the `routes/internal.js` business-logic extraction the audit flagged, or a chat-service refactor stream).

If a Phase 15 Claude instance finds itself reaching for a Phase 16, it should stop and write a new brief for the maintainer to review. The pattern set by `phases-6-plus.md` is the convention.
