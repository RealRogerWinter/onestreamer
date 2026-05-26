# ADR-0002: MediaSoup is primary, LiveKit is dormant

_Status: superseded by [ADR-0008](0008-revive-livekit-for-url-streams-and-recording.md)_
_Date: 2026-05-23_

## Context

OneStreamer needs a WebRTC SFU (Selective Forwarding Unit) to route streamer media to all viewers. Two options were evaluated and the codebase still carries support for both:

- **[MediaSoup](https://mediasoup.org/)** — embedded in the main Node process as a native module. Simple architecture: routers + transports + producers + consumers, fully under the app's control.
- **[LiveKit](https://livekit.io/)** — a standalone WebRTC server with its own process, control plane, and ingress/egress features.

In September 2025 a non-destructive dual-stack was implemented to allow switching between the two via `WEBRTC_BACKEND`. The dual-stack was rolled back the same day after networking issues — see [ADR-0003](0003-livekit-dual-stack-rollback.md).

Today MediaSoup serves all production streams. LiveKit infrastructure remains: the server runs on `:7882`, the `livekit.onestreamer.live` subdomain proxies to it, and ~6 `ViewBotLiveKit*` services exist in the codebase — but none of them are on the production hot path.

## Decision

**MediaSoup is the production WebRTC backend.** `WEBRTC_BACKEND` defaults to `mediasoup`; production sets nothing different. The LiveKit installation is **dormant infrastructure**, not "experimental in production." Treat as scaffolding for a possible future revival.

## Consequences

**Positive.**
- One backend to reason about for streamers, viewers, recording, transcription, viewbots.
- Lower operational surface — LiveKit's separate process / config / dashboard don't need active monitoring.
- All sibling services (recording pipeline, transcription, viewbots) consistently target MediaSoup's `PlainTransport` for branch pipelines.

**Negative.**
- LiveKit's superior features (built-in ingress/egress, native room management, mobile-friendly TURN) aren't available without a revival effort. The recording pipeline reinvents pieces of what LiveKit Egress would provide for free.
- Carrying dead-code `ViewBotLiveKit*` services adds noise to [`server/services/`](../../../server/services/). See [`service-catalog.md`](../service-catalog.md) for the prune candidates.
- LiveKit credentials remain as `devkey` / `secret` defaults in production — well-known values that need rotation regardless of dormant status (see [`/docs/operations/runbooks/secret-rotation.md`](../../operations/runbooks/secret-rotation.md)).
- The `livekit.onestreamer.live` subdomain exists publicly but serves no production function.

## Alternatives considered

- **LiveKit primary, MediaSoup retired.** Rejected because of the Sept-2025 dual-stack failure (ADR-0003). Reviving LiveKit requires solving that failure first.
- **Dual-stack with runtime routing.** Was the September 2025 attempt; rolled back the same day. ADR-0003 explains why.
- **Remove all LiveKit code.** Tempting for cleanliness, but the dormant scaffolding preserves an option to revisit. Cost is the ~6 dead services and one subdomain — bearable for now. Captured as a follow-up for a focused cleanup PR.

## References

- [ADR-0003: LiveKit dual-stack rollback](0003-livekit-dual-stack-rollback.md)
- [`/docs/integrations/mediasoup.md`](../../integrations/mediasoup.md)
- [`/docs/integrations/livekit.md`](../../integrations/livekit.md)
- [`/docs/architecture/streaming-stack.md`](../streaming-stack.md)
- [`/docs/architecture/viewbot-fleet.md`](../viewbot-fleet.md) — for the `ViewBotLiveKit*` variants
