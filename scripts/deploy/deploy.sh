#!/usr/bin/env bash
#
# OneStreamer container deploy (ADR-0026). Run ON the VPS by the CircleCI
# `deploy` job over SSH, as the least-privilege `deploy` user:
#
#   IMAGE='ghcr.io/realrogerwinter/onestreamer-app@sha256:…' \
#   RELEASE_SHA='<git-sha>' bash ~/onestreamer-deploy/deploy.sh
#
# Privilege model (see docs/operations/deployment.md + the runbook):
#   * `deploy` is in the `docker` group for docker / docker compose. NOTE: docker-
#     group membership is ROOT-EQUIVALENT — treat the deploy SSH key as a host-root
#     credential (rotate it, restrict the CircleCI context, ideally IP-allowlist the
#     source). See ADR-0026's honest note.
#   * Keep the sudo allowlist tiny — /etc/sudoers.d/onestreamer-deploy:
#       deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -t, /usr/bin/systemctl reload nginx, \
#         /usr/bin/pm2 delete onestreamer-server onestreamer-chat, /usr/bin/pm2 save
#   * /backups is owned by uid 1001 (the backup container writes as 1001).
#   * /var/www/html is owned by `deploy` (nginx only READS it) — so no `sudo rsync`.
#
# Flow: flock -> pull-by-digest -> backup (in-container, uid 1001) -> ensure PM2
#       down -> publish client -> stop-old/start-new (PidMode!=host guard) ->
#       verify dependency signals -> rollback-on-ANY-failure. NEVER restarts PM2.
#
# No `set -e`: failures are handled explicitly so rollback always runs (incl. the
# health-timeout path).
set -uo pipefail

ONESTREAMER_HOME="${ONESTREAMER_HOME:-/root/onestreamer}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yaml}"
CLIENT_BUILD_SRC="${CLIENT_BUILD_SRC:-$DEPLOY_DIR/client-build/}"
WEB_ROOT="${WEB_ROOT:-/var/www/html}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
LOCK="${LOCK:-/var/lock/onestreamer-deploy.lock}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
MIN_FREE_MB="${MIN_FREE_MB:-4096}"          # require this much free in BACKUP_DIR
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"     # seconds to reach healthy before rollback
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"  # optional nginx-proxied check

: "${IMAGE:?IMAGE (immutable registry digest ref) is required}"
RELEASE_SHA="${RELEASE_SHA:-unknown}"
export IMAGE ONESTREAMER_HOME

log(){ echo "[deploy $(date +%H:%M:%S)] $*"; }
die(){ echo "[deploy ERROR] $*" >&2; exit 1; }   # use BEFORE any container change

# ── serialize (single-writer WAL DB — never overlap deploys) ─────────────────
exec 9>"$LOCK" || die "cannot open lock $LOCK"
flock -n 9     || die "another deploy holds $LOCK — aborting"
log "acquired deploy lock"

PREV_IMAGE=""
rollback(){
  log "ROLLBACK → previous image: ${PREV_IMAGE:-<none>}"
  if [ -n "$PREV_IMAGE" ]; then
    docker pull "$PREV_IMAGE" || true
    IMAGE="$PREV_IMAGE" docker compose -f "$COMPOSE_FILE" up -d --remove-orphans || true
    log "rolled back image. A schema-changing release ALSO needs a DB restore from"
    log "     $BACKUP_DIR (announced data loss) — NOT done automatically. See the runbook."
  else
    log "no previous image recorded — manual intervention required."
  fi
}
# use AFTER containers have been touched: roll back, then exit non-zero.
fail(){ log "$*"; rollback; echo "[deploy ERROR] $*" >&2; exit 1; }

# ── 1. previous image as a PULLABLE digest ref (for rollback) ────────────────
# RepoDigests is an IMAGE field, not a CONTAINER field — inspecting the container
# for it always yields "" (rollback then has no target). Resolve in two hops:
# container -> .Image (image id) -> that image's .RepoDigests.
PREV_IMG_ID="$(docker inspect --format '{{.Image}}' onestreamer-server 2>/dev/null || true)"
PREV_IMAGE="$(docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$PREV_IMG_ID" 2>/dev/null || true)"
log "previous server image: ${PREV_IMAGE:-<none>}"

