#!/usr/bin/env bash
#
# Nightly OFF-HOST SQLite backup for OneStreamer (audit D2.a — plan 03).
#
# What it does, in order (any failure => non-zero exit, so cron/systemd
# mail/alerting catches it — an unpushed backup must NOT count as success):
#   1. prechecks: sqlite3/gzip present, source DB readable, backup dir
#      writable, free-space floor (mirrors deploy.sh's MIN_FREE_MB pattern),
#      off-host push target configured (REQUIRED — this script exists to get
#      the backup OFF this host)
#   2. online-safe snapshot via `sqlite3 <db> ".backup <tmp>"` (WAL-consistent;
#      never a raw file copy)
#   3. `PRAGMA integrity_check` on the snapshot — a corrupt copy is discarded
#   4. gzip -> timestamped artifact  onestreamer-nightly-<UTC ts>.db.gz
#   5. off-host push (OFFHOST_PUSH_CMD or RSYNC_TARGET) — FAILS LOUD if the
#      push fails; the local artifact is kept so the operator can push by hand
#   6. local retention: keep newest $KEEP_BACKUPS nightly artifacts
#
# Env (all optional except the off-host target):
#   DB_PATH           source SQLite DB       (default /root/onestreamer/server/data/onestreamer.db)
#   BACKUP_DIR        local artifact dir     (default /backups/nightly)
#   KEEP_BACKUPS      newest N artifacts to keep locally (default 7)
#   MIN_FREE_MB       required free MB in BACKUP_DIR (default 4096, as deploy.sh)
#   SQLITE_BUSY_MS    sqlite3 busy timeout in ms (default 30000)
#   OFFHOST_PUSH_CMD  shell command run as: bash -c "<cmd> <artifact>" — the
#                     artifact path is appended, safely quoted, as the last
#                     argument (also exported as $BACKUP_ARTIFACT).
#                     e.g.  OFFHOST_PUSH_CMD='scp -q -i /root/.ssh/backup_ed25519'
#                           OFFHOST_PUSH_CMD='rclone copyto --b2-hard-delete=false'
#                     Takes precedence over RSYNC_TARGET when both are set.
#   RSYNC_TARGET      convenience alternative: rsync destination DIR, e.g.
#                     'backup@backup-host:/backups/onestreamer/'
#   LOCK_FILE         flock path (default $BACKUP_DIR/.nightly-db-backup.lock)
#
# Flags:
#   --dry-run   run every precheck and print the plan; write nothing, push
#               nothing. Still exits non-zero if a precheck fails (so you can
#               validate a crontab entry safely).
#   --help
#
# Exit codes: 0 ok · 2 usage/precheck · 3 snapshot failed · 4 integrity check
# failed · 5 gzip/rename failed · 6 off-host push failed/unconfigured.
#
# Install (operator, not this repo — see docs/operations/backup-restore.md):
#   crontab: scripts/ops/nightly-db-backup.cron.example
#   systemd: scripts/ops/nightly-db-backup.service.example + .timer.example
set -uo pipefail

DB_PATH="${DB_PATH:-/root/onestreamer/server/data/onestreamer.db}"
BACKUP_DIR="${BACKUP_DIR:-/backups/nightly}"
KEEP_BACKUPS="${KEEP_BACKUPS:-7}"
MIN_FREE_MB="${MIN_FREE_MB:-4096}"
SQLITE_BUSY_MS="${SQLITE_BUSY_MS:-30000}"
OFFHOST_PUSH_CMD="${OFFHOST_PUSH_CMD:-}"
RSYNC_TARGET="${RSYNC_TARGET:-}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"
      exit 0 ;;
    *) echo "[nightly-db-backup ERROR] unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log(){ echo "[nightly-db-backup $(date -u +%H:%M:%S)] $*"; }
die(){ local code="$1"; shift; echo "[nightly-db-backup ERROR] $*" >&2; exit "$code"; }

# ── prechecks (all run under --dry-run too) ───────────────────────────────────
command -v sqlite3 >/dev/null 2>&1 || die 2 "sqlite3 CLI not found on PATH"
command -v gzip    >/dev/null 2>&1 || die 2 "gzip not found on PATH"

[ -f "$DB_PATH" ] || die 2 "source DB not found: $DB_PATH (set DB_PATH)"
[ -r "$DB_PATH" ] || die 2 "source DB not readable: $DB_PATH (run as a user that can read it)"

case "$KEEP_BACKUPS" in (*[!0-9]*|'') die 2 "KEEP_BACKUPS must be a positive integer, got '$KEEP_BACKUPS'";; esac
[ "$KEEP_BACKUPS" -ge 1 ] || die 2 "KEEP_BACKUPS must be >= 1, got '$KEEP_BACKUPS'"

# Off-host target is REQUIRED. A backup that never leaves this host does not
# survive the disk it is protecting against — refuse to pretend otherwise.
if [ -z "$OFFHOST_PUSH_CMD" ] && [ -z "$RSYNC_TARGET" ]; then
  die 6 "no off-host target configured — set OFFHOST_PUSH_CMD or RSYNC_TARGET. Refusing to produce a local-only 'backup'."
fi

mkdir -p "$BACKUP_DIR" || die 2 "cannot create BACKUP_DIR: $BACKUP_DIR"
[ -w "$BACKUP_DIR" ]   || die 2 "BACKUP_DIR not writable: $BACKUP_DIR"

