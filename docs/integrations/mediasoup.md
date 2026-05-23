# MediaSoup

_Last verified: 2026-05-23 against commit 4a1d325._

The primary WebRTC backend. All real-time A/V between streamers and viewers flows through MediaSoup as a Selective Forwarding Unit (SFU). See [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md) for why MediaSoup over LiveKit.

## What it is

- **Server-side**: [`mediasoup`](https://mediasoup.org/) v3.14.16, a Node.js native module backed by a per-worker C++ binary.
- **Client-side**: [`mediasoup-client`](https://www.npmjs.com/package/mediasoup-client) v3.7.18 in the React app.
- **Architecture**: Workers manage routers; routers own transports; transports carry producers (upload tracks) and consumers (download tracks). Forwards encrypted RTP without decoding video — near-zero CPU per viewer.

## Where it runs

- Server-side process: bundled inside the main OneStreamer Node server (no separate daemon).
- **UDP ports `50000–50199`** for RTP media. These must be reachable on the public-facing IP from any client that needs to play media.
- TCP signaling rides Socket.IO on `:8443` (behind nginx) — see [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) for the `mediasoup:*` event vocabulary.

## Credentials

None. MediaSoup is self-hosted; there's no external service to authenticate against. The signaling layer uses your existing JWT for authorization.

## Configuration

In [`server/config/webrtc.config.js`](../../server/config/webrtc.config.js):

```js
mediasoup: {
  listenIp:        process.env.MEDIASOUP_LISTEN_IP        || '0.0.0.0',
  announcedIp:     process.env.MEDIASOUP_ANNOUNCED_IP || process.env.ANNOUNCED_IP || '<SERVER_IP>',
  minPort:         parseInt(process.env.MEDIASOUP_MIN_PORT || '50000'),
  maxPort:         parseInt(process.env.MEDIASOUP_MAX_PORT || '50199'),
  logLevel:        process.env.NODE_ENV === 'production' ? 'error' : 'warn',
  transportOptions: {
    enableUdp: true,
    enableTcp: true,           // TCP fallback when UDP is blocked
    preferUdp: true,
    enableSctp: false,
    initialAvailableOutgoingBitrate: 300_000,
    minimumAvailableOutgoingBitrate: 100_000,
    maxIncomingBitrate: 1_500_000,
  }
}
```

### Env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | IP MediaSoup binds to |
| `MEDIASOUP_ANNOUNCED_IP` | (falls back to `ANNOUNCED_IP`) | Public IP for ICE candidates |
| `ANNOUNCED_IP` | `<SERVER_IP>` | Production public IP |
| `MEDIASOUP_MIN_PORT` | `50000` | Low end of UDP RTP range |
| `MEDIASOUP_MAX_PORT` | `50199` | High end of UDP RTP range |
| `WEBRTC_BACKEND` | `mediasoup` | Backend selector. Set to `livekit` to switch — but see [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md). |

## Code paths

| Concern | File |
|---------|------|
| Worker / router / transport / producer / consumer lifecycle | [`server/services/MediasoupService.js`](../../server/services/MediasoupService.js) |
| Plain RTP transport (for recording, transcription, viewbots) | [`server/services/MediasoupPlainTransportService.js`](../../server/services/MediasoupPlainTransportService.js) |
| Backend abstraction (MediaSoup ↔ LiveKit) | [`server/services/WebRTCAdapter.js`](../../server/services/WebRTCAdapter.js), [`WebRTCAdapterV2.js`](../../server/services/WebRTCAdapterV2.js) |
| Configuration | [`server/config/webrtc.config.js`](../../server/config/webrtc.config.js) |
| Client wrapper | [`client/src/services/MediasoupClient.ts`](../../client/src/services/MediasoupClient.ts), [`MediasoupClientAdaptive.ts`](../../client/src/services/MediasoupClientAdaptive.ts) |
| Streamer producer setup | [`client/src/components/WebRTCStreamer.tsx`](../../client/src/components/WebRTCStreamer.tsx) |
| Viewer consumer setup | [`client/src/components/WebRTCViewer.tsx`](../../client/src/components/WebRTCViewer.tsx) |

## Operational notes

- **Single MediaSoup worker pool per host.** No router sharding. Vertical scaling is the only growth path today.
- **Worker crashes are unusual** but recoverable — the main server detects and respawns. A crash drops active streams; users have to refresh.
- **The plain-RTP transport** ([`MediasoupPlainTransportService`](../../server/services/MediasoupPlainTransportService.js)) is critical infrastructure used by *three* secondary pipelines (recording, transcription, viewbots). A breakage here cascades.
- **Codec choices** are hardcoded in router config: Opus for audio (48 kHz; 16 kHz for the Voice Chat preset), VP8 primary + VP9 if both peers negotiate. Adding new codecs requires editing both the router config and the per-client capability negotiation.

## See also

- [`/docs/architecture/streaming-stack.md`](../architecture/streaming-stack.md) — full pipeline with diagrams
- [`/docs/features/streaming-and-takeover.md`](../features/streaming-and-takeover.md) — user-facing streaming flow
- [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) — `mediasoup:*` socket events
- [`livekit.md`](livekit.md) — the alternative backend (dormant)
- [`/docs/operations/runbooks/stream-stuck.md`](../operations/runbooks/stream-stuck.md) — when MediaSoup-related issues show up as "stream stuck"
