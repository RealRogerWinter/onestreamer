# Stream stuck

_Last verified: 2026-05-23 against commit 4a1d325._

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
   - `MediaSoup transport closed`
   - Any `404`, `403`, or `WebSocket` errors
3. **`pm2 logs onestreamer-server --lines 100`** — look for MediaSoup transport errors, GStreamer pipeline death, or repeated `stream-ready` emissions.
4. **`GET https://onestreamer.live/health`** — confirms the server is responding at all.
5. **`ss -ulnp | grep -E "5000[0-9]|501[0-9][0-9]"`** — confirms the MediaSoup UDP port range (50000-50199) is bound and reachable.

## Likely causes

Ranked by frequency:

### 1. Browser permission revoked or denied
- Streamer denied camera/mic, or browser auto-revoked after a refresh.
- **Fix**: streamer reloads page; on the prompt, click Allow. Confirm in browser settings that the site has persistent permissions.

### 2. ICE / NAT traversal failure
- Streamer is behind a strict NAT (corporate network, double-NAT mobile carrier) and STUN alone isn't enough.
- TURN server unreachable or misconfigured.
- **Fix**: ensure `TURN_SECRET` and `TURN_DOMAIN` env vars are set and the coturn service is running. Check `/var/log/turnserver/turnserver.log` for credential errors. If TURN is fine, advise the streamer to try a different network.

### 3. MediaSoup transport not created
- The `request-to-stream` socket event was approved but the WebRTC handshake never completed.
- Look for missing `mediasoup:create-send-transport` ← `mediasoup:connect-transport` ← `mediasoup:produce` event sequence in server logs.
- **Fix**: streamer clicks Stop, waits 10 seconds (let cooldowns reset), clicks Start again. If recurrent, check that `MediasoupService.js` initialized without errors at server boot.

### 4. GStreamer pipeline death (recording side-effect)
- If `ContinuousRecordingService` is recording and the GStreamer pipeline crashes, the entire MediaSoup→GStreamer→HLS chain can stall.
- Look for `gst-launch-1.0` process exits in `pm2 logs onestreamer-server` and `journalctl -u coturn -n 50`.
- **Fix**: `pgrep gst-launch-1.0`; if orphans exist, `sudo pkill gst-launch-1.0`. Restart the server: `pm2 restart onestreamer-server`.

### 5. Duplicate-streamer state (race condition)
- Two `stream-ready` events were emitted in quick succession; viewers latch onto a stale streamer ID.
- Symptom: server log shows the same `stream-ready` event twice within ~1 second.
- **Status**: partial mitigation deployed (see [`STREAM_RELIABILITY_PLAN.md`](../../archive/plans/STREAM_RELIABILITY_PLAN.md) and the [verification notes](../../_verification-notes.md) Q6). `currentStreamer` sync between `StreamService` and `MediasoupService` is in place; the dedup of `stream-ready` itself is not.
- **Fix**: admin disconnects the stream (`POST /api/admin/stream/disconnect`); streamer starts a fresh broadcast.

### 6. Browser self-throttling
- Streamer's tab is backgrounded; Chrome / Firefox throttle camera frame production.
- **Fix**: streamer keeps the tab foregrounded. For longer-form streaming, encourage popout-mode or a dedicated streaming window.

## Resolution

In order of escalation:

1. **Refresh the streamer's tab.** Fixes the majority of cases (re-establishes WebRTC, re-prompts permissions).
2. **Admin disconnect.** If a refresh doesn't help and the stream is "stuck open" server-side: `POST /api/admin/stream/disconnect` from the moderation panel. Streamer can then start fresh.
3. **Kill orphan media processes.**
   ```bash
   sudo pgrep -fa "gst-launch-1.0|ffmpeg|chrome --enable-automation" | head
   sudo pkill gst-launch-1.0
   sudo pkill ffmpeg
   ```
4. **Restart the main server.** `pm2 restart onestreamer-server`. This drops every active connection — broadcast a warning in chat first via `POST /api/system-message` against the chat-service.
5. **Last resort.** `pm2 restart all` (server + chat + client). Note this rotates the chat in-memory history too.

## Prevention

- Keep coturn healthy: monitor `/var/log/turnserver/turnserver.log` for `Bad credentials` spikes; rotate the HMAC secret per the [`secret-rotation.md`](secret-rotation.md) runbook if exposed.
- Watch for `gst-launch-1.0` process leaks via `pgrep -c gst-launch-1.0`. A normal idle system should be 0; a healthy single-stream system should be ≤2.
- Set up a `/health` poll alert that pages on consecutive failures.
- If you find a *new* cause for this symptom, add it to the "Likely causes" section above with a Fix.

## Related

- [`livekit-disconnect.md`](livekit-disconnect.md) — if/when LiveKit is revived, similar symptoms but different fixes
- [`viewbot-fleet-misbehaving.md`](viewbot-fleet-misbehaving.md) — viewbot-rotation issues can present as "stream stuck" symptoms
- [`/docs/features/streaming-and-takeover.md`](../../features/streaming-and-takeover.md) — the normal happy-path takeover flow this runbook diagnoses failures in