# Free-space floor — same fail-loud pattern as scripts/deploy/deploy.sh.
FREE_MB="$(df -Pm "$BACKUP_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
[ "${FREE_MB:-0}" -ge "$MIN_FREE_MB" ] || die 2 "low space in $BACKUP_DIR (${FREE_MB:-0} MB free, need >= ${MIN_FREE_MB})"

TS="$(date -u +%Y%m%d-%H%M%S)"
ARTIFACT="$BACKUP_DIR/onestreamer-nightly-$TS.db.gz"
TMP_DB="$BACKUP_DIR/.tmp-nightly-$TS.$$.db"

if [ "$DRY_RUN" = 1 ]; then
  log "DRY RUN — all prechecks passed. Would:"
  log "  snapshot   $DB_PATH -> $TMP_DB  (sqlite3 .backup, busy timeout ${SQLITE_BUSY_MS}ms)"
  log "  verify     PRAGMA integrity_check on the snapshot"
  log "  compress   -> $ARTIFACT"
  if [ -n "$OFFHOST_PUSH_CMD" ]; then
    log "  push       OFFHOST_PUSH_CMD: $OFFHOST_PUSH_CMD <artifact>"
  else
    log "  push       rsync -a <artifact> $RSYNC_TARGET"
  fi
  log "  retention  keep newest $KEEP_BACKUPS of $BACKUP_DIR/onestreamer-nightly-*.db.gz"
  exit 0
fi

# ── single-writer lock (never overlap two runs) ───────────────────────────────
LOCK_FILE="${LOCK_FILE:-$BACKUP_DIR/.nightly-db-backup.lock}"
exec 9>"$LOCK_FILE" || die 2 "cannot open lock $LOCK_FILE"
flock -n 9          || die 2 "another nightly-db-backup run holds $LOCK_FILE — aborting"

# Also remove -wal/-shm sidecars sqlite3 can leave next to the snapshot when a
# check on a WAL-mode copy errors out mid-open.
cleanup(){ rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"; }
trap cleanup EXIT

# ── 1. WAL-consistent online snapshot (NEVER a raw cp of a live WAL DB) ───────
log "snapshotting $DB_PATH (online .backup)"
if ! sqlite3 "$DB_PATH" ".timeout $SQLITE_BUSY_MS" ".backup '$TMP_DB'"; then
  die 3 "sqlite3 .backup failed for $DB_PATH — source may be corrupt or locked beyond ${SQLITE_BUSY_MS}ms"
fi

# ── 2. integrity check the COPY before accepting it ───────────────────────────
log "running PRAGMA integrity_check on the snapshot"
INTEGRITY="$(sqlite3 "$TMP_DB" "PRAGMA integrity_check;" 2>&1)"
if [ "$INTEGRITY" != "ok" ]; then
  echo "$INTEGRITY" | head -20 >&2
  die 4 "integrity_check on the snapshot did NOT return 'ok' — discarding it. Investigate the source DB NOW (see docs/operations/backup-restore.md)."
fi

# ── 3. compress to the timestamped artifact ───────────────────────────────────
log "compressing -> $ARTIFACT"
if ! gzip -c "$TMP_DB" > "$ARTIFACT.partial" || ! mv "$ARTIFACT.partial" "$ARTIFACT"; then
  rm -f "$ARTIFACT.partial"
  die 5 "gzip/rename failed for $ARTIFACT"
fi
rm -f "$TMP_DB"
SIZE="$(du -h "$ARTIFACT" | awk '{print $1}')"
log "local artifact ready: $ARTIFACT ($SIZE)"

# ── 4. OFF-HOST push — the point of this script. Fail loud, keep the local ────
#       artifact for a manual re-push, and exit non-zero so alerting fires.
export BACKUP_ARTIFACT="$ARTIFACT"
if [ -n "$OFFHOST_PUSH_CMD" ]; then
  log "pushing off-host via OFFHOST_PUSH_CMD"
  if ! bash -c "$OFFHOST_PUSH_CMD \"\$1\"" offhost-push "$ARTIFACT"; then
    die 6 "off-host push FAILED (OFFHOST_PUSH_CMD). Local artifact kept at $ARTIFACT — push it manually, then fix the target."
  fi
else
  log "pushing off-host via rsync -> $RSYNC_TARGET"
  if ! rsync -a --timeout=300 "$ARTIFACT" "$RSYNC_TARGET"; then
    die 6 "off-host push FAILED (rsync to $RSYNC_TARGET). Local artifact kept at $ARTIFACT — push it manually, then fix the target."
  fi
fi
log "off-host push OK"

# ── 5. local retention: keep newest $KEEP_BACKUPS (only runs after a good push,
#       so failed pushes accumulate locally until the free-space floor trips —
#       deliberately noisy). Only touches this script's own artifacts; deploy
#       backups (onestreamer-<sha>-<ts>.db) are untouched.
PRUNED=0
while IFS= read -r stale; do
  [ -n "$stale" ] || continue
  rm -f -- "$stale" && { log "pruned $(basename "$stale")"; PRUNED=$((PRUNED + 1)); }
done < <(ls -1t "$BACKUP_DIR"/onestreamer-nightly-*.db.gz 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))")
[ "$PRUNED" -gt 0 ] && log "retention: pruned $PRUNED, kept newest $KEEP_BACKUPS"

log "OK — $ARTIFACT snapshotted, integrity-checked, pushed off-host"
exit 0
