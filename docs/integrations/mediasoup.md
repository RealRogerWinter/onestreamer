# MediaSoup (retired)

_Last verified: 2026-06-01 against `main`._

> [!IMPORTANT]
> **MediaSoup has been removed.** As of [ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md) (2026-06-01), **[LiveKit](livekit.md) is the sole WebRTC backend**. The MediaSoup SFU service, its socket handler and routes, the client `MediasoupClient`, the Plain-RTP transport, and the `mediasoup` + `@roamhq/wrtc` native dependencies are all deleted. There is no `mediasoup:*` signaling, no `MEDIASOUP_*` env vars, and no UDP `50000–50199` range anymore.

This page is kept only as a redirect; it carries no current configuration.

## What it was

From the project's start until [ADR-0008](../architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md) (2026-05-26), MediaSoup was the primary WebRTC SFU — workers owned routers; routers owned transports; transports carried producers/consumers; the server forwarded encrypted RTP without decoding. ADR-0008 revived LiveKit for URL relay, recording, and transcription; [ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md) then retired MediaSoup entirely once LiveKit had carried all production traffic.

The full historical rationale (codecs, port range, the SFU-vs-MCU reasoning, the alignment tax) is preserved in the superseded ADRs and in git history:

- [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md) — MediaSoup primary, LiveKit dormant (the original decision)
- [ADR-0017](../architecture/adr/0017-mediasoup-livekit-alignment-plan.md) — the dual-branch alignment plan
- [ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md) — the retirement, with the redeploy-based recovery procedure that replaced the env-flip rollback

## Where to look now

- [`livekit.md`](livekit.md) — the live WebRTC backend
- [`/docs/architecture/streaming-stack.md`](../architecture/streaming-stack.md) — the current LiveKit pipeline
- [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) — current socket events (no WebRTC handshake on the socket anymore)
