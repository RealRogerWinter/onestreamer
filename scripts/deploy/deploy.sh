#!/usr/bin/env bash
#
# OneStreamer container deploy (ADR-0026). Run ON the VPS by the CircleCI
# `deploy` job over SSH, as the least-privilege `deploy` user:
#
#   IMAGE='ghcr.io/realrogerwinter/onestreamer-app@sha256:…' \
#   RELEASE_SHA='<git-sha>' bash ~/onestreamer-deploy/deploy.sh
#
# Privileges the deploy user needs (see docs/operations/deployment.md):
#   * member of the `docker` group (docker / docker compose)
#   * a scoped sudoers allowlist: sqlite3, stat, rsync, nginx, systemctl reload
#     nginx, pm2  (each only as needed below)
#
# Flow: flock → backup DB → ensure PM2 down → pull-by-digest → publish client
#       → stop-old/start-new (private PID ns) → verify dependency signals →
#       rollback-on-failure. NEVER restarts PM2 (kill means kill).
set -euo pipefail

# ── config ──────────────────────────────────────────────────────────────────
ONESTREAMER_HOME="${ONESTREAMER_HOME:-/root/onestreamer}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yaml}"
CLIENT_BUILD_SRC="${CLIENT_BUILD_SRC:-$DEPLOY_DIR/client-build/}"
WEB_ROOT="${WEB_ROOT:-/var/www/html}"
DB="${DB:-$ONESTREAMER_HOME/server/data/onestreamer.db}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
LOCK="${LOCK:-/var/lock/onestreamer-deploy.lock}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"     # seconds to reach healthy before rollback
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"  # optional nginx-proxied check, e.g. https://<domain>/health

: "${IMAGE:?IMAGE (immutable registry digest ref) is required}"
RELEASE_SHA="${RELEASE_SHA:-unknown}"
export IMAGE ONESTREAMER_HOME

log(){ echo "[deploy $(date +%H:%M:%S)] $*"; }
die(){ echo "[deploy ERROR] $*" >&2; exit 1; }

# ── 0. serialize (single-writer WAL DB — never overlap deploys) ──────────────
exec 9>"$LOCK" || die "cannot open lock $LOCK"
flock -n 9     || die "another deploy holds $LOCK — aborting"
log "acquired deploy lock"

PREV_IMAGE=""
rollback(){
  log "ROLLBACK → previous image: ${PREV_IMAGE:-<none>}"
  if [ -n "$PREV_IMAGE" ]; then
    IMAGE="$PREV_IMAGE" docker compose -f "$COMPOSE_FILE" up -d --remove-orphans || true
    log "rolled back image. NOTE: a schema-changing release also needs a DB restore"
    log "     from $BACKUP_DIR (announced data loss) — NOT done automatically. See runbook."
  else
    log "no previous image recorded — manual intervention required."
  fi
}

# ── 1. record current image for rollback ─────────────────────────────────────
PREV_IMAGE="$(docker inspect --format '{{.Image}}' onestreamer-server 2>/dev/null || true)"
log "previous server image: ${PREV_IMAGE:-<none>}"

# ── 2. WAL-consistent DB backup (bounded, retained) ──────────────────────────
if sudo test -f "$DB"; then
  DB_BYTES="$(sudo stat -c %s "$DB")"
  FREE_BYTES="$(df -P --block-size=1 "$BACKUP_DIR" | awk 'NR==2{print $4}')"
  NEED=$(( DB_BYTES * 12 / 10 ))   # require ≥ 1.2× the DB size free
  [ "${FREE_BYTES:-0}" -ge "$NEED" ] || die "low space in $BACKUP_DIR (need ~$NEED B, have ${FREE_BYTES:-0} B)"
  BK="$BACKUP_DIR/onestreamer-${RELEASE_SHA}-$(date +%Y%m%d%H%M%S).db"
  log "backing up DB → $BK ($(( DB_BYTES/1024/1024 )) MB, single .backup snapshot)"
  sudo sqlite3 "$DB" ".backup '$BK'"
  sudo sh -c "ls -1t '$BACKUP_DIR'/onestreamer-*.db 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -f"
else
  log "WARN: DB $DB not found — skipping backup (first deploy?)"
fi

# ── 3. ensure the PM2 processes are gone (free 8443/8444/8081) ───────────────
# First deploy retires PM2; idempotent thereafter. "Kill means kill" — rollback
# never restarts PM2; the old PM2-managed processes stay dead.
sudo pm2 delete onestreamer-server onestreamer-chat >/dev/null 2>&1 || true
sudo pm2 save --force >/dev/null 2>&1 || true

# ── 4. pull the new image by immutable digest ────────────────────────────────
log "pulling $IMAGE"
docker pull "$IMAGE"

# ── 5. publish the client bundle to the nginx docroot ────────────────────────
# No --delete: preserve /var/www/html/blog, turn-test.html, etc.
if [ -d "$CLIENT_BUILD_SRC" ]; then
  log "publishing client bundle → $WEB_ROOT"
  sudo rsync -a --no-owner --no-group "$CLIENT_BUILD_SRC" "$WEB_ROOT/"
  sudo nginx -t && sudo systemctl reload nginx
else
  log "WARN: no staged client bundle at $CLIENT_BUILD_SRC — skipping frontend publish"
fi

# ── 6. stop-old → start-new (never two writers on the WAL DB) ─────────────────
trap 'rollback' ERR
log "recreating containers from $IMAGE"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

# Guard: the app runs `pkill ffmpeg/chrome` — host PID namespace would reap the
# co-located livekit-egress + neighbouring containers. Refuse if set.
for c in onestreamer-server onestreamer-chat; do
  pm="$(docker inspect --format '{{.HostConfig.PidMode}}' "$c" 2>/dev/null || echo '')"
  [ "$pm" = "host" ] && die "$c has PidMode=host — refusing deploy"
done

# ── 7. verify dependency-touching signals (NOT /health alone) ─────────────────
# /health is static {status:OK}; a swallowed LiveKit/Redis failure still serves
# 200. Assert the init log lines + both HTTPS health endpoints.
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
[ "$healthy" = 1 ] || die "did not reach healthy state (LiveKit/Redis init or HTTPS bind) — see: docker logs onestreamer-server"
trap - ERR

# Optional: prove the nginx public path (set PUBLIC_HEALTH_URL in the deploy env).
if [ -n "$PUBLIC_HEALTH_URL" ]; then
  curl -fsk "$PUBLIC_HEALTH_URL" >/dev/null 2>&1 || log "WARN: $PUBLIC_HEALTH_URL not reachable — check nginx"
fi

log "✅ deploy OK — $IMAGE (sha $RELEASE_SHA)"
log "Run the manual streaming smoke test (2 browsers + egress→clip) per the runbook."
