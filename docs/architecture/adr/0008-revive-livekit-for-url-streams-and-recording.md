# ADR-0008: Revive LiveKit for URL streams, recording, and transcription

_Status: accepted_
_Date: 2026-05-26_

## Context

[ADR-0002](0002-mediasoup-primary-livekit-dormant.md) declared LiveKit "dormant infrastructure" after the Sept 2025 dual-stack rollback ([ADR-0003](0003-livekit-dual-stack-rollback.md)), with MediaSoup as the sole production WebRTC backend. [ADR-0007](0007-livekit-cleanup-staging.md) then staged the gradual removal of dormant LiveKit code and dependencies.

When we tried to redeploy after the May 2026 refactor, that framing did not match the running system:

- **URL stream relay (Twitch/Kick)** — `ViewBotURLService` has two code paths: `_startLiveKitStream` (RTMP→`livekit-ingress`) and `_startMediaSoupStream` (RTP→hardcoded ports `5004/5006`). The MediaSoup-direct path has **no server-side `PlainTransport` listener** for those ports — FFmpeg shouts RTP at a kernel that drops the packets. All 18,570 historical Kick recording segments came from the LiveKit path; the MediaSoup-direct path has never produced working video.
- **Continuous recording** (`ContinuousRecordingService`) — instantiates a LiveKit `EgressClient` and `RoomServiceClient` unconditionally and polls them every 5s. With LiveKit down, every poll logged `fetch failed` and disk filled (2.4 GB `server-combined-0.log` observed).
- **Transcription** (`TranscriptionAudioAdapter` / `MovieBotService`) — pulls audio from the LiveKit room to feed Whisper. With LiveKit down, every `scheduleNextTranscription` cycle logs `No active streamer found`.
- **No LiveKit→MediaSoup bridge exists.** A grep for participant-to-producer wiring returns nothing. So even if `_startLiveKitStream` succeeds, viewers consuming via `mediasoup:consume` see no producer — unless the **WebRTC adapter** routes viewer-side traffic through LiveKit too.

So "LiveKit is dormant" was aspirational; in practice, three production features (URL streams, recording, transcription) silently depended on it. With LiveKit infrastructure off, those features were broken and the failure mode was log spam at 5–23 s cadence rather than a startup error.

## Decision

**Revive LiveKit as the active WebRTC backend.** Set `USE_WEBRTC_ADAPTER=true` and `WEBRTC_BACKEND=livekit` in production. Keep MediaSoup initialized for compatibility (the bootstrap initializes both; the adapter routes between them). Restart the operational pieces that were running pre-May-5:

- `livekit-server` (systemd unit, `/usr/local/bin/livekit-server --config /root/onestreamer/livekit-config.yaml`).
- `livekit-ingress` (Docker container, network=host, `livekit/ingress:latest` mounting `ingress-config.yaml`).
- `livekit-egress` (Docker container, network=host, `livekit/egress:latest`).

All three share state through the host Redis (`127.0.0.1:6379`). The `redis:` section in `livekit-config.yaml` is mandatory — without it the server runs single-node and `createIngress` returns `twirp error unknown: ingress not connected (redis required)`. This is now reflected in `config/livekit-config.example.yaml` and the new [`livekit-ingress-not-connected.md`](../../operations/runbooks/livekit-ingress-not-connected.md) runbook.

`bind_addresses` must include **both** `127.0.0.1` and `::1` — the nginx vhost proxies `/livekit/*` to `http://[::1]:7882`, so an IPv4-only bind returns 502 to browsers.

This **supersedes [ADR-0002](0002-mediasoup-primary-livekit-dormant.md)** (MediaSoup is no longer the sole backend) and **[ADR-0007](0007-livekit-cleanup-staging.md)** (the staged LiveKit removal is paused indefinitely; the code is load-bearing, not dormant). [ADR-0003](0003-livekit-dual-stack-rollback.md) remains accepted as the historical record of why the Sept-2025 attempt failed — its diagnostic prerequisites for a revival are addressed in the "What changed since Sept 2025" section below.

## Consequences

**Positive.**
- URL-stream relay works end-to-end again. Verified: `FFmpeg → RTMP → livekit-ingress → LiveKit room participant → TranscriptionAudioAdapter pulls audio → Whisper transcription → MovieBot replies in chat`.
- The 5-second `CONTINUOUS RECORDING: Error checking room: fetch failed` log spam stops (egress is reachable).
- MovieBot transcription resumes producing comments.
- Recording pipeline (room-composite egress) is functional again — `livekit-egress` records the LiveKit room's composite to HLS segments.
- One backend handles streamers + viewers + URL-stream guests symmetrically; no impedance mismatch between SFU producers and the consume-side.

