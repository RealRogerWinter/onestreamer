# Stream stuck

_Last verified: 2026-06-01 against `main` (post-ADR-0024 LiveKit-only cleanup)._

## Symptoms

- The streamer's UI shows a red "LIVE" indicator and the streamer believes they're broadcasting.
- Viewers see a black screen, a frozen frame, or an error overlay.
- Viewer count is incrementing (so the signal *is* reaching the server) but no media flows.
- Sometimes: streamer's own preview also goes black after a few seconds.

## How to confirm

1. **Open the live site in a second browser tab as a viewer.** If the second tab also sees nothing, the problem is server- or stream-side. If the second tab works, the problem is local to the first viewer.
2. **Open browser DevTools on the streamer's tab → Console.** Look for:
   - `Connection state: connecting` that never moves to `connected`
   - `ICE connection state: failed`
   - `[livekit-client] Could not connect to LiveKit` / `WebSocket connection to wss://livekit.onestreamer.live/rtc failed`
   - Any `404`, `403`, or `WebSocket` errors
3. **`pm2 logs onestreamer-server --lines 100`** — look for `LiveKitService` token/room errors, egress/ingress failures, or repeated `stream-ready` emissions.
4. **`GET https://onestreamer.live/health`** — confirms the server is responding at all.
5. **`ss -tlnp | grep -E ":(7880|7882)"`** — confirms the LiveKit server is bound (`:7880` HTTP API, `:7882` RTC signaling). `curl -s http://127.0.0.1:7880/` should answer. The OneStreamer process does **not** own any media UDP ports itself — the LiveKit server handles RTC, so there's no `5000x` range to check anymore.
6. **`sudo systemctl status livekit`** and **`sudo docker ps --filter name=livekit`** — the LiveKit server runs under systemd; `livekit-ingress` / `livekit-egress` run as Docker containers. If the room is reachable but no media flows, check these.

## Likely causes

Ranked by frequency:

### 1. Browser permission revoked or denied
- Streamer denied camera/mic, or browser auto-revoked after a refresh.
- **Fix**: streamer reloads page; on the prompt, click Allow. Confirm in browser settings that the site has persistent permissions.

### 2. ICE / NAT traversal failure
- Streamer is behind a strict NAT (corporate network, double-NAT mobile carrier) and STUN alone isn't enough.
- TURN server unreachable or misconfigured.
- **Fix**: ensure `TURN_SECRET` and `TURN_DOMAIN` env vars are set and the coturn service is running. Check `/var/log/turnserver/turnserver.log` for credential errors. If TURN is fine, advise the streamer to try a different network.

### 3. LiveKit room join / publish never completed
- The `request-to-stream` socket event was approved (`streaming-approved` sent) but the browser never connected to the LiveKit room or never published its tracks.
- Look for a streamer who got `streaming-approved` but no subsequent token fetch / room-connect in the logs, or browser-console `[livekit-client] Could not connect to LiveKit`.
- **Fix**: streamer clicks Stop, waits 10 seconds (let cooldowns reset), clicks Start again. If recurrent, check that `LiveKitService` initialized without errors at server boot (`pm2 logs onestreamer-server | grep -i livekit`) and that the LiveKit server itself is up (`sudo systemctl status livekit`, `curl -s http://127.0.0.1:7880/`). For deeper LiveKit-side WS/token problems see [`livekit-disconnect.md`](livekit-disconnect.md).

### 4. Egress (recording) wedged
- Recording is **LiveKit egress** (`ContinuousRecordingService` → LiveKit egress → `recording_sessions`); there is no GStreamer→HLS chain anymore ([ADR-0024](../../architecture/adr/0024-retire-mediasoup-livekit-only.md)). A wedged egress no longer stalls the live stream the way the old in-process pipeline could, but a stuck `livekit-egress` container can still pin CPU and back up recording.
- Look for egress errors in `pm2 logs onestreamer-server` and in the egress container: `sudo docker logs --tail 50 livekit-egress`.
- **Fix**: `sudo docker restart livekit-egress` (and `livekit-ingress` if URL relay is also affected). Recording resumes on the next auto-record poll; live viewing is unaffected by an egress restart.