# ── 2. pull the new image by digest (before backup → backup uses a known image)
log "pulling $IMAGE"
docker pull "$IMAGE" || die "docker pull failed (nothing changed yet)"

# ── 3. WAL-consistent DB backup, in-container as uid 1001 (no sudo) ──────────
FREE_MB="$(df -Pm "$BACKUP_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
[ "${FREE_MB:-0}" -ge "$MIN_FREE_MB" ] || die "low space in $BACKUP_DIR (${FREE_MB:-0} MB free, need >= ${MIN_FREE_MB})"
log "backing up DB (in-container, uid 1001) -> $BACKUP_DIR"
docker run --rm --user 1001:1001 \
  -v "$ONESTREAMER_HOME/server/data:/data:ro" -v "$BACKUP_DIR:/out" \
  -e RELEASE_SHA="$RELEASE_SHA" -e KEEP_BACKUPS="$KEEP_BACKUPS" \
  -e DB_PATH=/data/onestreamer.db -e OUT_DIR=/out \
  --entrypoint node "$IMAGE" scripts/deploy/db-backup.js \
  || die "DB backup failed — aborting before touching containers"

# ── 4. ensure the PM2 processes are gone (one-time cutover; idempotent) ──────
# Kill means kill — rollback never restarts PM2; the old PM2 processes stay dead.
sudo pm2 delete onestreamer-server onestreamer-chat >/dev/null 2>&1 || true
sudo pm2 save >/dev/null 2>&1 || true

# ── 5. publish the client bundle (deploy owns $WEB_ROOT; nginx only reads it) ─
if [ -d "$CLIENT_BUILD_SRC" ]; then
  log "publishing client bundle -> $WEB_ROOT"
  rsync -a --no-owner --no-group "$CLIENT_BUILD_SRC" "$WEB_ROOT/" || die "client rsync failed (is $WEB_ROOT owned by the deploy user?)"
  sudo nginx -t && sudo systemctl reload nginx || die "nginx reload failed"
else
  log "WARN: no staged client bundle at $CLIENT_BUILD_SRC — skipping frontend publish"
fi

# ── 6. stop-old -> start-new (never two writers on the WAL DB) ───────────────
log "recreating containers from $IMAGE"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans || fail "compose up failed"

# Guard: the app runs pkill ffmpeg/chrome — host PID namespace would reap the
# co-located livekit-egress + neighbouring containers.
for c in onestreamer-server onestreamer-chat; do
  pm="$(docker inspect --format '{{.HostConfig.PidMode}}' "$c" 2>/dev/null || echo '')"
  [ "$pm" = "host" ] && fail "$c has PidMode=host — refusing deploy"
done

# ── 7. verify dependency-touching signals (NOT /health alone) ────────────────
log "verifying health + dependency signals (timeout ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT )); healthy=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  ok=1
  curl -fsk https://127.0.0.1:8443/health >/dev/null 2>&1 || ok=0
  curl -fsk https://127.0.0.1:8444/health >/dev/null 2>&1 || ok=0
  if [ "$ok" = 1 ]; then
    logs="$(docker logs --since 10m onestreamer-server 2>&1 || true)"
    echo "$logs" | grep -q "WEBRTC: LiveKit backend initialized" || ok=0
    echo "$logs" | grep -Eq "Continuing without LiveKit|LIVEKIT: Initialization failed" && ok=0
  fi
  [ "$ok" = 1 ] && { healthy=1; break; }
  sleep 5
done
[ "$healthy" = 1 ] || fail "did not reach healthy state (LiveKit/Redis init or HTTPS bind) — see: docker logs onestreamer-server"

if [ -n "$PUBLIC_HEALTH_URL" ]; then
  curl -fsk "$PUBLIC_HEALTH_URL" >/dev/null 2>&1 || log "WARN: $PUBLIC_HEALTH_URL not reachable — check nginx"
fi

log "✅ deploy OK — $IMAGE (sha $RELEASE_SHA)"
log "Run the manual streaming smoke test (2 browsers + egress->clip) per the runbook."
