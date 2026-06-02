# Viewbot fleet

_Last verified: 2026-06-01 against `main` (post-ADR-0024 cleanup)._

A **viewbot** is a synthetic streamer: an external URL or a local video file piped into the platform as if it were a real broadcaster, so the stream is never empty between real takeovers. Since [ADR-0024](adr/0024-retire-mediasoup-livekit-only.md) there is **one ingest backend — LiveKit** — and the historical GStreamer / Plain-RTP / Puppeteer-WebRTC modes (and their ~20 service variants) are gone. What remains is two small, purpose-built paths plus the rotation gating that protects real streamers.

## The two live ingest paths

| Path | Service | Source | Pipeline |
|------|---------|--------|----------|
| **URL relay** (primary) | [`ViewBotURLService.js`](../../server/services/ViewBotURLService.js) | Arbitrary HTTP / Twitch / Kick / RTMP URL | `streamlink`/`yt-dlp` → FFmpeg → RTMP → **LiveKit ingress** → viewers |
| **Local video** | [`ViewBotLiveKitService.js`](../../server/services/ViewBotLiveKitService.js) | A video file on disk | FFmpeg → RTMP → **LiveKit ingress** → viewers |

Both terminate identically: an FFmpeg process pushes to a per-stream LiveKit **ingress** (`rtmp://127.0.0.1:1935/live/<streamKey>`), created via `LiveKitService.createIngress(...)`. From LiveKit onward a viewbot stream is indistinguishable from a real streamer to the viewer client.

```
URL relay:
  source URL ─► streamlink/yt-dlp ─► FFmpeg ─► RTMP ─► LiveKit ingress ─► LiveKit room ─► viewer browsers

Local video:
  video file ─► FFmpeg ─► RTMP ─► LiveKit ingress ─► LiveKit room ─► viewer browsers
```

## Rotation and real-streamer protection

The fleet does not run unsupervised — it is gated so a bot never stomps a live human or an active URL relay:

- [`RandomStreamRotationService.js`](../../server/services/RandomStreamRotationService.js) — top-level orchestrator. Picks the next source (random Twitch via Helix, random Kick via the Python helper, or a saved URL) and drives the URL relay through `ViewBotURLService`. Pauses on a real takeover and auto-resumes when the human stops (`pause()` / `shouldAutoRestart`). Its wiring/announcer/recovery internals live under [`server/services/random-stream/`](../../server/services/).
- [`SimpleViewBotRotation.js`](../../server/services/SimpleViewBotRotation.js) — the gating layer. Holds `StreamService` + `ViewBotURLService` references and refuses to start a viewbot while `isRealStreamerActive` / a URL relay is live. This is the "don't bot over a real streamer" guard.

The URL-relay HTTP surface is **[`server/routes/url-stream.js`](../../server/routes/url-stream.js)** (mounted at `/api/url-stream`): create (`POST /`), list (`GET /`), validate, probe, history, adaptive-encoding read/write, presets, per-stream logs, stop-all, delete. The Twitch/Kick rotation feature (see [`/docs/features/external-sources-twitch-kick.md`](../features/external-sources-twitch-kick.md)) is the heaviest user.

> [!NOTE]
> The old `/api/viewbot-manager/*` endpoints, the `viewbot-config.json` file, and the Plain-RTP↔WebRTC "mode toggle" no longer exist. There is nothing to toggle — every viewbot is a LiveKit ingress.

## Supporting services

All under `server/services/` unless noted.

### URL relay internals

- [`URLStreamExtractorService.js`](../../server/services/URLStreamExtractorService.js) — resolves a platform URL to a playable stream and builds the `streamlink` pipe (`createStreamPipe`).
- [`urlstream/FFmpegPipeline.js`](../../server/services/urlstream/FFmpegPipeline.js) — builds the FFmpeg → RTMP process (`createRTMPProcess`).
- [`urlstream/IngressJanitor.js`](../../server/services/urlstream/IngressJanitor.js) — tears down LiveKit ingresses + child processes on stop/cleanup.
- [`urlstream/StreamReconnector.js`](../../server/services/urlstream/StreamReconnector.js) — reconnect/backoff when a source drops.
- [`urlstream/WhitelistGate.js`](../../server/services/urlstream/WhitelistGate.js) — entry-time content-policy check ([ADR-0010](adr/0010-url-relay-whitelist-mode.md)).
- [`urlstream/ViewerNotifier.js`](../../server/services/urlstream/ViewerNotifier.js) — emits viewer-facing "stream ready" notifications.
- [`URLStreamDatabaseService.js`](../../server/services/URLStreamDatabaseService.js) — persists URL-stream configs.
- [`URLStreamHealthService.js`](../../server/services/URLStreamHealthService.js) — liveness monitoring of active relays.
- [`StreamProbeService.js`](../../server/services/StreamProbeService.js) — `ffprobe`-based source inspection (used by `POST /api/url-stream/probe`).

