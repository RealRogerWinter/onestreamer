# LiveKit disconnect

_Last verified: 2026-05-23 against commit 4a1d325._

> [!NOTE]
> **LiveKit is the sole WebRTC backend** ([ADR-0024](../../architecture/adr/0024-retire-mediasoup-livekit-only.md)) — every live media path (primary streamer↔viewer, URL-stream relay via ingress, recording via egress, transcription) runs through it. A LiveKit-class outage is a **total streaming outage**: nobody can broadcast or watch. This is a primary streaming runbook. If the symptoms point upstream of LiveKit (a single stuck source, a wedged ingress/egress) rather than the LiveKit server itself, [`stream-stuck.md`](stream-stuck.md) and [`livekit-ingress-not-connected.md`](livekit-ingress-not-connected.md) are the more specific runbooks.

## Symptoms

- Browser console: `WebSocket connection to wss://livekit.onestreamer.live/rtc failed`
- Browser console: `[livekit-client] Could not connect to LiveKit`
- LiveKit server logs (`journalctl -u livekit`): `ws upgrade failed` / `unauthorized` / repeated `room not found`
- Viewers report black video; streamer says they're broadcasting
- Recording pipeline (LiveKit Egress) stops producing segments

## How to confirm

1. **Is the LiveKit server running?**
   ```bash
   curl -s http://127.0.0.1:7880/         # LiveKit HTTP root
   ss -tlnp | grep -E ":(7880|7882)"       # ports bound
   systemctl status livekit                # if managed by systemd
   ```
2. **Can the main server reach LiveKit?**
   ```bash
   curl -s http://127.0.0.1:7882/twirp/livekit.RoomService/ListRooms \
     -H "Authorization: Bearer <livekit-jwt>" -d '{}'
   ```
3. **Is the WebSocket-upgrade path through nginx working?**
   ```bash
   sudo tail -n 100 /var/log/nginx/error.log | grep -E "(livekit|upgrade)"
   ```
4. **Are LiveKit credentials still valid?**
   ```bash
   pm2 env onestreamer-server | grep -E "LIVEKIT_(API_KEY|API_SECRET)"
   ```
   Should not be the literal `devkey` / `secret` in production.

## Likely causes

Ranked by probability:

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

### 6. A WebSocket-connectivity regression (the Sept-2025 class of bug)

The Sept-2025 dual-stack rollback (see [`/docs/archive/livekit/`](../../archive/livekit/) and [ADR-0003](../../architecture/adr/0003-livekit-dual-stack-rollback.md)) was triggered by WebSocket connectivity problems through nginx. Those same symptoms — failed `/livekit/rtc` upgrades, clients that connect then immediately drop — recur whenever the nginx upgrade headers or LiveKit's announced address regress. Re-check cause #1 (nginx upgrade config) and the `livekit-config.yaml` RTC/UDP settings; there is **no in-process WebRTC fallback** to fail over to anymore ([ADR-0024](../../architecture/adr/0024-retire-mediasoup-livekit-only.md)).

## Resolution

In order of escalation:

1. **Restart LiveKit**: `sudo systemctl restart livekit`. Many transient connectivity issues resolve.
2. **Reload nginx**: `sudo nginx -t && sudo nginx -s reload`. Catches stale WebSocket-upgrade config.
3. **Restart the main server**: `pm2 restart onestreamer-server --update-env`. Refreshes any cached LiveKit tokens.
4. **Last resort — roll back to the pre-retirement build.** LiveKit is the only backend ([ADR-0024](../../architecture/adr/0024-retire-mediasoup-livekit-only.md)); there is no env flip to a second stack. If a recent deploy broke LiveKit integration and the steps above don't recover it, redeploy the last-known-good tagged build per [`deployment.md`](../deployment.md).

## Prevention

- **Monitor LiveKit health** alongside the rest of the stack (see [`monitoring.md`](../monitoring.md)) — because it carries all live media, treat a LiveKit alert as a streaming-down alert.
- **Smoke-test ingress and egress on every deploy**, not just a takeover: start a URL relay (ingress) and confirm a recording starts (egress).
- **Don't ship default credentials.** `devkey` / `secret` are well-known LiveKit defaults; production must override.

## See also

- [ADR-0024](../../architecture/adr/0024-retire-mediasoup-livekit-only.md) — LiveKit as the sole WebRTC backend (MediaSoup retired)
- [ADR-0003](../../architecture/adr/0003-livekit-dual-stack-rollback.md) — what the Sept-2025 dual-stack attempt taught us (historical)
- [`/docs/archive/livekit/`](../../archive/livekit/) — historical fix notes from the rollback
- [`livekit-ingress-not-connected.md`](livekit-ingress-not-connected.md) — when RTMP never reaches the ingress
- [`stream-stuck.md`](stream-stuck.md) — a single source/relay is wedged but LiveKit itself is healthy
