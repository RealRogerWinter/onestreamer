# LiveKit ingress not connected

_Last verified: 2026-05-26 against commit 539fa75._

## Symptoms

- OneStreamer server log:
  ```
  ❌ LIVEKIT VIEWBOT url-stream-<id>: Failed to create ingress:
  TwirpError [Internal Server Error]: twirp error unknown: ingress not connected (redis required)
  ❌ Failed to start URL stream <id>: Error: Failed to create LiveKit ingress - no stream key returned
  ```
- URL-stream relay attempts (Twitch, Kick, YouTube, direct HLS) all fail at `_startLiveKitStream`, immediately after `🎥 Starting LiveKit pipeline for url-stream-…`.
- Or — browser sees 502 from `/livekit/rtc` after a fresh deploy, even though `systemctl status livekit` says `active (running)`.

## How to confirm

```bash
# 1. Is livekit-ingress actually running?
sudo docker ps --filter name=livekit-ingress --format '{{.Names}}: {{.Status}}'

# 2. Does livekit-server know about the ingress node? Both must share Redis.
grep -A1 '^redis:' /root/onestreamer/livekit-config.yaml
grep -A1 'redis:' /root/onestreamer/ingress-config.yaml
redis-cli ping                 # should reply PONG

# 3. What ports is livekit-server bound to?
ss -tlnp | grep ':7882'        # need BOTH 127.0.0.1 AND [::1]

# 4. Does nginx proxy_pass match the bind?
grep -A1 'location.*livekit' /etc/nginx/sites-available/onestreamer.live | head
```

## Likely causes

Ranked by what we've actually hit during the May 2026 revival:

### 1. `redis:` section missing from `livekit-config.yaml`

livekit-server and the ingress/egress containers coordinate via Redis. Without a Redis section the server runs **single-node** and the ingress node is invisible to it — `createIngress` returns `twirp error unknown: ingress not connected (redis required)`. The shipped [`config/livekit-config.example.yaml`](../../../config/livekit-config.example.yaml) includes this section; deployments derived from older snapshots may not.

**Fix:**

```yaml
# Append to /root/onestreamer/livekit-config.yaml
redis:
  address: 127.0.0.1:6379
```

Then `sudo systemctl restart livekit && sudo docker restart livekit-ingress livekit-egress`. The two containers must reattach after the server registers itself in Redis.

### 2. `bind_addresses` is IPv4-only but nginx proxies via IPv6 loopback

The nginx vhost in this deployment proxies `/livekit/*` to `http://[::1]:7882`. If livekit-config.yaml binds only `127.0.0.1`, browsers hit `https://onestreamer.live/livekit/rtc` and get **502 Bad Gateway** — `ss -tlnp | grep 7882` will show one IPv4 listener and no IPv6.

**Fix:**

```yaml
# livekit-config.yaml
port: 7882
bind_addresses:
  - "127.0.0.1"
  - "::1"
```

Restart: `sudo systemctl restart livekit`. Verify both lines appear in `ss -tlnp | grep 7882`.

### 3. Ingress / egress containers stopped

`livekit-ingress` and `livekit-egress` run as Docker containers with `restart: unless-stopped`. If something manually stopped them (or a host reboot before docker daemon came up), they stay down. The compose-equivalent pieces of state still live in `/root/onestreamer/ingress-config.yaml` and the egress container's mount config.

> Note (audit S4/D3): `ingress-config.yaml` / `egress-config.yaml` are **gitignored** — only the sanitized `*.example` templates are tracked. On a fresh clone, `cp ingress-config.yaml.example ingress-config.yaml` (and egress likewise) and fill in the real LiveKit `api_key`/`api_secret` before starting the containers.

**Fix:**

```bash
sudo docker start livekit-ingress livekit-egress
sudo docker logs --tail 30 livekit-ingress    # confirm "starting WHIP server" / RTMP listener
ss -tlnp | grep ':1935'                       # RTMP must be listening
```

The ingress container's startup `ERROR ... WHIP server start failed: listen tcp :8080: bind: address already in use` is **expected and non-fatal** here — port 8080 is OneStreamer's main server. The container falls back to RTMP-only mode, which is the path our pipeline actually uses.

### 4. Stale ingress nodes in Redis after a restart sequence

If you restart livekit-ingress before livekit-server, or vice versa in a tight loop, the Redis key registry can get into a state where the server sees a stale node ID. Symptom: `createIngress` returns success once, then fails on the next call.

**Fix:**

```bash
redis-cli KEYS 'ingress*' | xargs -r redis-cli DEL
sudo docker restart livekit-ingress
```

### 5. Redis itself isn't running

```bash
sudo systemctl status redis-server          # or redis on some distros
redis-cli ping
```

If down: `sudo systemctl start redis-server`. Both LiveKit components will reconnect automatically on the next poll.

## Resolution

In order of escalation:

1. Confirm Redis is running (`redis-cli ping`).
2. Confirm `redis:` is in `livekit-config.yaml`. Add it if not.
3. Confirm `bind_addresses` includes both `127.0.0.1` and `::1`. Add `::1` if not.
4. `sudo systemctl restart livekit && sleep 2 && sudo docker restart livekit-ingress livekit-egress`.
5. Wait 5 s, then `pm2 restart onestreamer-server --update-env` so it re-resolves the ingress endpoint.
6. Trigger a URL stream from the admin panel and tail logs for `✅ Plain RTP ${kind} producer created` and `🎯 CONTINUOUS RECORDING: Found URL stream publisher: <id>`. Both indicate end-to-end success.

## Prevention

- **Keep `config/livekit-config.example.yaml` as the source of truth.** Diff the example against the deployed `livekit-config.yaml` after any LiveKit-related PR.
- **Document the dual-bind requirement** in any new deployment guide. The default `bind_addresses: ["0.0.0.0"]` from upstream LiveKit examples is misleading for nginx-proxied deployments — `0.0.0.0` listens on IPv4 only; you need explicit `::1` for IPv6 loopback.
- **Treat the LiveKit triad (server + ingress + egress) as a single deploy unit.** When you restart one, plan to bounce the others within ~5 seconds so Redis registry stays consistent. Document the order in [`livekit-disconnect.md`](livekit-disconnect.md) if you find a sequence that's worth preserving.
- **Monitor `/health` on port 8082** (livekit-ingress) and the corresponding egress health endpoint. A `wget -q -O- http://127.0.0.1:8082/health` from cron + paging on non-`Healthy` would have surfaced the May-5-to-May-25 outage immediately.

## See also

- [ADR-0008](../../architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md) — why LiveKit is active again
- [`livekit-disconnect.md`](livekit-disconnect.md) — adjacent runbook for the *signal-path* failure mode (vs ingress-coordination here)
- [`secret-rotation.md`](secret-rotation.md) — replace `devkey` / `secret` before public traffic