### Local-video internals

- [`ViewBotLiveKitService.js`](../../server/services/ViewBotLiveKitService.js) — creates the per-bot ingress and FFmpeg RTMP process for a local file (rotates ingresses across videos; deletes the prior ingress to avoid SIGPIPE).
- [`viewbot/ffmpegArgs.js`](../../server/services/viewbot/ffmpegArgs.js), [`viewbot/streamDefaults.js`](../../server/services/viewbot/streamDefaults.js), [`viewbot/UsernameCache.js`](../../server/services/viewbot/UsernameCache.js), [`viewbotLivekit/helpers.js`](../../server/services/viewbotLivekit/helpers.js) — argument builders and helpers.

### Whitelist policy (mid-stream)

- [`WhitelistService.js`](../../server/services/WhitelistService.js) — per-platform `off`/`blacklist`/`whitelist` policy + CCL/mature gates ([ADR-0010](adr/0010-url-relay-whitelist-mode.md)).
- [`WhitelistEnforcer.js`](../../server/services/WhitelistEnforcer.js) — polling drift-checker that stops a relay if the source drifts out of policy ([ADR-0023](adr/0023-url-relay-language-filter.md) adds the language filter).

## Topology

```
                 Admin / API caller
                        │  POST /api/url-stream  (server/routes/url-stream.js)
                        ▼
            ┌──────────────────────────────┐
            │  RandomStreamRotationService │  picks next source, pauses on real takeover
            └───────────────┬──────────────┘
                            │  gated by
                            ▼
                  ┌────────────────────┐
                  │ SimpleViewBotRotation │  real-streamer / URL-relay protection
                  └─────────┬──────────┘
            ┌───────────────┴───────────────┐
            ▼                               ▼
   ViewBotURLService                ViewBotLiveKitService
   (streamlink/yt-dlp → FFmpeg)     (local file → FFmpeg)
            │                               │
            └───────────────┬───────────────┘
                            ▼
                  RTMP → LiveKit ingress
                            ▼
                  LiveKit room  ──►  viewer browsers (LiveKitClient)
```

## When you'd actually need to touch this code

| Task | Where |
|------|-------|
| Add a new external URL provider (e.g. YouTube live) | `URLStreamExtractorService.js` |
| Change the relay FFmpeg encode args | `urlstream/FFmpegPipeline.js` (URL relay) / `viewbot/ffmpegArgs.js` (local video) |
| Change rotation timing / source selection | `RandomStreamRotationService.js` (+ `server/services/random-stream/`) |
| Tighten the "don't bot over a real streamer" rule | `SimpleViewBotRotation.js` |
| Adjust content policy | `WhitelistService.js` / `WhitelistEnforcer.js` |
| Fix a leaked ingress or orphan FFmpeg | `urlstream/IngressJanitor.js`; see the runbook below |

## Operational symptoms and where to look

| Symptom | First check |
|---------|-------------|
| Rotation hung on one stream | `RandomStreamRotationService` log: `pm2 logs onestreamer-server \| grep -i rotation` |
| Relay shows "ingress not connected" | LiveKit ingress never received RTMP — see [`/docs/operations/runbooks/livekit-ingress-not-connected.md`](../operations/runbooks/livekit-ingress-not-connected.md) |
| Bot streams but no audio/video | Inspect the FFmpeg command + source: `StreamProbeService` / `ffprobe <url>` |
| Orphan `ffmpeg` / `streamlink` processes | `pgrep -fa "ffmpeg\|streamlink"`; see [`/docs/operations/runbooks/viewbot-fleet-misbehaving.md`](../operations/runbooks/viewbot-fleet-misbehaving.md) |
| Relay stopped itself mid-stream | `WhitelistEnforcer` drift check — the source left policy; see [`/docs/operations/runbooks/url-relay-whitelist.md`](../operations/runbooks/url-relay-whitelist.md) |

## See also

- [`streaming-stack.md`](streaming-stack.md) — the LiveKit pipeline this ingests into
- [`service-catalog.md`](service-catalog.md) — every `server/services/` module
- [`/docs/operations/runbooks/viewbot-fleet-misbehaving.md`](../operations/runbooks/viewbot-fleet-misbehaving.md) — operational diagnosis
- [`/docs/integrations/twitch.md`](../integrations/twitch.md), [`/docs/integrations/kick.md`](../integrations/kick.md) — where random-URL bots get their URLs
- [ADR-0024](adr/0024-retire-mediasoup-livekit-only.md) — why there is only one ingest backend now; [ADR-0010](adr/0010-url-relay-whitelist-mode.md) / [ADR-0023](adr/0023-url-relay-language-filter.md) — relay content policy