**Negative.**
- The Sept-2025 WebSocket-connectivity failure mode (ADR-0003) is **not root-caused**. We're betting that conditions changed enough — newer LiveKit (1.9.1 vs whatever ran in Sept 2025), more careful bind_addresses, an explicit Redis section — that the original symptoms don't recur. They might. The fallback is documented under "Rollback procedure" below.
- The `devkey` / `secret` defaults are still in production. They're called out in [`secret-rotation.md`](../../operations/runbooks/secret-rotation.md) and need to be rotated before going public.
- Three additional moving parts (livekit-server, livekit-ingress, livekit-egress) means three more things that can fail. The good news: ingress/egress are stateless containers with `restart: unless-stopped`; livekit-server has a systemd unit. Operationally similar to nginx/redis.
- ADR-0007's cleanup plan is parked. The `ViewBotLiveKit*` services, `LiveKitClient.ts`, and the ~50 MB of LiveKit npm deps are **load-bearing again**, not orphan code awaiting removal.
- The dormant `_startMediaSoupStream` path remains in `ViewBotURLService.js` as dead code (it's the `else` branch behind `if (this.backend === 'livekit' && this.livekitService)`). A future PR could either complete it (proper server-side `PlainTransport` handshake) as a fallback for LiveKit-down operations, or delete it for clarity. Deferred.

## What changed since Sept 2025

ADR-0003 listed five prerequisites for a LiveKit revival. Status of each:

1. **Root-cause analysis of the original WebSocket failure.** Not done. We do not have the network capture or test environment that would reproduce the Sept-12 symptoms. Accepted as a risk; see Rollback below.
2. **Credential rotation away from `devkey` / `secret`.** Still pending; tracked in `secret-rotation.md`.
3. **Smoke-test the dormant `ViewBotLiveKit*` services.** Verified live during this PR — they construct, register, and the LiveKit-mode ViewBot flow runs.
4. **Update ADR-0002 with a supersession header.** Done in this PR.
5. **Update `livekit-disconnect.md` runbook with actual observed symptoms.** Partial — the new [`livekit-ingress-not-connected.md`](../../operations/runbooks/livekit-ingress-not-connected.md) covers the most distinctive failure we hit (redis section missing, bind-address mismatch). `livekit-disconnect.md` itself remains accurate; it was written for an active-LiveKit deployment which is now our state.

## Rollback procedure

If the Sept-2025 WebSocket symptoms recur (browser console `WebSocket connection to wss://onestreamer.live/livekit/rtc failed`, viewers report black video despite the streamer broadcasting), revert to MediaSoup-only:

```bash
# 1. Flip the env back
sed -i 's/^USE_WEBRTC_ADAPTER=.*/USE_WEBRTC_ADAPTER=false/' .env
sed -i 's/^WEBRTC_BACKEND=.*/WEBRTC_BACKEND=mediasoup/' .env

# 2. Restart the server
pm2 restart onestreamer-server --update-env

# 3. (Optional) leave the containers running so recording-pipeline log spam
#    doesn't reappear; they're idle when no LiveKit room has publishers.
```

URL-stream relay, transcription, and continuous recording will break again. The other features (real streamers, viewers, chat, viewbots, takeover, items, points) continue working on MediaSoup. Then file a new ADR superseding this one, documenting the actual failure mode you observed.

## Alternatives considered

- **Fix the MediaSoup-direct `_startMediaSoupStream` path properly.** Implement the server-side `PlainTransport` handshake (allocate dynamic port → emit it to the URL-stream subsystem → spawn FFmpeg with that port → register a producer). Most aligned with the spirit of ADR-0002. Rejected for this PR because it's nontrivial code touching MediaSoup integration, lifecycle, and error handling; we'd also still need LiveKit running for recording (egress) and transcription. Doing MediaSoup-only would require porting **both** ingress and egress equivalents, which is a multi-week project against a working LiveKit alternative.
- **Run only `livekit-egress`, leave `WEBRTC_BACKEND=mediasoup`.** Would silence the recording-pipeline log spam and unbreak recording, but URL-stream relay and transcription would still be broken. Half-measure with confusing failure modes; rejected.
- **Disable URL-stream, recording, and transcription features in the UI.** Honest minimal product but the user explicitly relies on these features. Rejected.

## References

- [ADR-0002: MediaSoup primary, LiveKit dormant](0002-mediasoup-primary-livekit-dormant.md) — superseded
- [ADR-0003: LiveKit dual-stack rollback](0003-livekit-dual-stack-rollback.md) — historical context, still accepted
- [ADR-0007: Staged removal of dormant LiveKit infrastructure](0007-livekit-cleanup-staging.md) — superseded (cleanup paused)
- [`livekit-ingress-not-connected.md`](../../operations/runbooks/livekit-ingress-not-connected.md) — new runbook for the most distinctive failure mode encountered during this revival
- [`livekit-disconnect.md`](../../operations/runbooks/livekit-disconnect.md) — existing runbook for LiveKit-active deployments
- [`secret-rotation.md`](../../operations/runbooks/secret-rotation.md) — must run before public traffic
- [`config/livekit-config.example.yaml`](../../../config/livekit-config.example.yaml) — updated with the `redis:` requirement and dual-bind guidance
