# Monitoring

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer doesn't ship a built-in metrics dashboard. Monitoring relies on the standard stack of process-manager logs, system metrics, application health endpoints, and per-provider dashboards. This page is the **where-to-look** index when something feels off.

## First place to look when something is wrong

```bash
pm2 logs                              # tail logs from all three Node processes
pm2 list                              # process states + memory + CPU
pm2 monit                             # interactive top-style view
```

90% of OneStreamer issues surface in `pm2 logs` first. Skim the last 100–200 lines for stack traces, repeated errors, or anything emoji-prefixed (the code uses emoji-prefixed log lines for important events — `🔨` for moderation, `🗑️` for deletion scheduler, `📡` for WebRTC, etc.).

## Health endpoints

| Service | Endpoint | What it returns |
|---------|----------|-----------------|
| Main server | `GET /health` | `{ status, uptime, version }` |
| Chat-service | `GET /health` | `{ status: "ok", service: "onestreamer-chat", connectedUsers, messagesInHistory, timestamp }` |
| Clips subsystem | `GET /api/clips/status` | `{ available, isRecording, availableDuration, maxClipDuration, minClipDuration }` |
| Stream state | `GET /api/stream/status` | `{ hasActiveStream, streamerId, viewerCount, streamType, streamDuration }` |
| Admin dashboard | `GET /admin/dashboard` (header `x-admin-key`) | Full system snapshot |

Probe loop suggestion (run on the host or a monitoring server):

```bash
while true; do
  curl -sk https://onestreamer.live/health     | jq -c
  curl -sk https://onestreamer.live/chat/health | jq -c   # or :8444/health internally
  sleep 30
done
```

Wire failures into pages (PagerDuty, Healthchecks.io, Uptime Kuma — pick one).

## What to watch

### CPU + memory per process

```bash
pm2 monit              # live view
pm2 list               # one-shot table
```

Healthy baseline (no active stream):

- `onestreamer-server`: ~150–300 MB RAM, <5% CPU
- `onestreamer-chat`: ~80–150 MB RAM, <2% CPU
- `onestreamer-client`: ~250–400 MB RAM, <3% CPU

Under an active stream with one viewer:

- ~5–15% CPU on server (token/room coordination + recording + transcription if enabled). The WebRTC SFU work and recording encode run inside the LiveKit server process, not the app ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)).
- Add ~10–30% CPU per active transcription depending on Whisper model

**Memory caps in `config/ecosystem.config.js`** (2G server, 1G chat, 2G client) — when hit, PM2 auto-restarts. Frequent restarts = real memory leak; investigate, don't just bump the cap.

### Disk usage

```bash
df -h                                                    # overall disk
du -sh /root/onestreamer/egress-recordings/              # recording footprint (LiveKit egress)
du -sh /root/onestreamer/clips/                          # clip footprint
du -sh /root/onestreamer/audio-buffers/                  # transcription scratch
du -sh /root/onestreamer/server/data/onestreamer.db      # SQLite size
du -sh /root/onestreamer/logs/                           # PM2 logs
ls /root/onestreamer/egress-recordings/ | wc -l          # active-session directory count
```

**Recording disk is the most common runaway.** If `RecordingUploadScheduler` can't push LiveKit-egress segments to B2, they accumulate in `egress-recordings/` forever. See [`runbooks/recording-upload-failed.md`](runbooks/recording-upload-failed.md).

### Process count + orphans

```bash
pgrep -fa ffmpeg                                          # ffmpeg processes (URL-relay path only)
pgrep -fa streamlink                                      # streamlink source pulls (URL-relay path only)
```

There is no per-viewbot Chromium and no GStreamer anymore — the Puppeteer/GStreamer viewbot fleet was removed with MediaSoup ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). `ffmpeg`/`streamlink` only exist while a URL-stream relay is running. Normal idle counts:

- ffmpeg: 0 (a few while URL relays are active)
- streamlink: 0 (one per active URL relay)

Persistent process counts above these = process leak. The [`viewbot-fleet-misbehaving.md`](runbooks/viewbot-fleet-misbehaving.md) runbook covers cleanup.

### Network — LiveKit RTC UDP

```bash
ss -ulnp | grep livekit                # LiveKit RTC/ICE UDP listeners (range set in livekit-config.yaml)
ss -tlnp | grep -E ":(8443|8444|7882|1337|11434)"   # TCP listeners
```

LiveKit is the sole WebRTC backend ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)); if its RTC UDP range isn't reachable, no media flows. There is no longer a `50000–50199` MediaSoup range. See [`runbooks/livekit-disconnect.md`](runbooks/livekit-disconnect.md).

### Database health

