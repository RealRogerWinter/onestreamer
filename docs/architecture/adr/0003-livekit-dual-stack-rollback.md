# ADR-0003: LiveKit dual-stack rollback (Sept 2025)

_Status: Accepted (historical record). Superseded by [ADR-0024](0024-retire-mediasoup-livekit-only.md) — the dual stack whose rollback this documents no longer exists; LiveKit is the sole backend._
_Date: 2026-05-23 (documenting a decision made 2025-09-12)_

## Context

In September 2025 a non-destructive dual-stack architecture was implemented to give OneStreamer the option of running on either MediaSoup or LiveKit at runtime, selectable via the `WEBRTC_BACKEND` environment variable. The work touched: a new `WebRTCAdapter` abstraction layer, parallel viewbot service variants (`ViewBotLiveKit*`), LiveKit server installation, nginx routing for `livekit.onestreamer.live` and `/livekit/*` paths, and ~40 KB of planning + implementation docs (preserved in [`/docs/archive/livekit/`](../../archive/livekit/)).

On the same day the dual-stack was declared "complete" (multiple `DUAL_STACK_*` files were created), it was rolled back. The contemporaneous reason captured in `LIVEKIT-NETWORKING-ISSUE.md` (now in [`/docs/archive/livekit/`](../../archive/livekit/)): WebSocket connectivity for LiveKit signaling failed unpredictably; the streaming experience was less reliable than MediaSoup-only. Production reverted to MediaSoup; LiveKit was left in place as dormant infrastructure (see [ADR-0002](0002-mediasoup-primary-livekit-dormant.md)).

## Decision

**The Sept 2025 dual-stack is rolled back. MediaSoup remains the sole production WebRTC backend.** LiveKit infrastructure is preserved but unused.

**This decision is reversible** with explicit work: a new ADR must supersede this one before LiveKit is re-introduced to the production hot path. Reviving LiveKit requires diagnosing the original WebSocket failure mode — not just flipping `WEBRTC_BACKEND`.

## Consequences

**Positive.**
- Production streaming is stable on MediaSoup, the originally-shipped backend.
- The rollback honored the principle of "if you can't explain the failure, don't ship the fix." The Sept-12 networking issues were never fully root-caused.

**Negative.**
- Significant engineering effort (architecting `WebRTCAdapter`, building the dual-stack, writing the planning docs) is unrealized in production.
- LiveKit's potential advantages — built-in ingress, native egress, mobile-friendly TURN, simpler room management — remain unrealized.
- Dead code persists in the codebase (the 6 `ViewBotLiveKit*` services + supporting infrastructure). See [`service-catalog.md`](../service-catalog.md).
- The `livekit.onestreamer.live` subdomain and `:7882` listener serve no production function and add unnecessary attack surface (the default `devkey` / `secret` credentials make this worse).

## Alternatives considered (at the time)

- **Persevere with debugging the WebSocket issue.** Rejected on time pressure; the symptoms were intermittent and hard to reproduce.
- **Use LiveKit for viewbots only (mixed-backend per service).** Rejected because it would have kept the LiveKit infrastructure in active use, with its own failure modes, for a non-critical subsystem.
- **Use LiveKit's built-in TURN for mobile-only clients.** Considered but not implemented; required deeper integration than time allowed.

## What a revival would need

If a future ADR supersedes this one and brings LiveKit back to production:

1. **Root-cause analysis of the original WebSocket failure.** Without this, the same outage may recur.
2. **Credential rotation** away from `devkey` / `secret` (mandatory — see [`/docs/operations/runbooks/secret-rotation.md`](../../operations/runbooks/secret-rotation.md)).
3. **Smoke-test the dormant `ViewBotLiveKit*` services** — they may have rotted since Sept 2025.
4. **Update [ADR-0002](0002-mediasoup-primary-livekit-dormant.md)** with a `Status: superseded by ADR-XXXX` header.
5. **Update [`livekit-disconnect.md`](../../operations/runbooks/livekit-disconnect.md)** runbook with actual observed symptoms.

## References

- [ADR-0002: MediaSoup primary, LiveKit dormant](0002-mediasoup-primary-livekit-dormant.md)
- [`/docs/archive/livekit/`](../../archive/livekit/) — full historical record (multiple `DUAL_STACK_*` and `LIVEKIT-*` files)
- [`/docs/integrations/livekit.md`](../../integrations/livekit.md)
- [`/docs/operations/runbooks/livekit-disconnect.md`](../../operations/runbooks/livekit-disconnect.md)
