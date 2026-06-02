# Viewbot fleet misbehaving

_Last verified: 2026-05-23 against commit 4a1d325._

> ⚠️ **OUTDATED (ADR-0024).** This runbook describes the retired GStreamer/Puppeteer→MediaSoup
> viewbot fleet, which has been removed. The live viewbot path is LiveKit/RTMP-ingress based
> (see [`viewbot-fleet.md`](../../architecture/viewbot-fleet.md)). The symptoms, the
> `gst-launch`/Chrome process checks, and the `/api/viewbot-manager` commands below no longer
> apply and need a full rewrite against the LiveKit path.

## Symptoms

- Viewbot rotation stuck on one channel — never advances
- Multiple `gst-launch-1.0` or `chrome --enable-automation` processes accumulating on the host
- High CPU on the main server when no real users are streaming
- "Viewbot stream" appears in the UI but no audio/video
- Bot count in admin panel doesn't match `pgrep` count
- Repeated `viewbot-producer-error` events in `pm2 logs onestreamer-server`

## How to confirm

1. **Check the bot inventory:**
   ```bash
   curl -s -H "x-admin-key: $ADMIN_KEY" \
     https://onestreamer.live/api/viewbot-manager/status | jq
   ```
2. **Cross-check with actual processes:**
   ```bash
   pgrep -fa "gst-launch-1.0" | wc -l       # Plain RTP mode bots
   pgrep -fa "chrome --enable-automation"   # WebRTC mode bots (Puppeteer Chrome)
   pgrep -fa ffmpeg | wc -l                 # supporting ffmpeg
   ```
   If `pgrep` count >> active bot count from the API → process leak.
3. **Check rotation state:**
   ```bash
   curl -s -H "x-admin-key: $ADMIN_KEY" \
     https://onestreamer.live/api/random-stream/status | jq
   ```
4. **Tail the log for rotation events:**
   ```bash
   pm2 logs onestreamer-server | grep -iE "(rotation|viewbot)" | head -50
   ```

## Likely causes

### 1. Process leak — bots terminated without cleanup

If a viewbot lifecycle is interrupted mid-shutdown (server restart, kill -9, exception), the child `gst-launch-1.0` or Chrome process can be orphaned. The bot is gone from the orchestrator's tracking but the process keeps running, consuming CPU and ports.

**Symptoms in logs**: `viewbot-stopped` event with no matching process termination.

### 2. Rotation orchestrator stuck

`UnifiedViewBotRotation` runs a tick loop that decides when to advance. If the loop hits an unhandled exception, it stops ticking. The current bot keeps streaming forever.

**Symptoms in logs**: absence of rotation events for >10 minutes when `VIEWBOT_ROTATION_ENABLED=true`.

### 3. Mode toggle race

Switching between Plain RTP and WebRTC modes via `POST /api/viewbot-manager/toggle-mode` is supposed to be non-destructive (new bots use the new mode; existing bots finish in the old mode). A bug here can leave bots half-stopped.

**Symptoms**: bots in inconsistent state in the API response (`status: starting` for >30 s, or `status: stopping` indefinitely).

### 4. WebRTC mode bots failing to negotiate

Puppeteer Chrome bots are heavier than Plain RTP and have more failure modes — Chrome launches but can't get camera permission (no real camera), can't reach TURN, gets ICE failure, etc.

**Symptoms**: `chrome --enable-automation` processes spawn and die rapidly; `viewbot-producer-error` in logs.

### 5. External URL stream went offline

Bots ingesting Twitch / Kick / arbitrary URLs depend on the source being available. If the source goes offline mid-stream, the bot may not detect EOF gracefully.

**Symptoms**: bot appears active in admin but the underlying gst pipeline has terminated.

### 6. Resource exhaustion (host out of CPU / file descriptors)

If too many bots run concurrently (WebRTC mode + ~5–10 bots is the realistic ceiling), the host runs out of CPU. New bots fail to spawn cleanly.

**Symptoms**: `htop` shows 100% CPU saturation; `ulimit -n` exceeded errors.

## Resolution

