# Viewbot fleet

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer has accumulated **~20 viewbot service variants** under `server/services/` (every file matching `ViewBot*.js`). This is not architectural design — it's iteration debris from several attempts to solve "ingest a video file or external URL and inject it into the platform as if it were a real streamer." This page is the map: what's live, what's dormant, and what is dead-code worth pruning.

## The two production modes

Today, exactly one rotation orchestrator is wired in production, and it toggles between two ingest pipelines at runtime:

| Mode | Pipeline | Use case |
|------|----------|----------|
| **Plain RTP** (default) | GStreamer → Plain RTP → MediaSoup | Desktop viewers, local video files. Low resource cost; no NAT traversal. |
| **WebRTC** (opt-in) | Headless Chrome (Puppeteer) → WebRTC → MediaSoup | Mobile viewers (4G/5G), full ICE/TURN traversal. Higher resource cost. |

The orchestrator is [`UnifiedViewBotRotation.js`](../../server/services/UnifiedViewBotRotation.js), with [`ViewBotClientService.js`](../../server/services/ViewBotClientService.js) as the per-bot lifecycle handler. The mode toggle lives in [`ViewBotManager.js`](../../server/services/ViewBotManager.js).

```
Plain RTP mode:
  video file ─► GStreamer ─► (plain RTP) ─► MediasoupPlainTransport ─► MediaSoup ─► desktop viewers

WebRTC mode:
  video file ─► headless Chrome (Puppeteer) ─► (WebRTC) ─► MediaSoup ─► all viewers (incl. mobile)
```

## Why two modes?

| Concern | Plain RTP | WebRTC |
|---------|-----------|--------|
| **Mobile (4G/5G, CGNAT)** | ❌ — no ICE/TURN | ✅ — full WebRTC, identical to a real streamer |
| **CPU per bot** | ~5–10% | ~15–25% |
| **RAM per bot** | ~50 MB | ~200 MB |
| **Startup latency** | <1 s | 3–5 s |
| **Practical concurrent ceiling** | 10–20 | 3–5 |
| **Network overhead** | minimal | +10–15% |

Use Plain RTP when the audience is desktop-only and you need many concurrent bots. Use WebRTC when mobile reach matters. The toggle is non-destructive — switching takes effect for new bots.

### Toggling at runtime

```bash
# Switch to WebRTC mode
curl -X POST https://onestreamer.live/api/viewbot-manager/toggle-mode \
  -H "Content-Type: application/json" \
  -d '{"useWebRTC": true}'

# Switch back to Plain RTP
curl -X POST https://onestreamer.live/api/viewbot-manager/toggle-mode \
  -d '{"useWebRTC": false}'

# Current state
curl https://onestreamer.live/api/viewbot-manager/status
```

Persistent default lives in [`server/config/viewbot-config.json`](../../server/config/viewbot-config.json) → `viewbots.useWebRTCViewBots`.

## Bot management

```bash
# Create a bot
curl -X POST .../api/viewbot-manager/create \
  -d '{"botId": "bot-1", "videoFile": "/path/to/video.mp4"}'

# Start streaming
curl -X POST .../api/viewbot-manager/start/bot-1

# Stop streaming
curl -X POST .../api/viewbot-manager/stop/bot-1

# Destroy bot
curl -X DELETE .../api/viewbot-manager/bot-1

# Rotation
curl -X POST .../api/viewbot-manager/rotation/start
curl -X POST .../api/viewbot-manager/rotation/stop
```

## URL-stream viewbots (the third path)

Separate from the file-based bots, [`ViewBotURLService.js`](../../server/services/ViewBotURLService.js) accepts arbitrary HTTP / Kick / Twitch URLs and feeds them into the same pipeline. See `POST /api/url-stream` (route in [`server/routes/url-stream.js`](../../server/routes/url-stream.js)). The Twitch/Kick rotation feature (see [`/docs/features/external-sources-twitch-kick.md`](../features/external-sources-twitch-kick.md)) is the heaviest user.

## The service-file inventory

All in `server/services/`. **Bold = live in production.** Italic = dead-code or superseded.

### Orchestration

- **`UnifiedViewBotRotation.js`** — current production rotation orchestrator; supports both modes
- **`ViewBotClientService.js`** — current production per-bot lifecycle (start, stop, monitor)
- **`ViewBotManager.js`** — mode toggle (Plain RTP ↔ WebRTC)
- **`ViewBotStateManager.js`** — shared state tracking
- **`SimpleViewBotRotation.js`** — simple in-memory rotation state, used by URL-stream rotation + `WebRTCAdapterV2`
- **`SimpleViewBotSocket.js`** — socket helper for `SimpleViewBotRotation`
- _`ViewBotRotationService.js`_ — legacy, replaced by `UnifiedViewBotRotation`
- _`WebRTCViewBotRotation.js`_ — earlier WebRTC-only rotation
- _Deleted in #25_: `ViewBotMonitor.js`, `ViewBotMetrics.js`, `ViewBotRotationIntegration.js`, `InitializeSimpleRotation.js`

### Plain RTP mode

- **`MediasoupPlainTransportService.js`** — creates the plain-RTP transport for GStreamer to feed into
- **`ViewBotGStreamerService.js`** — the GStreamer pipeline
- _Deleted in #25_: `ViewBotFFmpegService.js` (FFmpeg-based variant; never wired)

### WebRTC (Puppeteer) mode

- **`ViewBotWebRTCService.js`** — Puppeteer-driven Chrome that joins a viewbot HTML page and produces WebRTC
- `viewbot-stream.html` (in `server/public/`) — the page Puppeteer loads
- _`WebRTCViewBot.js`_ — earlier WebRTC experiment, retained for reference
- _Deleted in #25_: `ViewBotMuxedStreamService.js`, `SimpleViewBotMediaSoup.js`, `SimpleTestBot.js`

