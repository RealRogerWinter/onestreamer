# ADR-0024: Retire MediaSoup; LiveKit is the sole WebRTC backend

_Status: accepted_
_Date: 2026-06-01_
_Supersedes: the "Rollback procedure" + MediaSoup-as-fallback framing of [ADR-0008](0008-revive-livekit-for-url-streams-and-recording.md), and [ADR-0017](0017-mediasoup-livekit-alignment-plan.md)'s "the MediaSoup branch is kept supported indefinitely" clause — ADR-0017's Alternative D ("retire the MediaSoup branch entirely") is the path now taken._
_Cross-references: [ADR-0002](0002-mediasoup-primary-livekit-dormant.md) (MediaSoup-primary, already superseded by 0008); [ADR-0003](0003-livekit-dual-stack-rollback.md) (the Sept-2025 dual-stack rollback whose un-root-caused failure is why a fallback was kept)._

## Context

Since [ADR-0008](0008-revive-livekit-for-url-streams-and-recording.md) (2026-05-26) production has run `USE_WEBRTC_ADAPTER=true` / `WEBRTC_BACKEND=livekit`. LiveKit is the **sole live backend**: the primary streamer→viewer path, URL-stream relay (`livekit-ingress`), recording (`livekit-egress`), and transcription all run on it. MediaSoup has not served a production stream since the flip — in fact, with `WEBRTC_BACKEND=livekit` the `WebRTCAdapterV2` Proxy constructs *only* a `LiveKitService`, so no MediaSoup worker even starts. Its only remaining roles are the env-flip rollback documented in ADR-0008 and the `if (!livekitService)` branch that [ADR-0017](0017-mediasoup-livekit-alignment-plan.md) labours to keep aligned.

Keeping a fully-parallel, never-exercised second SFU stack costs:

- **~5,100 LoC of MediaSoup-only files** — `MediasoupService.js` (813), `MediaSoupHandler.js` (507), `routes/mediasoup.js` (195), `services/mediasoup/*` (223), `MediasoupPlainTransportService.js` (402), `RecordingService.js` (425, the ffmpeg/HLS recorder), `ViewBotWebRTCService.js` (607), `WebRTCAdapterV2.js` (84), client `MediasoupClient.ts` (1,861) — plus mediasoup-mode branches threaded through shared files (`TranscriptionAudioAdapter`, `ViewbotService`, `DisconnectHandler`, client `WebRTCClientAdapter`), plus the `mediasoup` and `@roamhq/wrtc` native dependencies.
- **The ADR-0017 alignment tax** — every feature touching `startServer()` must be written into *both* branches and kept aligned, including the load-bearing PR-3.1 "deliberate dormancy" fences (divergence D2) that are a standing silent-regression risk in MediaSoup mode.
- **Dual-stack cognitive overhead** for everyone reading the streaming code.

The maintainer has decided that cost outweighs the benefit of an in-process fallback that has never been exercised and whose value is itself uncertain: the fallback exists because [ADR-0003](0003-livekit-dual-stack-rollback.md)'s Sept-2025 LiveKit WebSocket failure was never root-caused — so we do not actually know the env-flip would have rescued that outage.

## Decision

**Remove MediaSoup entirely. LiveKit is the only WebRTC backend.** Delete the MediaSoup services, socket handler, routes, and client; delete the `WebRTCAdapterV2` switch and construct `LiveKitService` directly; remove the mediasoup-mode branches from shared services; drop the `mediasoup` and `@roamhq/wrtc` dependencies; collapse the dual `startServer()` branch to the LiveKit path. The `WEBRTC_BACKEND` / `USE_WEBRTC_ADAPTER` env knobs are retired — LiveKit is unconditional.

ADR-0008's env-flip rollback is **replaced** by the redeploy-based recovery below. The change ships as a sequenced PR stream — ADR → client de-dupe → server signaling → adapter collapse → branch pipelines → core + deps → doc convergence — each step behaviour-preserving for the live LiveKit path and independently revertable.

## Consequences

**Positive.**
- ~6,000+ LoC and two native dependencies removed; one streaming stack to reason about.
- The ADR-0017 alignment work is mooted — no more double-writing `startServer()` features; the D2 dormancy fences disappear.
- Smaller attack surface and faster builds (no `mediasoup` / `@roamhq/wrtc` native compiles).
- **No behaviour change for users on deploy** — prod already runs LiveKit; this only deletes dormant code.

**Negative / accepted risk.**
- **The in-process env-flip rollback is gone.** If LiveKit suffers the ADR-0003-class WebSocket failure (still never root-caused), recovery is a redeploy of the pre-retirement build, not a ~30-second env flip + `pm2 restart`. The maintainer accepts this; the procedure below makes the redeploy path explicit.
- MediaSoup-specific operational knowledge (its runbooks, the `:50000–50199` UDP range) becomes historical, preserved in git history and the superseded ADRs.

## Recovery procedure (replaces ADR-0008's env-flip rollback)

If LiveKit fails in a way that warrants reverting to MediaSoup:

1. **Tag the pre-retirement build before deploying the retirement.** The last MediaSoup-intact commit is `a16b9cd` (main, immediately before this PR stream):
   `git tag pre-mediasoup-retirement a16b9cd && git push origin pre-mediasoup-retirement`.
2. **Redeploy that build:** on the prod tree `git checkout pre-mediasoup-retirement`, restore `.env` to `USE_WEBRTC_ADAPTER=false` / `WEBRTC_BACKEND=mediasoup`, then `pm2 restart onestreamer-server --update-env`.
3. **File a new ADR superseding this one**, documenting the LiveKit failure mode actually observed — closing the root-cause gap ADR-0003 left open.

This is slower than the old env flip but covers the same scenario. It is only as good as the tagged build staying deployable (dependencies and infra drift), so treat it as a finite-shelf-life escape hatch, not a permanent fallback.

## Alternatives considered

- **Keep the dual stack (status quo / ADR-0017).** Rejected: pays the alignment tax and carries ~6k LoC indefinitely for a fallback that has never been exercised.
- **Keep only `MediasoupService` as a hot-pluggable safety net, delete the rest.** Rejected: the safety net's value depends on the *whole* MediaSoup path (handler, routes, client, recording, transcription) being live. A half-kept stack is the worst of both worlds — code retained, fallback still non-functional.
- **Root-cause the ADR-0003 failure first, then decide.** Reasonable but indefinitely blocked — we lack the Sept-2025 packet capture and test environment to reproduce it. Retiring now, with the redeploy escape hatch, is the pragmatic call.
