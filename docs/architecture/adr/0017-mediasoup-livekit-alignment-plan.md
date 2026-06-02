# ADR-0017: MediaSoup/LiveKit branch alignment plan

_Status: Superseded by [ADR-0024](0024-retire-mediasoup-livekit-only.md) — the dual-branch alignment this plan scoped is moot now that MediaSoup is retired (ADR-0024 took this ADR's Alternative D, "retire the MediaSoup branch entirely")._
_Date: 2026-05-27_
_Phase: 9 (`server/index.js` MediaSoup/LiveKit alignment + extraction)_
_PR: 9.1 (`mediasoup-livekit-divergences-archaeology`) — docs-only._
_Cross-references: [ADR-0012](0012-startserver-decomposition-partial.md) (the deferral this PR closes); [ADR-0008](0008-revive-livekit-for-url-streams-and-recording.md) (why both branches are still live)._

## Context

[ADR-0012](0012-startserver-decomposition-partial.md) flagged the ~500-line MediaSoup-vs-LiveKit `if/else` inside `server/index.js`'s `startServer()` as Phase 4's biggest acknowledged deferral:

> The MediaSoup-vs-LiveKit branch (~500 lines of mostly-but-not-quite-identical orchestration) is the biggest remaining target. Decomposing it correctly requires aligning the two branches against each other first … That's a behaviour-sensitive refactor that warrants its own ADR + reviewer.

[ADR-0008](0008-revive-livekit-for-url-streams-and-recording.md) then superseded [ADR-0002](0002-mediasoup-primary-livekit-dormant.md) and revived LiveKit. Production now runs `USE_WEBRTC_ADAPTER=true` / `WEBRTC_BACKEND=livekit` — the LiveKit branch is live. The MediaSoup branch remains as the rollback path documented in ADR-0008's "Rollback procedure" section. Both branches must keep working.

The danger captured in ADR-0012 has materialized further since it was written. Of the four feature PRs that landed in `server/index.js`'s `startServer()` in the last week — PR 3.1 (StreamNotifier chokepoint), PR 4.2 (LifecycleManager), PR-W4 (WhitelistEnforcer), PR-M3 (ModerationActionArbiter) — three (PR 4.2, PR-W4, PR-M3) added **two near-identical blocks by hand** to the two branches. The PR-M3 comments are self-aware about the duplication. Every additional feature widens the surface PR 9 must align.

The Phase 9 roadmap splits the work into three PRs:

- **PR 9.1** (this PR): divergence archaeology — read both branches line by line, classify every difference, write a recommended fix per divergence. Docs only.
- **PR 9.2**: apply the alignment fixes named in PR 9.1's recommendations. Behaviour-preserving by construction; live smoke on both backends.
- **PR 9.3**: extract the now-aligned block into a `server/bootstrap/start-streaming-backend.js` module. Same shape as the `start-listeners.js` extraction precedent from PR 4.3.

## Decision

Adopt the staged plan above. The catalog of divergences and the per-divergence classification + recommended action live in [`docs/architecture/plans/mediasoup-livekit-divergences.md`](../../archive/plans/mediasoup-livekit-divergences.md). The summary table at the bottom of that doc lists 13 divergences classified as 10 **accidental** (recommend hoist), 2 **intentional** (recommend keep branch-specific), and 1 **stale** (recommend delete).

The most consequential classification is **D2** — `viewBotURLService.setSocketIO(io)` + `setStreamNotifier(streamNotifier)` are wired in the LiveKit branch and deliberately omitted from the MediaSoup branch. The PR 3.1 post-review fix added a 9-line code comment at `server/index.js:5000–5008` explaining this is **intentional dormancy** of two emit paths in MediaSoup mode. PR 9.2's reviewer subagent pass must specifically verify that the alignment preserves that dormancy — wiring the two setters on both branches would silently activate previously-suppressed emits in MediaSoup-mode production. If a future PR concludes the emits **should** fire in MediaSoup mode, that decision is a separate behaviour-change PR, not a side-effect of PR 9.2's extraction.

## Consequences

**Positive.**

- The `if (!livekitService) { … } else { … }` shape in `startServer()` collapses from 261 lines to ~145 lines after PR 9.2, with the surviving branch body containing only the 2 deliberate-intentional asymmetries + the small set of LiveKit-only service-cross-wires.
- The PR 9.3 extraction inherits an aligned starting point — moving the block becomes mechanical rather than risky.
- Future feature PRs that touch `startServer()` add **one** block, not two.
- The `(MediaSoup backend)` log-suffix divergence (4 sites) gets stripped — the backend label belongs in structured logging (Phase 12), not in hand-tagged log text.

**Negative / trade-offs.**

- PR 9.1's archaeology is 2–3 days of wall-clock investigation per the Phase 9 brief. Spent up front; the cost is real even though no code changes.
- PR 9.2's reviewer pass must walk **both** backend smokes (per ADR-0008's rollback procedure). The maintainer has to be available to run them. This ADR explicitly accepts that the autonomous agent cannot complete PR 9.2 alone — it ships the diff and requests the smoke walk.
- One of the 13 divergences (D2 — the PR 3.1 dormancy) is **load-bearing**. Getting it wrong is a silent regression visible only to MediaSoup-mode operators. The classification doc, the in-file code comment, and the PR 9.2 reviewer prompt all repeat the warning.
- The MediaSoup branch is kept supported indefinitely as the ADR-0008 rollback path. Phase 9 does not retire it. If the MediaSoup branch is ever removed entirely, that's a future ADR superseding ADR-0008's rollback section.

