# LiveKit disconnect

_Last verified: 2026-05-23 against commit 4a1d325._

> [!NOTE]
> LiveKit is currently **dormant** in production — see [ADR-0002](../../architecture/adr/0002-mediasoup-primary-livekit-dormant.md). This runbook is for the scenario where LiveKit has been revived and is in the active streaming path (i.e. `WEBRTC_BACKEND=livekit`), or where dormant LiveKit infrastructure is itself producing alerts. If you're seeing stream issues today, you almost certainly want [`stream-stuck.md`](stream-stuck.md) instead, since the production WebRTC path is MediaSoup.

## Symptoms

- Browser console: `WebSocket connection to wss://livekit.onestreamer.live/rtc failed`
- Browser console: `[livekit-client] Could not connect to LiveKit`
- LiveKit server logs (`journalctl -u livekit`): `ws upgrade failed` / `unauthorized` / repeated `room not found`
- Viewers report black video; streamer says they're broadcasting
- Recording pipeline (which can use LiveKit Egress) stops producing segments

## How to confirm

1. **Is LiveKit actually in the active path?**
   ```bash
   pm2 env onestreamer-server | grep WEBRTC_BACKEND
   ```
   If unset or `mediasoup` → LiveKit is dormant; this isn't your issue. Go to [`stream-stuck.md`](stream-stuck.md).
2. **Is the LiveKit server running?**
   ```bash
   curl -s http://127.0.0.1:7880/         # LiveKit HTTP root
   ss -tlnp | grep -E ":(7880|7882)"       # ports bound
   systemctl status livekit                # if managed by systemd
   ```
3. **Can the main server reach LiveKit?**
   ```bash
   curl -s http://127.0.0.1:7882/twirp/livekit.RoomService/ListRooms \
     -H "Authorization: Bearer <livekit-jwt>" -d '{}'
   ```
4. **Is the WebSocket-upgrade path through nginx working?**
   ```bash
   sudo tail -n 100 /var/log/nginx/error.log | grep -E "(livekit|upgrade)"
   ```
5. **Are LiveKit credentials still valid?**
   ```bash
   pm2 env onestreamer-server | grep -E "LIVEKIT_(API_KEY|API_SECRET)"
   ```
   Should not be the literal `devkey` / `secret` in production.

## Likely causes

Ranked by probability when LiveKit is active:

### 1. WebSocket upgrade failing at nginx

The nginx config has explicit WebSocket settings for `/livekit/rtc` with 7-day timeouts. Verify:

```nginx
location /livekit/rtc {
    proxy_pass http://[::1]:7882/rtc;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    ...
}
```

If `proxy_set_header Upgrade` or `Connection "upgrade"` is missing or wrong, the WebSocket upgrade fails. Reload after fix:

```bash
sudo nginx -t && sudo nginx -s reload
```

### 2. LiveKit server crashed / not running

Restart and check for boot errors:

```bash
sudo systemctl restart livekit
sudo systemctl status livekit
journalctl -u livekit -n 50
```

### 3. Token signing mismatch

LiveKit tokens are signed with `LIVEKIT_API_SECRET` and validated server-side. If the OneStreamer server signs with one secret and the LiveKit server expects another, every connect fails with `unauthorized`. Confirm both sides see the same value:

```bash
# OneStreamer's view
pm2 env onestreamer-server | grep LIVEKIT_API_SECRET

# LiveKit server's view (depends on how you configured it — usually a config.yaml)
sudo grep -A2 "keys:" /etc/livekit/config.yaml
```

### 4. Default `devkey` / `secret` in production

If the env vars resolve to `devkey` / `secret`, anyone can mint tokens against your LiveKit server, *and* OneStreamer might be using the wrong pair. Rotate per [`secret-rotation.md`](secret-rotation.md).

### 5. CGNAT or restrictive client network

Mobile 4G/5G clients sometimes can't reach the LiveKit WebSocket through CGNAT. LiveKit has its own TURN; verify it's enabled:

```bash
pm2 env onestreamer-server | grep LIVEKIT_TURN_ENABLED
```

Set `LIVEKIT_TURN_ENABLED=true` if not already.

### 6. The Sept-2025 dual-stack issue returned

The original dual-stack rollback (see [`/docs/archive/livekit/`](../../archive/livekit/) and [ADR-0003](../../architecture/adr/0003-livekit-dual-stack-rollback.md)) was triggered by WebSocket connectivity problems. If you re-enabled the dual-stack and the same symptoms appeared, this may be the same class of bug. Consider rolling back via:

```bash
# Edit .env: WEBRTC_BACKEND=mediasoup
pm2 restart onestreamer-server --update-env
```

…and update ADR-0002 / ADR-0003 with what you learned.

## Resolution

In order of escalation:

1. **Restart LiveKit**: `sudo systemctl restart livekit`. Many transient connectivity issues resolve.
2. **Reload nginx**: `sudo nginx -t && sudo nginx -s reload`. Catches stale WebSocket-upgrade config.
3. **Restart the main server**: `pm2 restart onestreamer-server --update-env`. Refreshes any cached LiveKit tokens.
4. **Roll back to MediaSoup-only**: edit `.env`, set `WEBRTC_BACKEND=mediasoup`, restart. This is the safe fallback per ADR-0002.
5. **If using dormant LiveKit infrastructure** (i.e. you haven't reverted ADR-0002 and shouldn't be seeing LiveKit at all): confirm `WEBRTC_BACKEND` isn't accidentally set; if dormant LiveKit is producing log noise but no user impact, you can `sudo systemctl stop livekit` to silence it.

## Prevention

- **Document the dual-stack revival decision** in a new ADR that supersedes ADR-0002/0003 before flipping it back on. Capture the new test/verification steps so this runbook can be updated with the actual symptoms you observe.
- **Monitor LiveKit health** alongside the rest of the stack (see [`monitoring.md`](../monitoring.md)).
- **Don't ship default credentials.** `devkey` / `secret` are well-known LiveKit defaults; production must override.

## See also

- [ADR-0002](../../architecture/adr/0002-mediasoup-primary-livekit-dormant.md) — current LiveKit status
- [ADR-0003](../../architecture/adr/0003-livekit-dual-stack-rollback.md) — what the dual-stack attempt taught us
- [`/docs/archive/livekit/`](../../archive/livekit/) — historical fix notes from the rollback
- [`stream-stuck.md`](stream-stuck.md) — likely the right runbook if LiveKit isn't active