### 5. Duplicate-streamer state (race condition)
- Two `stream-ready` events were emitted in quick succession; viewers latch onto a stale streamer ID.
- Symptom: server log shows the same `stream-ready` event twice within ~1 second.
- **Status**: partial mitigation deployed (see [`STREAM_RELIABILITY_PLAN.md`](../../archive/plans/STREAM_RELIABILITY_PLAN.md)). The `currentStreamer` sync between `StreamService` and the WebRTC service (now `LiveKitService`) is in place; the dedup of `stream-ready` itself is not.
- **Fix**: admin disconnects the stream (`POST /api/admin/stream/disconnect`); streamer starts a fresh broadcast.

### 6. Browser self-throttling
- Streamer's tab is backgrounded; Chrome / Firefox throttle camera frame production.
- **Fix**: streamer keeps the tab foregrounded. For longer-form streaming, encourage popout-mode or a dedicated streaming window.

## Resolution

In order of escalation:

1. **Refresh the streamer's tab.** Fixes the majority of cases (re-establishes WebRTC, re-prompts permissions).
2. **Admin disconnect.** If a refresh doesn't help and the stream is "stuck open" server-side: `POST /api/admin/stream/disconnect` from the moderation panel. Streamer can then start fresh.
3. **Kill orphan media processes (URL-relay side).** These only exist when a URL-stream relay is running; there is no GStreamer or per-viewbot Chromium anymore. Stuck `ffmpeg`/`streamlink` from a wedged relay source:
   ```bash
   sudo pgrep -fa "ffmpeg|streamlink|yt-dlp" | head
   sudo pkill -9 -f "streamlink"
   sudo pkill ffmpeg
   ```
   (On the next URL-stream start, `urlstream/IngressJanitor.js` pattern-kills these automatically.)
4. **Restart the LiveKit containers** if the room is reachable but media is stuck: `sudo docker restart livekit-ingress livekit-egress`. Does not drop the main server's Socket.IO connections.
5. **Restart the main server.** `pm2 restart onestreamer-server`. This drops every active connection — broadcast a warning in chat first via `POST /api/system-message` against the chat-service.
6. **Last resort.** `pm2 restart all` (server + chat + client). Note this rotates the chat in-memory history too. If LiveKit itself is the problem: `sudo systemctl restart livekit && sudo docker restart livekit-ingress livekit-egress`.

## Prevention

- Keep coturn healthy: monitor `/var/log/turnserver/turnserver.log` for `Bad credentials` spikes; rotate the HMAC secret per the [`secret-rotation.md`](secret-rotation.md) runbook if exposed.
- Keep the LiveKit server + containers up: `sudo systemctl status livekit` and `sudo docker ps --filter name=livekit` should all be active/running. A bound `:7882` (`ss -tlnp | grep 7882`) confirms RTC signaling is listening.
- Watch for orphaned URL-relay processes via `pgrep -c -f "streamlink|ffmpeg"`. A normal idle system (no URL relay running) should be 0; these only appear while a URL stream is active.
- Set up a `/health` poll alert that pages on consecutive failures.
- If you find a *new* cause for this symptom, add it to the "Likely causes" section above with a Fix.

## Related

- [`livekit-disconnect.md`](livekit-disconnect.md) — LiveKit-server-side WS/token/TURN failures (LiveKit is now the sole WebRTC backend); same symptom, LiveKit-internal fixes
- [`livekit-ingress-not-connected.md`](livekit-ingress-not-connected.md) — URL-relay ingress fails (`ingress not connected (redis required)`) or `/livekit/*` returns 502
- [`viewbot-fleet-misbehaving.md`](viewbot-fleet-misbehaving.md) — viewbot-rotation issues can present as "stream stuck" symptoms
- [`/docs/features/streaming-and-takeover.md`](../../features/streaming-and-takeover.md) — the normal happy-path takeover flow this runbook diagnoses failures in