```bash
# Quick row counts to baseline + spot anomalies
sqlite3 /root/onestreamer/server/data/onestreamer.db <<'SQL'
SELECT COUNT(*) AS users               FROM users;
SELECT COUNT(*) AS active_streams      FROM streaming_logs WHERE end_time IS NULL;
SELECT COUNT(*) AS pending_deletions   FROM users WHERE account_status='pending_deletion';
SELECT COUNT(*) AS active_transcripts  FROM transcriptions WHERE status='active';
SELECT COUNT(*) AS ip_bans             FROM ip_bans;
SELECT pg_size_pretty(SUM(file_size))  FROM recordings WHERE status='completed';
SQL

# Integrity check
sqlite3 /root/onestreamer/server/data/onestreamer.db "PRAGMA integrity_check;"
```

(Note: `pg_size_pretty` is Postgres; in SQLite, use `SELECT SUM(file_size)/1024/1024 AS MB FROM recordings;`)

### Backblaze B2

The B2 dashboard at [secure.backblaze.com](https://secure.backblaze.com) shows:

- Total bucket size + bandwidth used (for budget tracking)
- Recent upload activity (confirms segments are arriving)
- API key activity (confirms credentials still working)

Configure B2 lifecycle rules on the bucket to manage retention without server-side coordination.

### Cloudflare Turnstile

Dashboard at [Cloudflare → Turnstile → your site](https://dash.cloudflare.com):

- Challenge volume + pass rate (sudden drop = something is breaking the widget)
- Failed-verification spikes (potential attack)

### Strapi blog

```bash
curl -s http://127.0.0.1:1337/_health    # if Strapi exposes a health endpoint
journalctl -u strapi -n 50               # systemd logs (if managed by systemd)
```

### LiveKit (the WebRTC backend — watch it like a streaming-critical service)

```bash
curl -s http://127.0.0.1:7880/             # LiveKit HTTP root
ss -tlnp | grep -E ":(7880|7882)"
```

LiveKit carries **all** live media ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)) — if it falls over, nobody can broadcast or watch. Treat a LiveKit alert as a streaming-down incident; see [`runbooks/livekit-disconnect.md`](runbooks/livekit-disconnect.md).

### coturn

```bash
sudo tail -f /var/log/turnserver/turnserver.log
sudo systemctl status coturn
```

`Bad credentials` spikes here suggest the TURN HMAC secret is stale (or being attacked). See [`runbooks/secret-rotation.md`](runbooks/secret-rotation.md).

## Logs to grep for specific issues

| Symptom | grep pattern |
|---------|--------------|
| Auth issues | `JWT` / `verifyToken` / `401` |
| LiveKit connect/disconnect churn | `livekit` / `LiveKitService` / `ParticipantDisconnected` |
| Recording uploads stuck | `RecordingUploadScheduler` / `B2 upload` |
| Account deletion runs | `DELETION SCHEDULER` |
| Moderation actions | `🔨 MODERATION` / `🚫 MODERATION` |
| Connection from banned IP | `🚫 CONNECTION` |
| Stream takeover events | `TAKEOVER` |
| Chatbot LLM failures | `ChatBotLLMService` / `Ollama` / `Groq` |
| Transcription | `TRANSCRIPTION` / `whisper` |
| Viewbot rotation | `ROTATION` / `viewbot` |

Example:

```bash
pm2 logs onestreamer-server | grep -i "DELETION SCHEDULER" | head -20
pm2 logs onestreamer-server --lines 1000 --nostream | grep -E "(error|⚠️|❌)" | head -50
```

## Synthetic checks

The cheapest meaningful end-to-end check: confirm signup → broadcast still works. Automated via Playwright or similar — script:

1. Hit `/health` (expect 200)
2. POST `/auth/signup` with a test user + Turnstile test token (expect 200)
3. Open a Socket.IO connection with the returned JWT, emit `join-as-viewer`, expect `stream-status` within 2 s
4. Disconnect, delete the test user via admin API

Run on a 5-minute interval; page on three consecutive failures.

## Metrics OneStreamer exposes itself

[`ResourceMonitor.js`](../../server/services/ResourceMonitor.js) tracks CPU + memory + disk on a 5-second loop and logs warnings when thresholds are exceeded. The thresholds are configurable via env vars (`STATS_INTERVAL`, `ENABLE_METRICS`).

For a more structured metrics surface (Prometheus-style), nothing is built today. The cleanest add would be an Express-middleware metrics collector (e.g. `prom-client`) exposing `/metrics` for scraping. Captured as a follow-up.

## Alerting recommendations

Even without a metrics stack, three cheap alerts catch most real incidents:

1. **`/health` failures (3 consecutive)** — service is down.
2. **Disk free below 10 GB** — recording accumulation or log rotation lag.
3. **`onestreamer-server` PM2 restart count rises** — something is crashing repeatedly.

Healthchecks.io + a cron-fed cURL is the lowest-friction way to wire this up. Wire whichever paging system you already use; for a single-host single-operator setup, even just email is fine.

## See also

- [`deployment.md`](deployment.md) — topology and process list
- [`runbooks/`](runbooks/) — what to do when a specific symptom shows up
- [`backup-restore.md`](backup-restore.md) — what to do when monitoring tells you it's already too late