### LiveKit-based variants

`ViewBotLiveKitService.js` is the only remaining LiveKit-backed variant. Dormant per [ADR-0002](adr/0002-mediasoup-primary-livekit-dormant.md) / [ADR-0003](adr/0003-livekit-dual-stack-rollback.md) and scheduled for removal alongside `LiveKitService.js` in PR-S. The other six variants (`ViewBotLiveKit{FFmpeg,Node,Puppeteer,RTMP,SDK}.js`, `ViewBotGStreamerWebRTC.js`) were deleted in #25.

### URL ingest

- **`ViewBotURLService.js`** — arbitrary URL → viewbot
- **`URLStreamExtractorService.js`** — extracts the actual playable URL from Twitch/Kick HTML
- **`URLStreamDatabaseService.js`** — persists URL stream configs
- **`URLStreamHealthService.js`** — monitors URL streams for liveness

### Helpers

- **`createViewBotSDP.js`** — utility for crafting SDP offers
- **`launch-chrome-xvfb.sh`** — wrapper script that spawns Puppeteer Chrome under Xvfb (X virtual framebuffer) so it can run on a headless server

## Topology

```
                     Admin / API caller
                            │
                            ▼
              ┌──────────────────────────┐
              │  /api/viewbot-manager/*  │ (server/routes/viewbot-manager.js)
              └──────────────┬───────────┘
                             │
                             ▼
                   ┌────────────────────┐
                   │  ViewBotManager    │   (mode toggle)
                   └─────────┬──────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
    UnifiedViewBotRotation       ViewBotURLService
              │                             │
              ▼                             │
    ViewBotClientService                    │
              │                             │
   ┌──────────┴───────────┐                 │
   │                      │                 │
   ▼                      ▼                 │
 Plain RTP mode      WebRTC mode            │
 (GStreamer pipe)    (Puppeteer Chrome)     │
   │                      │                 │
   ▼                      ▼                 │
MediasoupPlainTransport   MediaSoup ◄───────┘
   │                      │
   └──────────┬───────────┘
              ▼
       MediaSoup router (the main streaming SFU)
              │
              ▼
        viewer browsers
```

## When you'd actually need to touch this code

| Task | Where |
|------|-------|
| Add a new GStreamer filter/encoder option to Plain RTP mode | `ViewBotGStreamerService.js` |
| Adjust Puppeteer Chrome launch flags | `launch-chrome-xvfb.sh` + `ViewBotWebRTCService.js` |
| Change rotation timing or shuffle algorithm | `UnifiedViewBotRotation.js` |
| Add support for a new external URL provider (e.g. YouTube live) | `URLStreamExtractorService.js` |
| Resurrect LiveKit-backed viewbots | The dormant `ViewBotLiveKit*.js` files; see ADR-0003 for what failed last time |

## Pruning history + remaining candidates

**Landed in #25:** 16 orphan services removed after transitive-closure verification (`InitializeSimpleRotation.js`, `ViewBotRotationIntegration.js`, `SimpleTestBot.js`, `SimpleViewBotMediaSoup.js`, `ViewBotFFmpegService.js`, `ViewBotGStreamerWebRTC.js`, `ViewBotMuxedStreamService.js`, `ViewBotMetrics.js`, `ViewBotMonitor.js`, plus five of the six `ViewBotLiveKit*.js` variants and the two LiveKit-supporting services `LiveKitAudioCapture.js`, `LiveKitIngressService.js`). Plus `StreamInterceptorIntegration.js` (separate orphan flagged in review).

**Still present, candidates for follow-up:**

- `ViewBotRotationService.js`, `WebRTCViewBotRotation.js`, `WebRTCViewBot.js` — verify-before-removal (a few non-obvious transitive references).
- `ViewBotLiveKitService.js`, `LiveKitService.js`, `client/src/services/LiveKitClient.ts` — wired but never executed in production. Scheduled for PR-S.

## Operational symptoms and where to look

| Symptom | First check |
|---------|-------------|
| Rotation hung on one stream | `UnifiedViewBotRotation` log; check `pm2 logs onestreamer-server | grep ROTATION` |
| Bot CPU pinned at 100% | Probably WebRTC mode with too many concurrent bots — drop to Plain RTP or reduce count |
| Bot streams but no audio | GStreamer pipeline missing audio elements (Plain RTP) or Chrome audio permission (WebRTC) |
| Orphan `chrome` / `gst-launch-1.0` processes | `pgrep -fa "chrome --enable-automation\|gst-launch-1.0"`; see [`/docs/operations/runbooks/viewbot-fleet-misbehaving.md`](../operations/runbooks/viewbot-fleet-misbehaving.md) |
| Mobile viewers can't see the bot stream | You're in Plain RTP mode; flip to WebRTC for that bot |

## See also

- [`streaming-stack.md`](streaming-stack.md) — where viewbot ingest plugs into the main streaming pipeline
- [`/docs/operations/runbooks/viewbot-fleet-misbehaving.md`](../operations/runbooks/viewbot-fleet-misbehaving.md) — operational diagnosis
- [`/docs/integrations/twitch.md`](../integrations/twitch.md), [`/docs/integrations/kick.md`](../integrations/kick.md) — where the random URL bots get their URLs
- [ADR-0002](adr/0002-mediasoup-primary-livekit-dormant.md), [ADR-0003](adr/0003-livekit-dual-stack-rollback.md) — why LiveKit variants are dormant
