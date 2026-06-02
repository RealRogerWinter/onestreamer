# LiveKit

_Last verified: 2026-06-01 against `main` (post-ADR-0024)._

> [!IMPORTANT]
> **LiveKit is the sole WebRTC backend** ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). Every production media path runs over it: the primary streamer↔viewer stream, URL-stream relay (ingress), recording (egress), and transcription (RTC capture). MediaSoup was retired. (The Sept-2025 dual-stack rollback — [ADR-0003](../architecture/adr/0003-livekit-dual-stack-rollback.md) — is historical; LiveKit was later revived for URL relay/recording/transcription in [ADR-0008](../architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md) and then made the only backend in ADR-0024.)

## What it is

- **Server**: [LiveKit OSS](https://livekit.io/) — the self-hosted WebRTC SFU, run as a system service.
- **Server SDK**: [`livekit-server-sdk`](https://www.npmjs.com/package/livekit-server-sdk) — room management, ingress, egress (used by `LiveKitService`, `ViewBotURLService`, `ContinuousRecordingService`).
- **Node RTC SDK**: [`@livekit/rtc-node`](https://www.npmjs.com/package/@livekit/rtc-node) — server-side RTC audio capture (used by `TranscriptionAudioAdapter`).
- **Client SDK**: [`livekit-client`](https://www.npmjs.com/package/livekit-client) — the browser streamer/viewer path via [`LiveKitClient.ts`](../../client/src/services/LiveKitClient.ts).

## Where it runs

- **System service** on the OneStreamer host (likely systemd; not in `config/ecosystem.config.js`).
- **Ports**: `:7880` (HTTP) and `:7882` (WebSocket/signaling).
- **Public hostname**: `livekit.onestreamer.live` (separate nginx vhost — `/etc/nginx/sites-available/livekit.onestreamer.live`).
- **Path routing**: nginx also exposes `/livekit/rtc`, `/livekit/twirp/`, and `/livekit/*` on `onestreamer.live` itself, proxying to the same backend.
- **Server config**: per-deploy `livekit-config.yaml` at the repo root (gitignored). The tracked reference is **[`config/livekit-config.example.yaml`](../../config/livekit-config.example.yaml)** — copy, replace `YOUR_PUBLIC_IP` / `YOUR_DOMAIN` / `YOUR_LIVEKIT_API_KEY` / `YOUR_LIVEKIT_API_SECRET`, then start the LiveKit server pointed at it. An alternative TLS-only profile lives at [`config/livekit-ssl.example.yaml`](../../config/livekit-ssl.example.yaml). The live `livekit-config.yaml` is gitignored (it holds real secrets); the `*.example.yaml` files are the tracked references.

## Credentials

| Env var | What | Current production value |
|---------|------|--------------------------|
| `LIVEKIT_API_KEY` | API key for SDK auth | `devkey` (well-known default — should be rotated) |
| `LIVEKIT_API_SECRET` | API secret | `secret` (well-known default — should be rotated) |
| `LIVEKIT_HOST` | LiveKit API URL | `http://127.0.0.1:7882` |
| `LIVEKIT_WS_URL` | Client SDK WebSocket URL | `ws://localhost:7882` |
| `LIVEKIT_ROOM_NAME` | Default room | `onestreamer-main` |
| `LIVEKIT_MAX_PARTICIPANTS` | Room cap | `1000` |
| `LIVEKIT_EMPTY_TIMEOUT` | Room auto-close timeout (seconds) | `300` |
| `LIVEKIT_TURN_ENABLED` | Enable LiveKit's built-in TURN | `false` |
| `LIVEKIT_USE_FFMPEG_FALLBACK` | Fall back to ffmpeg if ingress fails | `false` |

> [!WARNING]
> If a deployment is still using the well-known `devkey` / `secret` defaults, **anyone with those values can mint tokens against your LiveKit server.** Since LiveKit now carries all production media this is load-bearing — rotate `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` to real secrets. See [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).

## History (the dual-stack experiment)

In September 2025 a non-destructive dual-stack was implemented: both MediaSoup and LiveKit available as backends, selected at runtime via `WEBRTC_BACKEND`. The architecture documents from that work are preserved in [`/docs/archive/livekit/`](../archive/livekit/). Same-day, after WebSocket-connectivity problems surfaced, it was reverted to MediaSoup-only ([`/docs/archive/livekit/LIVEKIT-NETWORKING-ISSUE.md`](../archive/livekit/LIVEKIT-NETWORKING-ISSUE.md), [`/docs/archive/rollbacks/REVERT_SUMMARY.md`](../archive/rollbacks/REVERT_SUMMARY.md)). LiveKit was later revived deliberately for URL relay, recording, and transcription ([ADR-0008](../architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md)), then promoted to the **sole** backend when MediaSoup was retired ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). The Sept-2025 WebSocket failure ([ADR-0003](../architecture/adr/0003-livekit-dual-stack-rollback.md)) was never root-caused — see ADR-0024's recovery procedure for the implication.

## What's wired today

LiveKit is on every production media path:

- [`server/services/LiveKitService.js`](../../server/services/LiveKitService.js) — core `RoomServiceClient` + ingress/egress clients: rooms, tokens, `createIngress`/`deleteIngress`, webhooks.
- [`server/services/ViewBotURLService.js`](../../server/services/ViewBotURLService.js) — URL relay (streamlink/yt-dlp → FFmpeg → RTMP → LiveKit ingress).
- [`server/services/ViewBotLiveKitService.js`](../../server/services/ViewBotLiveKitService.js) — local-video viewbots (FFmpeg → RTMP → LiveKit ingress).
- [`server/services/ContinuousRecordingService.js`](../../server/services/ContinuousRecordingService.js) — recording via LiveKit Egress (Room Composite / Participant).
- [`server/services/TranscriptionAudioAdapter.js`](../../server/services/TranscriptionAudioAdapter.js) — RTC audio capture via `@livekit/rtc-node`.
- [`client/src/services/LiveKitClient.ts`](../../client/src/services/LiveKitClient.ts) (via [`WebRTCClientAdapter.ts`](../../client/src/services/WebRTCClientAdapter.ts)) — the browser streamer/viewer path.

See [`/docs/architecture/streaming-stack.md`](../architecture/streaming-stack.md) and [`/docs/architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md).

## nginx routing

```nginx
# /etc/nginx/sites-available/onestreamer.live (excerpt)
location /livekit/rtc {
    proxy_pass http://[::1]:7882/rtc;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_connect_timeout 7d;       # for long-lived RTC connections
    proxy_send_timeout    7d;
    proxy_read_timeout    7d;
}
location /livekit/twirp/ { proxy_pass http://[::1]:7882/twirp/; }
location /livekit         { proxy_pass http://[::1]:7882; ... }
```

And separately `/etc/nginx/sites-available/livekit.onestreamer.live` serves the dedicated subdomain.

## Operational checklist (every deploy)

LiveKit is load-bearing, so on each deploy:

1. **Rotate `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`** away from any `devkey`/`secret` defaults. See [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).
2. **Confirm the `/livekit/rtc` WebSocket-upgrade path** works (the nginx config carries the `Upgrade`/`Connection` headers + long timeouts). A failure here is the Sept-2025-class outage that has no in-process fallback ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)).
3. **Verify the `livekit-config.yaml` UDP port range** matches what the firewall exposes — a media-port mismatch breaks streaming silently.
4. **Smoke-test ingress and egress**, not just a takeover: start a URL relay (ingress) and confirm a recording starts (egress).

## Related code

| Concern | File |
|---------|------|
| LiveKit room/token/ingress/egress | [`server/services/LiveKitService.js`](../../server/services/LiveKitService.js) |
| URL-relay ingest | [`server/services/ViewBotURLService.js`](../../server/services/ViewBotURLService.js) |
| Recording (egress) | [`server/services/ContinuousRecordingService.js`](../../server/services/ContinuousRecordingService.js) |
| RTC audio capture (transcription) | [`server/services/TranscriptionAudioAdapter.js`](../../server/services/TranscriptionAudioAdapter.js) |
| Client | [`client/src/services/LiveKitClient.ts`](../../client/src/services/LiveKitClient.ts), [`WebRTCClientAdapter.ts`](../../client/src/services/WebRTCClientAdapter.ts) |
| Config | [`server/config/webrtc.config.js`](../../server/config/webrtc.config.js) (the `livekit` block) |
| nginx routing | `/etc/nginx/sites-available/livekit.onestreamer.live`, `/etc/nginx/sites-available/onestreamer.live` |

## See also

- [`/docs/architecture/streaming-stack.md`](../architecture/streaming-stack.md) — the LiveKit media pipeline
- [`mediasoup.md`](mediasoup.md) — the retired predecessor backend (stub)
- [ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md) (LiveKit-only), [ADR-0008](../architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md) (revival), [ADR-0003](../architecture/adr/0003-livekit-dual-stack-rollback.md) (the rollback)
- [`/docs/operations/runbooks/livekit-disconnect.md`](../operations/runbooks/livekit-disconnect.md), [`/docs/operations/runbooks/livekit-ingress-not-connected.md`](../operations/runbooks/livekit-ingress-not-connected.md) — incident runbooks
