> **Superseded by [ADR-0024](../../architecture/adr/0024-retire-mediasoup-livekit-only.md).** This document was the divergence archaeology for aligning the MediaSoup and LiveKit branches of `startServer()`. Its dual-branch premise died when MediaSoup was retired (LiveKit is now the sole backend), so the alignment work it scopes is moot. Kept for historical record. _Archived 2026-06-01._

_Last revised: 2026-05-27 against `main` at the merge tip of PR 8.4 (PR #138). Companion ADR: [ADR-0017](../adr/0017-mediasoup-livekit-alignment-plan.md). Read [`phases-6-plus.md`](phases-6-plus.md) §"Phase 9" for the surrounding plan._

# MediaSoup vs LiveKit branch — divergence archaeology

This document is the prep work for PR 9.2 of the Phase 9 refactor. It enumerates every place the two streaming-backend branches in `server/index.js`'s `startServer()` disagree, classifies each, and recommends what PR 9.2 should do with it.

PR 9.1 (this doc + [ADR-0017](../adr/0017-mediasoup-livekit-alignment-plan.md)) is docs-only. PR 9.2 applies the alignment fixes named below; PR 9.3 extracts the now-aligned block into a `server/bootstrap/start-streaming-backend.js` module.

---

## Why this exists

[ADR-0012](../adr/0012-startserver-decomposition-partial.md)'s "NOT extracted (deliberately deferred)" section warns:

> The MediaSoup-vs-LiveKit branch (~500 lines of mostly-but-not-quite- identical orchestration) is the biggest remaining target. Decomposing it correctly requires aligning the two branches against each other first (deduping the diverged paths in `URL relay`, `WhitelistEnforcer` wiring, `SimpleViewBotRotation.setLiveKitService`, etc.). That's a behaviour-sensitive refactor that warrants its own ADR + reviewer.

[ADR-0008](../adr/0008-revive-livekit-for-url-streams-and-recording.md) superseded [ADR-0002](../adr/0002-mediasoup-primary-livekit-dormant.md) and made LiveKit production-active again. Both branches are now live code, exercised in production by `USE_WEBRTC_ADAPTER=true` / `WEBRTC_BACKEND=livekit` (the LiveKit branch) and by leaving those env vars unset (the MediaSoup branch — still supported as the rollback path documented in ADR-0008's "Rollback procedure").

The danger is not that the two branches exist — both are needed. The danger is that **every new feature added since the initial commit has been duplicated into both branches by hand**, and the duplication is starting to drift. PR 3.1, PR 4.2, PR-W4, PR-M3 — every recent feature touching `startServer()` added two near-identical blocks within the if/else. Some divergences are deliberate (LiveKit-only wiring that has no MediaSoup equivalent); others are accidental (comment text drifted, schedule name made backend-specific for no reason); one is a stale log line that has lied since [PR-I4](https://github.com/onestreamer/onestreamer/pull/84) hoisted the underlying call.

---

## Branch shape today

`server/index.js` at the PR 8.4 merge tip:

| Region | Line range | Notes |
|---|---|---|
| `async function startServer()` opens | 4782 | |
| Common: mediasoup init, ViewBot factory, whitelistService, moderation pipeline | 4782 – 4992 | The factory at 4823 produces `viewBotLiveKitService` on the LiveKit branch and `null` on the MediaSoup branch. |
| `if (!livekitService) { /* MediaSoup branch */ } else { /* LiveKit branch */ }` | 4993 – 5253 | 125 + 136 = ~261 lines of branch body. |
| Common: recording + clips migrations, ViewBotClientService init, UnifiedViewBotRotation, PortMonitor, deferred rotation start | 5254 – 5457 | |
| Outer catch (mediasoup-init failure) | 5458 – 5463 | Both branches share this. |
| `async function startServer()` closes | ~5784 | |

The branch decision predicate `!livekitService` is computed at line 4818–4821:

```js
let livekitService = null;
if (usingAdapter && global.webrtcAdapter && global.webrtcAdapter.getBackendType() === 'livekit') {
  livekitService = global.webrtcAdapter._backend;
}
```

So "LiveKit branch" = `USE_WEBRTC_ADAPTER=true` AND `WEBRTC_BACKEND=livekit`. Anything else (env unset, env=mediasoup, adapter disabled) falls into the MediaSoup branch.

---

## Divergence catalog

13 divergences across 11 categories. For each: line range, classification (one of **intentional** / **accidental** / **stale**), introducing commit, recommended action for PR 9.2.

Classification key:

- **intentional**: the two branches differ because they must; the divergence has a real semantic reason (LiveKit-only wiring, or deliberate suppression).
- **accidental**: the two branches differ because someone wrote two copies by hand and they drifted (comment text, log suffix, schedule name) — but the runtime behaviour is byte-equivalent.
- **stale**: the divergence existed for a real reason that has since gone away, and nobody updated the affected site.

### D1 — URLStreamHealthService event handlers (`source-offline` + `stream-stale`)

**Sites**: MediaSoup branch 5013–5028 vs LiveKit branch 5139–5154.

**What differs**: nothing. `diff` against both blocks is empty — they are byte-identical handler bodies, byte-identical event names.

**Introducing commit**: initial commit (`500f0ea`, 2026-01-08). Both copies appeared together on day 1.

**Classification**: **accidental** (duplication; no semantic divergence).

**Recommended action (PR 9.2)**: hoist the entire `urlStreamHealthService` construction + `.on('source-offline')` + `.on('stream-stale')` block out of both branches. The handlers reference `viewBotURLService` (different instances per branch today — but PR 9.2 will hoist the `new ViewBotURLService()` construction too; see D2 below). Once construction is hoisted, the handler attachment also lifts cleanly.

---

### D2 — `viewBotURLService.setSocketIO(io)` + `setStreamNotifier(streamNotifier)`

**Sites**: LiveKit branch 5133–5134. **Not** present in MediaSoup branch (deliberately omitted, with a 9-line code comment at 5000–5008 explaining why).

**What differs**: the LiveKit branch wires `setSocketIO(io)` and `setStreamNotifier(streamNotifier)` onto the URL service. The MediaSoup branch deliberately does NOT — and the comment block explains:

> PR 3.1 (post-review fix): deliberately NOT calling viewBotURLService.setStreamNotifier on this branch. The original MediaSoup branch did not call setSocketIO(io) either, so the two emits inside ViewBotURLService._handleStreamEnd / stopURLStream were suppressed in MediaSoup mode by the `if (this.io)` guard. The new `if (this.streamNotifier)` guard preserves that suppression iff the setter is not called — wiring the notifier here would silently activate two previously-dormant emit paths in MediaSoup-mode production. Keep them dormant.

**Introducing commit**: `setStreamNotifier` at line 5134 from `c6da4701` (PR 3.1, 2026-05-26 — "feat(stream): StreamNotifier chokepoint for 17 stream-ended emits"). `setSocketIO` at line 5133 from the initial commit. The deliberate-asymmetry comment was added by PR 3.1's post-review fix.

**Classification**: **intentional**. This is the highest-leverage divergence in the file — it's the kind of thing the maintainer specifically flagged in [ADR-0012](../adr/0012-startserver-decomposition-partial.md): "the duplicated-but-not-identical control flow … has historically been a source of subtle bugs (see PR 3.1's MediaSoup-suppression footnote)."

**Recommended action (PR 9.2)**: KEEP the asymmetry. After hoisting `new ViewBotURLService()` out of the branch (see D1), put the two setter calls inside an explicit `if (livekitService) { … }` guard with the same comment preserved verbatim. Do NOT silently activate the dormant MediaSoup emit paths. If PR 9.2's reviewer or smoke pass concludes those emits should activate in MediaSoup mode, that is a **separate** behaviour-change PR with its own smoke and runbook update — not a side-effect of the extraction.

This is the divergence that turns PR 9.2 from "easy dedup" into "high-risk alignment." If we get this one wrong, MediaSoup-mode operators start seeing socket emits they have never seen before.

---

### D3 — LiveKit-only service registrations (`SimpleViewBotRotation.setLiveKitService`, `viewBotURLService.setLiveKitService`, `viewBotLiveKitService.setURLViewBotService`)

**Sites**: LiveKit branch 5124, 5131, 5164. **Not** present in MediaSoup branch (no LiveKit service to register).

**What differs**: these are LiveKit-only wires by definition.

**Introducing commit**: all three from the initial commit (`500f0ea`, 2026-01-08).

**Classification**: **intentional** (asymmetry baked in by the absence of `viewBotLiveKitService` on the MediaSoup branch).

**Recommended action (PR 9.2)**: keep branch-specific. After D1's hoist, these three calls live inside the `if (livekitService) { … }` guard that holds the rest of the LiveKit-only wiring.

---

### D4 — Stale `setStreamService` log line (`✅ VIEWBOT: Registered StreamService with SimpleViewBotRotation for real streamer protection`)

**Sites**: LiveKit branch 5126. **Not** present in MediaSoup branch.

**What differs**: the LiveKit branch logs that it just registered `SimpleViewBotRotation.setStreamService(streamService)`. But that call no longer happens here — PR-I4 (`539fa757`, 2026-05-23 — "refactor(server): migrate ViewBot stack into factory") hoisted the actual `setStreamService` call **out of both branches** to line 4856 (above the if/else), with this code comment:

```
// Branch-shared orchestration: SimpleViewBotRotation always learns about
// streamService (real-streamer protection). On the MediaSoup branch this
// was previously inside the `if (!livekitService)` block; on the LiveKit
// branch it lived in the `else`. Hoisting is behavior-preserving because
// both branches called it unconditionally.
SimpleViewBotRotation.setStreamService(streamService);
```

PR-I4 hoisted the call but did not delete the LiveKit-branch log line that announced it. The line now says "Registered X" where no recent X-registering happened.

**Introducing commit**: initial commit for the log line; PR-I4 for the hoist that orphaned it.

**Classification**: **stale**.

**Recommended action (PR 9.2)**: delete line 5126. (The hoisted call at line 4856 is silent today; if PR 9.2 wants to add a log line, hoist a single one above the if/else next to the call.)

---

### D5 — `RandomStreamRotationService` construction block

**Sites**: MediaSoup branch 5045–5052 vs LiveKit branch 5176–5183.

**What differs**: diff produces 2 lines of difference:

```
1c1
<       // Initialize Random Stream Rotation Service (MediaSoup backend)
---
>       // Initialize Random Stream Rotation Service
9c9
<       console.log('✅ RANDOM STREAM: RandomStreamRotationService initialized (MediaSoup backend)');
---
>       console.log('✅ RANDOM STREAM: RandomStreamRotationService initialized');
```

The 7 lines of actual construction + setter calls (`new RandomStreamRotationService()`, `setViewBotURLService`, `setViewBotRotation`, `setSocketIO`, `setStreamNotifier`, `setWhitelistService`, `global.randomStreamRotationService =`) are byte-identical.

**Introducing commit**: initial commit (`500f0ea`).

**Classification**: **accidental** (duplication; the `(MediaSoup backend)` log suffix is the only divergence and it's cosmetic).

**Recommended action (PR 9.2)**: hoist the whole construction block above the if/else. Drop the `(MediaSoup backend)` suffix — once construction is shared, the log line is shared too. (No information is lost: the backend name is already visible in the `MEDIASOUP: Initialization completed` log at line 4809 and in the `app.locals.mediasoupServiceType` global.)

---

### D6 — `ModerationActionArbiter` wiring block

**Sites**: MediaSoup branch 5061–5081 vs LiveKit branch 5186–5210.

**What differs**: only the comment text. The LiveKit copy has 4 extra lines of comment at the top ("PR-M3: wire the AI moderation ActionArbiter (LiveKit branch). Same contract as the MediaSoup branch above — once rotation is built …") — the comment itself is self-aware about being a duplicate. The 17 lines of actual `if (moderationService)`-guarded `new ModerationActionArbiter({ … })` + `setActionArbiter(…)` + `app.locals.moderationActionArbiter = …` are byte-identical.

**Introducing commit**: `c1f8c5fe` (PR-M3, 2026-05-27 — "feat(ai-mod): Stage 3 OpenAI cross-check + ActionArbiter"). PR-M3 added **two** `const actionArbiter = new ModerationActionArbiter(…)` blocks in a single diff — this is the most-recent example of "new feature was duplicated by hand into both branches."

**Classification**: **accidental** (duplication; no semantic divergence).

**Recommended action (PR 9.2)**: hoist the whole block above the if/else. The block reads `randomStreamRotationService` — so it must come AFTER D5's hoist. Sequencing-wise: D5 first (construct rotation), then D6 (wire arbiter to rotation).

---

### D7 — `WhitelistEnforcer` wiring block

**Sites**: MediaSoup branch 5083–5100 vs LiveKit branch 5212–5228.

**What differs**: comment text only — MediaSoup branch has 2 lines of explanatory comment, LiveKit copy has 1 line (`PR-W4: drift enforcer (LiveKit branch).`). The 13 lines of `if (whitelistService)`-guarded `new WhitelistEnforcer({ … })` + `.start()` + `app.locals.whitelistEnforcer =` + `global.whitelistEnforcer =` + `stoppables.push(…)` are byte-identical.

**Introducing commit**: `f09f78d2` (PR-W4, 2026-05-26 — "feat(url-relay): WhitelistEnforcer drift checks"). PR-W4 added **two** `new WhitelistEnforcer({…})` blocks in a single diff — the second example of recent "duplicated by hand."

**Classification**: **accidental**.

**Recommended action (PR 9.2)**: hoist. The block reads `randomStreamRotationService.twitchService` / `.kickService` — so it must come AFTER D5's hoist (rotation must exist before the enforcer is built).

---

### D8 — Random Stream API route mount

**Sites**: MediaSoup branch 5102–5105 vs LiveKit branch 5230–5233.

**What differs**: diff produces 1 line — the MediaSoup branch's log line has the `(MediaSoup backend)` suffix; the LiveKit copy doesn't. The 3 lines of actual `require('./routes/random-stream')` + `app.use('/api/random-stream', …)` are byte-identical.

**Introducing commit**: initial commit (`500f0ea`).

**Classification**: **accidental**.

**Recommended action (PR 9.2)**: hoist. Drop the `(MediaSoup backend)` suffix for the same reason as D5.

---

### D9 — `lifecycleManager.schedule(…)` autostart

**Sites**: MediaSoup branch 5111–5117 (`'random-rotation-autostart-mediasoup'`) vs LiveKit branch 5239–5245 (`'random-rotation-autostart-livekit'`).

**What differs**: diff produces 1 line — the schedule **name**. Bodies are byte-identical.

**Introducing commit**: `5ff78932` (PR 4.2, 2026-05-26 — "refactor(lifecycle): LifecycleManager for the deferred-work hazard"). PR 4.2's diff shows both `lifecycleManager.schedule('random-rotation-autostart-mediasoup', …)` and `lifecycleManager.schedule('random-rotation-autostart-livekit', …)` were added in the same commit. The backend-specific names were a hand-written distinction; only one schedule actually fires per process (the branch the code took).

**Classification**: **accidental** (the schedule name was made backend-specific for no semantic reason; nothing reads the name to discriminate, and only one branch can fire per process).

**Recommended action (PR 9.2)**: hoist. Pick a single schedule name — `'random-rotation-autostart'` (no backend suffix). The `LifecycleManager` register is process-local; the renaming is invisible outside the process.

Care to verify in PR 9.2: search `server/`, `client/`, `chat-service/`, `scripts/` for any literal reference to either of the two old names; the search should return only the schedule sites themselves. If anything else references the name, classify the divergence as **intentional** instead and keep two schedules.

---

### D10 — LiveKit-only `global.viewBotLiveKitService` + `livekitService.startStreamerHealthCheck`

**Sites**: LiveKit branch 5247–5251. Not present in MediaSoup branch.

**What differs**: LiveKit-only wiring — `global.viewBotLiveKitService = viewBotLiveKitService` (for later registration with `ViewBotRotationService`, which reads it from the global at line 5349–5351 in the common code below) and `livekitService.startStreamerHealthCheck(streamService, io, 10000)` (LiveKit's stale-streamer detector that the MediaSoup backend doesn't have an equivalent of).

**Introducing commit**: initial commit (`500f0ea`).

**Classification**: **intentional** (LiveKit-only by definition).

**Recommended action (PR 9.2)**: keep branch-specific. After PR 9.2's hoisting work, these two lines live inside the `if (livekitService) { … }` guard.

---

### D11 — `(MediaSoup backend)` log-suffix divergence (cosmetic)

**Sites**: four log lines on the MediaSoup branch (5030, 5043, 5053, 5105) carry the `(MediaSoup backend)` suffix; the four corresponding LiveKit-branch lines (5156, 5174, 5184, 5233) do not.

Already enumerated by inclusion in D5 and D8 above. Listed here as a stand-alone item for completeness — the same suffix divergence also appears on D1's `ViewBotURLService initialized` log line and D8's `API routes initialized at /api/url-stream` log line.

**Introducing commit**: initial commit.

**Classification**: **accidental** (cosmetic).

**Recommended action (PR 9.2)**: strip the suffix everywhere it's hoisted. The backend name is already in the boot log via `MEDIASOUP: Initialization completed` (line 4809) and (when applicable) `LIVEKIT: Started streamer health check` (line 5252). Anywhere a log line is genuinely branch-specific (D10's two LiveKit-only lines), the wording already makes the backend obvious.

---

### D12 — Order of operations: URL-service rotation-registration vs LiveKit cross-wire

**Sites**: MediaSoup branch 5032–5043 vs LiveKit branch 5159–5174.

**What differs**: both branches do, in order:

1. `SimpleViewBotRotation.setURLViewBotService(viewBotURLService)` (5032 / 5159).
2. **LiveKit only**: `viewBotLiveKitService.setURLViewBotService(viewBotURLService)` (5164).
3. `global.viewBotURLService = …` + `global.urlStreamHealthService = …` (5036–5038 / 5167–5169).
4. URL stream API routes mount (5040–5043 / 5171–5174).

The shared sequence is identical; the LiveKit branch has one extra step in the middle (step 2).

**Introducing commit**: initial commit.

**Classification**: **intentional** (LiveKit-only cross-wire belongs branch-specific; surrounding common steps can be hoisted).

**Recommended action (PR 9.2)**: hoist the shared steps (1, 3, 4) above the if/else; keep the LiveKit-only step (2) inside the `if (livekitService) { … }` guard. The cross-wire at step 2 requires both `viewBotLiveKitService` and `viewBotURLService` to exist, which is the case immediately after the hoisted `new ViewBotURLService()` from D1 — so the `if` block's body can just be the LiveKit-only setters from D2 + D3 + this D12 step + D10.

---

### D13 — `URL STREAM: ViewBotURLService initialized` log text

Already covered by D11 (the `(MediaSoup backend)` suffix is the only difference); listed here only because the briefing's "6+ divergences" suggested I look at every distinct log site individually. Not a separate decision point.

---

## Sequencing constraints inside PR 9.2

Several hoists have ordering dependencies. PR 9.2 must apply them in this order to keep each intermediate state correct:

1. **D1** — hoist `new ViewBotURLService()` + `setStreamService` + `setViewBotRotation` + `if (whitelistService) setWhitelistService` + `new URLStreamHealthService(…)` + `.start()` + `.on('source-offline')` + `.on('stream-stale')` + globals + routes mount. Constructs the URL service. All subsequent hoists assume it exists.
2. **D4** — delete the stale log line at 5126.
3. **D5** — hoist `new RandomStreamRotationService()` + setters + global. Reads `viewBotURLService` (which now lives above thanks to step 1).
4. **D6** — hoist `if (moderationService)` ActionArbiter block. Reads `randomStreamRotationService`.
5. **D7** — hoist `if (whitelistService)` WhitelistEnforcer block. Reads `randomStreamRotationService.twitchService` / `.kickService`.
6. **D8** — hoist `app.use('/api/random-stream', …)` + log.
7. **D9** — hoist `lifecycleManager.schedule('random-rotation-autostart', …)`. Reads `randomStreamRotationService`.
8. **D11** — strip `(MediaSoup backend)` suffix from the four log lines that are now hoisted.
9. **D12** — what remains inside the branch goes into a `if (livekitService) { … }` block (D2's setters, D3's three LiveKit-only registrations, D12's `viewBotLiveKitService.setURLViewBotService`, D10's global + healthcheck).

After PR 9.2: the if/else collapses. What used to be 261 lines of branch becomes ~130 lines of hoisted common orchestration followed by a single `if (livekitService) { … }` block of ~15 lines containing the legitimately-LiveKit-only wires + the deliberately-suppressed setters from D2.

---

## Smoke surface PR 9.2 must walk

Per the Phase 9 plan in [`phases-6-plus.md`](phases-6-plus.md) and [ADR-0008](../adr/0008-revive-livekit-for-url-streams-and-recording.md)'s rollback procedure, smoke must hit **both** backends:

1. `USE_WEBRTC_ADAPTER=true`, `WEBRTC_BACKEND=livekit` (production default since ADR-0008):
   - Streamer takes over → broadcasts.
   - URL relay (start a Twitch URL → verify viewer sees video).
   - WhitelistEnforcer tick still fires (let it idle a minute; check log).
   - ActionArbiter setActionArbiter still wires (look for the `app.locals.moderationActionArbiter` to be set; if Stage 1+2 triggers in test, verify the verdict route).
   - Random rotation autostart fires (clean start; verify the rotation begins on schedule).
2. `USE_WEBRTC_ADAPTER=false` (ADR-0008's rollback path):
   - Real streamer takes over → broadcasts via MediaSoup directly.
   - URL relay subsystem **must not** emit the previously-dormant socket events (D2 verifies this). Trigger a stop on a URL stream; tail the server log and confirm no new `stream-ended` / `stream-started` socket emits show up on the MediaSoup branch.
   - WhitelistEnforcer + ActionArbiter + autostart same as above.

The "do MediaSoup-mode emits stay dormant?" check is the headline reviewer question for PR 9.2.

---

## Open questions for PR 9.2 reviewer

1. **Should D2 stay dormant in 2026?** The PR 3.1 deliberate-suppression comment is correct as documentation of intent, but the underlying decision ("MediaSoup mode never had `setSocketIO(io)` so the emits never fired") could be revisited. If a separate PR decides those emits should fire in both modes, that's a behaviour change PR; PR 9.2 should NOT silently include it.
2. **Should the (MediaSoup backend) log suffixes be replaced by a structured tag** (`backend=mediasoup`) instead of being stripped entirely? Phase 12 (logging sweep) will retrofit pino with structured fields anyway; stripping now and letting Phase 12 add structured tags later is the cleaner sequencing. Stripping is the recommendation.
3. **Should D9's unified schedule name be `'random-rotation-autostart'` or something more descriptive?** Recommendation is the short form; the schedule name is process-local and surfaces only in `LifecycleManager` debug logs.
4. **D10's `livekitService.startStreamerHealthCheck` runs on a 10-second cadence.** It is not registered as a `stoppables`-array participant — `startStreamerHealthCheck` is presumably an internal interval that LiveKitService.stop() (already in `stoppables`) clears. PR 9.2 reviewer should verify that's actually the case, otherwise the extraction in PR 9.3 will inherit a leaked-interval hazard.

---

## Out of scope for Phase 9

- The dormant `_startMediaSoupStream` path in `ViewBotURLService.js` (called out in [ADR-0008](../adr/0008-revive-livekit-for-url-streams-and-recording.md)'s negative consequences). That's a separate `ViewBotURLService` cleanup, not a `startServer()` cleanup.
- `UnifiedViewBotRotation` (line 5380) and `PortMonitorService` (line 5412) — these run **after** the if/else in the common code at lines 5254–5457; they read `mediasoupService` + `livekitService` directly and don't diverge by branch. Phase 11 (ViewBotClientService decomposition) is the right home for any further restructuring here.
- Recording / clips migrations at 5258–5278 — common code, not branch-specific.

---

## What PR 9.3 inherits from PR 9.2

After PR 9.2 lands, the post-hoist shape of `startServer()` lines 4993–5253 will be approximately:

```js
// — common orchestration —
const viewBotURLService = new ViewBotURLService();
viewBotURLService.setStreamService(streamService);
viewBotURLService.setViewBotRotation(SimpleViewBotRotation);
if (whitelistService) viewBotURLService.setWhitelistService(whitelistService);
const urlStreamHealthService = new URLStreamHealthService(viewBotURLService);
urlStreamHealthService.start();
urlStreamHealthService.on('source-offline', /* … */);
urlStreamHealthService.on('stream-stale',   /* … */);
SimpleViewBotRotation.setURLViewBotService(viewBotURLService);
global.viewBotURLService = viewBotURLService;
global.urlStreamHealthService = urlStreamHealthService;
app.use('/api/url-stream', urlStreamRoutes(viewBotURLService, urlStreamHealthService));
console.log('✅ URL STREAM: ViewBotURLService initialized');

const randomStreamRotationService = new RandomStreamRotationService();
randomStreamRotationService.setViewBotURLService(viewBotURLService);
randomStreamRotationService.setViewBotRotation(SimpleViewBotRotation);
randomStreamRotationService.setSocketIO(io);
randomStreamRotationService.setStreamNotifier(streamNotifier);
if (whitelistService) randomStreamRotationService.setWhitelistService(whitelistService);
global.randomStreamRotationService = randomStreamRotationService;
console.log('✅ RANDOM STREAM: RandomStreamRotationService initialized');

if (moderationService) { /* ActionArbiter wiring */ }
if (whitelistService)  { /* WhitelistEnforcer wiring */ }

app.use('/api/random-stream', randomStreamRoutes(randomStreamRotationService));
lifecycleManager.schedule('random-rotation-autostart', /* … */);

if (livekitService) {
  // — deliberately LiveKit-only —
  SimpleViewBotRotation.setLiveKitService(viewBotLiveKitService);
  viewBotURLService.setLiveKitService(viewBotLiveKitService);
  viewBotURLService.setSocketIO(io);                    // see PR 3.1 suppression note
  viewBotURLService.setStreamNotifier(streamNotifier);  // see PR 3.1 suppression note
  viewBotLiveKitService.setURLViewBotService(viewBotURLService);
  global.viewBotLiveKitService = viewBotLiveKitService;
  livekitService.startStreamerHealthCheck(streamService, io, 10000);
}
```

PR 9.3 then takes that block (~130 + ~15 = ~145 lines) plus the surrounding factory call at 4823 + livekitService derivation at 4818 + stoppables push at 4837–4840 and extracts the whole bootstrap-side concern into `server/bootstrap/start-streaming-backend.js`, returning the constructed services and stoppables additions through a deps bag — same shape as [`server/bootstrap/start-listeners.js`](../../../server/bootstrap/start-listeners.js) (PR 4.3) extraction precedent.

---

## Summary

| # | Site | Classification | Action |
|---|---|---|---|
| D1 | URLStreamHealthService.on handlers | accidental | hoist |
| D2 | `viewBotURLService.setSocketIO` + `setStreamNotifier` | **intentional** (PR 3.1 suppression) | keep branch-specific |
| D3 | LiveKit-only service registrations × 3 | intentional | keep branch-specific |
| D4 | Stale `setStreamService` log line | **stale** | delete |
| D5 | `RandomStreamRotationService` construction | accidental | hoist |
| D6 | `ModerationActionArbiter` wiring | accidental | hoist |
| D7 | `WhitelistEnforcer` wiring | accidental | hoist |
| D8 | Random Stream API route mount | accidental | hoist |
| D9 | `lifecycleManager.schedule` autostart | accidental | hoist + unify name |
| D10 | LiveKit-only `global` + `startStreamerHealthCheck` | intentional | keep branch-specific |
| D11 | `(MediaSoup backend)` log suffix | accidental | strip on hoist |
| D12 | URL-service rotation-registration order | intentional (1 LiveKit-only step) | hoist shared, keep cross-wire branch-specific |
| D13 | URL stream init log text | accidental | covered by D11 |

Net: 10 hoists + 1 deletion + 2 deliberate asymmetries preserved.