## Alternatives considered

### A. Skip the archaeology, dedupe by inspection during PR 9.2

The original Phase 9 plan estimated "~50–150 LoC of changes" inside one PR. The Red-team #2 pass against the Phase 6+ roadmap (recorded in [`phases-6-plus.md`](../../archive/plans/phases-6-plus.md) §"Phase 9") caught that the alignment work is **hours of investigation per divergence**, not a single sit-down dedup. Doing the archaeology in PR 9.2 leaves the diff illegible — a reviewer can't tell "behavior preserved" from "this commit silently changed X" without the per-divergence classification published as prior art. Rejected; archaeology is its own PR.

### B. Align AND extract in a single PR

Land PR 9.2 + PR 9.3 together. Smaller PR count, but the extraction diff buries the alignment diff. Reviewer can't see the behaviour-preserving alignment apart from the location-changing extraction. Rejected; sequencing is align → extract, two PRs.

### C. Skip the alignment, extract `start-streaming-backend.js` with the `if/else` intact

Move the duplicated branches as-is into the new module. The structural duplication moves to a new file rather than being fixed — exactly the rejected outcome listed in ADR-0012's "Alternatives considered → B." Rejected.

### D. Retire the MediaSoup branch entirely, leave only the LiveKit branch

ADR-0008's rollback procedure (the `sed -i` + `pm2 restart` snippet) depends on MediaSoup-mode being functional. Removing it requires either accepting "if LiveKit fails, the platform is down until we redeploy" or building a different rollback (e.g., MediaSoup-mode flag preserved as a hot-pluggable safety net). Out of Phase 9 scope; would warrant its own ADR.

## References

- [ADR-0012: Partial decomposition of `startServer()`](0012-startserver-decomposition-partial.md) — the deferral this PR closes.
- [ADR-0008: Revive LiveKit for URL streams, recording, and transcription](0008-revive-livekit-for-url-streams-and-recording.md) — why both branches must keep working.
- [ADR-0011: LifecycleManager](0011-lifecycle-manager.md) — PR 4.2's introduction added the duplicate `lifecycleManager.schedule` calls now classified as divergence D9.
- [ADR-0009: StreamNotifier chokepoint](0009-stream-notifier-chokepoint.md) — PR 3.1 introduced the deliberate-dormancy comment that is divergence D2.
- [`docs/architecture/plans/mediasoup-livekit-divergences.md`](../../archive/plans/mediasoup-livekit-divergences.md) — full archaeology, the per-divergence classification + recommendation that PR 9.2 implements.
- [`docs/architecture/plans/phases-6-plus.md`](../../archive/plans/phases-6-plus.md) §"Phase 9" — surrounding plan, sequencing, smoke surface.
