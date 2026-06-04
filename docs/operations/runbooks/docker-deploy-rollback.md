# Docker deploy & rollback (container era — ADR-0025/0026)

_Last verified: 2026-06-04 against commit <sha>._

How the containerized app deploys and how to roll it back. The app runs as two
host-networked containers (`onestreamer-server` :8443, `onestreamer-chat` :8444)
from one image; see [ADR-0025](../../architecture/adr/0025-docker-replaces-pm2.md).

## Normal deploy (automated)

`main` → CircleCI builds + tests + scans → pushes the image to GHCR by digest →
**manual approval** in the CircleCI UI → the `deploy` job SSHes to the VPS as the
`deploy` user and runs `scripts/deploy/deploy.sh`, which:

1. takes `flock /var/lock/onestreamer-deploy.lock` (no overlapping deploys — the
   WAL DB is single-writer);
2. snapshots the DB with `sqlite3 .backup` to `/backups` (disk preflight, keep-5);
3. ensures the old PM2 processes are gone (idempotent);
4. `docker pull`s the image **by digest**;
5. rsyncs the client bundle to `/var/www/html` (no `--delete`) + `nginx -t && reload`;
6. recreates both containers (`docker compose up -d`), refusing any `PidMode=host`;
7. verifies dependency-touching signals (below) and rolls back on failure.

## How to confirm a deploy is healthy

`/health` is static `{status:OK}` — a swallowed LiveKit/Redis failure still
returns 200. Always check the dependency signals:

```bash
curl -fsk https://127.0.0.1:8443/health          # {"status":"OK"} — NOT ingress's plaintext :8080
curl -fsk https://127.0.0.1:8444/health          # chat
docker logs --since 10m onestreamer-server | grep -E "WEBRTC: LiveKit backend initialized|Connected to Redis"
docker logs --since 10m onestreamer-server | grep -E "Continuing without LiveKit|LIVEKIT: Initialization failed"   # MUST be empty
docker ps --filter name=onestreamer --format '{{.Names}}\t{{.Status}}'
```

Then the **streaming smoke test** (the real proof — see `first-stream.md`): two
browsers on the site → take over (publish) → watch from the 2nd (subscribe);
trigger a viewbot URL-relay (ingress logs show an RTMP session); confirm a new
`egress-recordings/recording_<date>/` dir grows and a clip mp4 lands in `clips/`;
`GET /api/turn/credentials` returns fresh HMAC iceServers.

## Manual deploy / rollback

```bash
# On the VPS as the deploy user. IMAGE must be an immutable digest ref.
IMAGE='ghcr.io/realrogerwinter/onestreamer-app@sha256:<digest>' \
RELEASE_SHA='<git-sha>' bash ~/onestreamer-deploy/deploy.sh

# Roll back to the previous image (NON-schema releases only):
docker images --digests ghcr.io/realrogerwinter/onestreamer-app   # find the prior digest
IMAGE='ghcr.io/realrogerwinter/onestreamer-app@sha256:<prev>' bash ~/onestreamer-deploy/deploy.sh
```

**Schema-changing releases cannot be cleanly image-rolled-back** — migrations are
forward-only with no down-migrations (ADR-0022). The only true rollback is
restoring the pre-deploy snapshot, which **discards all writes since the deploy**:

```bash
docker compose -f ~/onestreamer-deploy/compose.yaml down
sudo cp /backups/onestreamer-<sha>-<ts>.db /root/onestreamer/server/data/onestreamer.db   # announced data loss
IMAGE='…@sha256:<prev>' bash ~/onestreamer-deploy/deploy.sh
```

This is a deliberate, announced decision — never an automatic "if suspected" branch.

## Hard rules

- **Never `ufw allow 8443 / 8444 / 8081`.** The app binds `127.0.0.1` (`BIND_ADDR`)
  and nginx is the sole public ingress; opening those ports exposes the app
  directly (and stream-control auth still defaults off).
- **Never run the containers with `--pid=host`.** The app runs `pkill ffmpeg` /
  `pkill chrome`; the host PID namespace would reap livekit-egress and other
  containers. `deploy.sh` refuses `PidMode=host`.
- **Kill means kill.** Once PM2 is retired at cutover, do not re-add the app to
  PM2. Rollback re-runs the previous *image*, never PM2.

## One-time cutover (PM2 → containers)

1. Dry-run the image on alt ports first (no prod takeover):
   `docker run --rm --network host -e USE_HTTPS=false -e PORT=18080 -e BIND_ADDR=127.0.0.1 --env-file /etc/onestreamer/app.env <image>` →
   confirm `LiveKit backend initialized` + `Connected to Redis` in the logs, then stop it.
2. Free the ports: `sudo pm2 delete onestreamer-server onestreamer-chat && sudo pm2 save`
   (under root's PM2). Leave `pm2-logrotate` and Strapi running.
3. Bring up the containers (`deploy.sh`), verify (above). Do **not** restart PM2.

## Prevention

- Deploy verification asserts the LiveKit/Redis init lines, so a silent-degrade
  boot fails the deploy instead of shipping a dead streaming backend green.
- `flock` + stop-old/start-new prevent two writers on the WAL DB.
- Pre-deploy `sqlite3 .backup` + retention gives a known-good restore point.