In order of escalation:

### Soft recovery

1. **Force rotation:**
   ```bash
   curl -X POST -H "x-admin-key: $ADMIN_KEY" \
     https://onestreamer.live/api/random-stream/rotate
   ```
2. **Stop and restart a specific bot:**
   ```bash
   curl -X POST .../api/viewbot-manager/stop/<botId>
   curl -X POST .../api/viewbot-manager/start/<botId>
   ```
3. **Stop the rotation, drain, restart:**
   ```bash
   curl -X POST .../api/viewbot-manager/rotation/stop
   sleep 60                                                # let in-flight bots finish
   curl -X POST .../api/viewbot-manager/rotation/start
   ```

### Hard recovery — kill orphan processes

If `pgrep` shows orphans:

```bash
# Plain RTP mode — kill all GStreamer pipelines that look like bots
sudo pkill -f "gst-launch-1.0.*viewbot"
# If that selector misses, the nuclear option (will also kill any other live gst-launch pipelines):
sudo pkill gst-launch-1.0

# WebRTC mode — kill orphaned Puppeteer Chrome
sudo pkill -f "chrome --enable-automation"

# Supporting ffmpeg
sudo pkill -f "ffmpeg.*viewbot"

# Confirm
pgrep -fa "gst-launch-1.0|chrome --enable-automation|ffmpeg"
```

This will drop any actively-streaming bot. The orchestrator should detect the lost children and clean its tracking. Watch:

```bash
pm2 logs onestreamer-server | grep -iE "viewbot|process"
```

### Full reset

If the orchestrator itself is wedged:

```bash
pm2 restart onestreamer-server --update-env
# Wait 10 seconds for boot
sleep 10
# Confirm clean state
curl -s -H "x-admin-key: $ADMIN_KEY" .../api/viewbot-manager/status | jq
```

Real streamers and viewers will drop on this restart — communicate via `POST /api/system-message` against chat-service first.

### Flip mode to recover from WebRTC instability

If WebRTC mode bots are failing:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"useWebRTC": false}' \
  https://onestreamer.live/api/viewbot-manager/toggle-mode
```

Plain RTP mode is more resilient. Mobile viewers won't see viewbot streams while in this mode, but real streamers + real viewers are unaffected.

## Prevention

- **Monitor `pgrep` counts**:
  ```bash
  # Healthy baseline (no active stream + no bots): 0 ffmpeg, 0 gst, 0 chrome --enable-automation
  # Single stream active: 0-2 ffmpeg, 0-2 gst, 0 chrome
  # Bots running: scales with bot count
  ```
  Alert if any of these exceed `bot_count * 2` (rough heuristic for "process leak").
- **Concurrent bot cap.** Don't run more than 3–5 WebRTC mode bots simultaneously on a single host. For more, scale down to Plain RTP mode or add hosts.
- **Periodic cleanup.** If you suspect leaks, schedule a weekly `pkill` of orphan processes (be careful with the selectors).
- **Add `ulimit -n 65536`** to the systemd unit / PM2 launch — Chrome leaks file descriptors quickly.
- **Bot lifecycle telemetry.** Log every bot start/stop with the underlying PID; that makes orphan detection trivial.
- **Capture remaining `STREAM_RELIABILITY_PLAN` items** that touch viewbot cleanup — see [`/docs/archive/plans/STREAM_RELIABILITY_PLAN.md`](../../archive/plans/STREAM_RELIABILITY_PLAN.md). Some of the unresolved items from that plan touch viewbot cleanup.

## See also

- [`/docs/architecture/viewbot-fleet.md`](../../architecture/viewbot-fleet.md) — the ~20 viewbot service variants and which one is live
- [`/docs/archive/viewbot-fixes/`](../../archive/viewbot-fixes/) — historical fix notes (multiple iterations)
- [`/docs/features/external-sources-twitch-kick.md`](../../features/external-sources-twitch-kick.md) — Twitch/Kick rotation that drives URL-stream viewbots
- [`stream-stuck.md`](stream-stuck.md) — when real streamers (not bots) are affected
