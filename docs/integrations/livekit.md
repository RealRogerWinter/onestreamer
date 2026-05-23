# LiveKit

_Last verified: 2026-05-23 against commit 4a1d325._

> [!IMPORTANT]
> **LiveKit infrastructure is dormant.** The server runs at `livekit.onestreamer.live` (`:7882`), and several `ViewBotLiveKit*` services exist in the code, but no production streaming path uses it. The Sept-2025 dual-stack attempt was rolled back the same day — see [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md) and [ADR-0003](../architecture/adr/0003-livekit-dual-stack-rollback.md). This page documents how the integration *would* work and what's wired so it can be revived intentionally rather than accidentally.

## What it is

- **Server**: [LiveKit OSS](https://livekit.io/) — an alternative WebRTC SFU. Self-hosted as a system service.
- **Server SDK**: [`livekit-server-sdk`](https://www.npmjs.com/package/livekit-server-sdk) v2.13.3 — room management, ingress, egress.
- **Node SDK**: [`@livekit/rtc-node`](https://www.npmjs.com/package/@livekit/rtc-node) v0.13.20 — server-side audio/video producer/consumer logic.
- **Client SDK**: [`livekit-client`](https://www.npmjs.com/package/livekit-client) v2.15.7 — used by viewbot variants only.

## Where it runs

- **System service** on the OneStreamer host (likely systemd; not in `ecosystem.config.js`).
- **Ports**: `:7880` (HTTP) and `:7882` (WebSocket/signaling).
- **Public hostname**: `livekit.onestreamer.live` (separate nginx vhost — `/etc/nginx/sites-available/livekit.onestreamer.live`).
- **Path routing**: nginx also exposes `/livekit/rtc`, `/livekit/twirp/`, and `/livekit/*` on `onestreamer.live` itself, proxying to the same backend.
- **Server config**: per-deploy `livekit-config.yaml` at the repo root (gitignored). The tracked reference is **[`config/livekit-config.example.yaml`](../../config/livekit-config.example.yaml)** — copy, replace `YOUR_PUBLIC_IP` / `YOUR_DOMAIN` / `YOUR_LIVEKIT_API_KEY` / `YOUR_LIVEKIT_API_SECRET`, then start the LiveKit server pointed at it. An alternative TLS-only profile lives at [`config/livekit-ssl.example.yaml`](../../config/livekit-ssl.example.yaml). Both files were untracked as part of [ADR-0007](../architecture/adr/0007-livekit-cleanup-staging.md) — dormant infrastructure, but the *config shape* is preserved so a future revival doesn't have to rediscover it.

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
> Even though LiveKit is dormant in the streaming path, **the server is still exposed at `livekit.onestreamer.live` with the literal `devkey` / `secret` credentials**. Anyone with those values can mint tokens against your LiveKit server. Rotate when convenient — see [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md). Low blast-radius today, but unnecessary exposure.

## What was tried (the dual-stack experiment)

In September 2025 a non-destructive dual-stack was implemented: both MediaSoup and LiveKit available as backends, selected at runtime via `WEBRTC_BACKEND`. The architecture documents from that work are preserved in [`/docs/archive/livekit/`](../archive/livekit/) — multiple `DUAL_STACK_*` and `LIVEKIT_DUAL_STACK_*` files. Same-day, after WebSocket-connectivity problems surfaced, it was reverted to MediaSoup-only ([`/docs/archive/livekit/LIVEKIT-NETWORKING-ISSUE.md`](../archive/livekit/LIVEKIT-NETWORKING-ISSUE.md), [`/docs/archive/rollbacks/REVERT_SUMMARY.md`](../archive/rollbacks/REVERT_SUMMARY.md)).

The lesson captured in [ADR-0003](../architecture/adr/0003-livekit-dual-stack-rollback.md): bringing LiveKit back requires explicit investigation of the original failure mode, not just flipping the env var.

## What's wired today (dormant)

These services exist and reference LiveKit but are not on the production hot path. The orphan helpers (`LiveKitIngressService.js`, `LiveKitAudioCapture.js`, and five of the six `ViewBotLiveKit*` variants) were deleted in #25; only the wired-but-never-executed services below remain:

- [`server/services/LiveKitService.js`](../../server/services/LiveKitService.js) — core LiveKit `RoomServiceClient` wrapper
- [`server/services/ViewBotLiveKitService.js`](../../server/services/ViewBotLiveKitService.js) — the only remaining `ViewBotLiveKit*` variant; viewbot pipeline that *could* use LiveKit ingress, but production goes through `UnifiedViewBotRotation` + MediaSoup-or-WebRTC instead. See [`/docs/architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md).

Both files are scheduled for removal in a follow-up cleanup (deferred from PR-S; see [ADR-0007](../architecture/adr/0007-livekit-cleanup-staging.md) for the staged removal plan) unless ADR-0002 is reversed first.

## nginx routing (active even when dormant)

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

## Reviving LiveKit (decision-time checklist)

If you ever flip `WEBRTC_BACKEND=livekit`:

1. **Reverse [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md)** by writing a new ADR that supersedes it. Capture the new rationale, not just "we changed our mind."
2. **Rotate `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`** away from the `devkey`/`secret` defaults. See [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).
3. **Re-test the WebSocket-upgrade path** that caused the original rollback. The `/livekit/rtc` nginx config has the right `Upgrade` / `Connection` headers, but it's worth a fresh end-to-end probe.
4. **Audit the dormant `ViewBotLiveKit*` services** — they may have rotted since Sept 2025. Smoke-test each variant before promoting any.
5. **Update [`viewbot-fleet.md`](../architecture/viewbot-fleet.md)** and this page to reflect the new state.

## Related code

| Concern | File |
|---------|------|
| LiveKit room/token management | [`server/services/LiveKitService.js`](../../server/services/LiveKitService.js) |
| RTMP ingress | _(was `LiveKitIngressService.js`; deleted in #25 as orphan)_ |
| Audio capture | _(was `LiveKitAudioCapture.js`; deleted in #25 as orphan)_ |
| Backend selection | [`server/config/webrtc.config.js`](../../server/config/webrtc.config.js) |
| nginx routing | `/etc/nginx/sites-available/livekit.onestreamer.live`, `/etc/nginx/sites-available/onestreamer.live` |

## See also

- [`mediasoup.md`](mediasoup.md) — the active backend
- [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md), [ADR-0003](../architecture/adr/0003-livekit-dual-stack-rollback.md)
- [`/docs/archive/livekit/`](../archive/livekit/) — historical fix notes from the failed dual-stack
- [`/docs/operations/runbooks/livekit-disconnect.md`](../operations/runbooks/livekit-disconnect.md) — incident runbook (mainly relevant after revival)
