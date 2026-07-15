# Backup and restore

_Last verified: 2026-07-15._

OneStreamer's state lives in a handful of places. Backing up requires capturing each one; restoring requires putting each back. The **main SQLite DB has an integrated nightly off-host backup tool** — [`scripts/ops/nightly-db-backup.sh`](../../scripts/ops/nightly-db-backup.sh) (audit D2.a) — documented below; everything else is still a manual playbook.

## What to back up

| Source | Location | Why | Frequency |
|--------|----------|-----|-----------|
| **Main SQLite DB** | `/root/onestreamer/server/data/onestreamer.db` | Users, points, items, inventory, recordings metadata, clips, chatbots, IP bans, transcriptions, audit logs | Daily, plus before any schema migration |
| **Chat moderation state** | `/root/onestreamer/chat-service/moderation_data.json` | Permanent bans and active timeouts (the only chat-service persistence) | Daily |
| **Strapi SQLite DB** | `/root/strapi-blog/backend/.tmp/data.db` (or wherever Strapi's `database.filename` points) | Blog articles, media references, user content | Daily (or per-article-edit) |
| **Strapi `public/uploads/`** | `/root/strapi-blog/backend/public/uploads/` | Blog image uploads | When Strapi DB is backed up |
| **`.env` files** | `/root/onestreamer/.env`, `/root/onestreamer/server/.env`, `/root/onestreamer/chat-service/.env`, `/root/onestreamer/client/.env` | Secrets that aren't recoverable from anywhere else | After any rotation |
| **TLS certs** | `/etc/letsencrypt/` | Renewable via certbot, but quicker to restore from backup | Weekly |
| **nginx config** | `/etc/nginx/sites-available/onestreamer.live`, `/etc/nginx/sites-available/livekit.onestreamer.live` | Tracked in this repo too, but the live copy may diverge | After any nginx change |
| **B2 bucket** | `s3://<bucket-name>/segments/` (recording segments + clip videos) | Already off-host; consider B2's own lifecycle / replication for redundancy | B2 lifecycle policy |
| **Avatars + emojis** | `/root/onestreamer/server/uploads/` (avatars), `/root/onestreamer/server/uploads/emojis/` | User-uploaded; not in git | Daily |

**What you do NOT need to back up:**

- `egress-recordings/` local files — LiveKit-egress HLS segments ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)); uploaded to B2 and expendable once B2 confirms upload
- `recordings/` — legacy local recording dir (kept for clip scratch)
- `clips/temp/` — scratch
- `audio-buffers/` — transcription scratch
- `whisper/models/*.bin` — downloadable from upstream (`setup-whisper.js`)
- `logs/*.log` — rotated automatically by PM2
- `node_modules/` — `npm install` regenerates

## Backup procedure

### Main SQLite DB — nightly off-host tool (shipped)

[`scripts/ops/nightly-db-backup.sh`](../../scripts/ops/nightly-db-backup.sh) is the integrated backup for the main DB. Each run it:

1. takes a **WAL-consistent online snapshot** via `sqlite3 <db> ".backup <tmp>"` (never a raw `cp`, which can capture a half-written WAL);
2. runs `PRAGMA integrity_check` **on the snapshot** and discards it unless the result is exactly `ok`;
3. gzips it to a timestamped artifact `onestreamer-nightly-<UTC ts>.db.gz` in `BACKUP_DIR`;
4. **pushes it off-host** — this step is mandatory: the script exits non-zero if no push target is configured or the push fails (the local artifact is kept for a manual re-push), so cron/systemd mail and the backup-age alert in [`monitoring.md`](monitoring.md) catch it;
5. prunes local artifacts beyond the newest `KEEP_BACKUPS` (deploy-time `onestreamer-<sha>-<ts>.db` backups are untouched).

It also does a free-space precheck (`MIN_FREE_MB`, same fail-loud pattern as `deploy.sh`), takes an flock so runs never overlap, never prompts, and supports `--dry-run` (runs every precheck and prints the plan without writing anything — use it to validate a crontab line).

**Environment variables** (defaults match the prod layout):

| Var | Default | Meaning |
|-----|---------|---------|
| `DB_PATH` | `/root/onestreamer/server/data/onestreamer.db` | Source DB |
| `BACKUP_DIR` | `/backups/nightly` | Local artifact dir |
| `KEEP_BACKUPS` | `7` | Newest N local artifacts to keep |
| `MIN_FREE_MB` | `4096` | Required free MB in `BACKUP_DIR` |
| `SQLITE_BUSY_MS` | `30000` | sqlite3 busy timeout |
| `OFFHOST_PUSH_CMD` | — | Push command; the artifact path is appended (quoted) as its last argument, and exported as `$BACKUP_ARTIFACT`. Wins over `RSYNC_TARGET` if both set |
| `RSYNC_TARGET` | — | Alternative: rsync destination dir, e.g. `backup@backup-host:/backups/onestreamer/` |
| `LOCK_FILE` | `$BACKUP_DIR/.nightly-db-backup.lock` | flock path |

One of `OFFHOST_PUSH_CMD` / `RSYNC_TARGET` is **required** — a local-only "backup" is refused. Examples:

```bash
# validate the config without writing anything
RSYNC_TARGET='backup@backup-host:/backups/onestreamer/' \
  /root/onestreamer/scripts/ops/nightly-db-backup.sh --dry-run

# real run, rsync off-host
RSYNC_TARGET='backup@backup-host:/backups/onestreamer/' \
  /root/onestreamer/scripts/ops/nightly-db-backup.sh

# real run, arbitrary push command (path appended as last arg)
OFFHOST_PUSH_CMD='rclone copy --config /root/.config/rclone/rclone.conf -- ' \
  /root/onestreamer/scripts/ops/nightly-db-backup.sh
```

**Scheduling** — the repo ships examples; **nothing installs itself**, the operator copies one in:

- crontab: [`scripts/ops/nightly-db-backup.cron.example`](../../scripts/ops/nightly-db-backup.cron.example)
- systemd: [`scripts/ops/nightly-db-backup.service.example`](../../scripts/ops/nightly-db-backup.service.example) + [`scripts/ops/nightly-db-backup.timer.example`](../../scripts/ops/nightly-db-backup.timer.example) (install steps in the service file's header)

Run it as a user that can read the DB — root, or uid 1001 (which owns `server/data/` in the container layout). Wire the non-zero exit into whatever alerts you (cron `MAILTO`, systemd `OnFailure=`, Healthchecks.io wrapper), and add the **backup-age alert** from [`monitoring.md`](monitoring.md) so a cron that silently stops running is also caught.

### Everything else — manual playbook

A simple shell script run as cron, with versioned outputs (the main DB is
covered by the nightly tool above and deliberately absent here):

```bash
#!/bin/bash
# /usr/local/bin/onestreamer-backup.sh
set -euo pipefail

DATE=$(date +%Y-%m-%d-%H%M)
DEST=/backups/onestreamer/$DATE
mkdir -p "$DEST"

# 1. Main SQLite DB — handled by scripts/ops/nightly-db-backup.sh (above);
#    if you must snapshot it here too, use sqlite3 .backup, NEVER cp.

# 2. Chat moderation
cp /root/onestreamer/chat-service/moderation_data.json "$DEST/"

# 3. Strapi DB + uploads (adjust path to your Strapi data file)
sqlite3 /root/strapi-blog/backend/.tmp/data.db ".backup '$DEST/strapi.db'"
tar czf "$DEST/strapi-uploads.tgz" -C /root/strapi-blog/backend/public uploads

# 4. .env files (be careful — these contain secrets; encrypt at rest)
tar czf "$DEST/env-files.tgz" \
  /root/onestreamer/.env \
  /root/onestreamer/server/.env \
  /root/onestreamer/chat-service/.env \
  /root/onestreamer/client/.env 2>/dev/null || true

# 5. TLS certs (preserve symlinks)
tar czf "$DEST/letsencrypt.tgz" /etc/letsencrypt/

# 6. nginx config
cp /etc/nginx/sites-available/onestreamer.live "$DEST/"
cp /etc/nginx/sites-available/livekit.onestreamer.live "$DEST/" 2>/dev/null || true

# 7. Avatars + emojis
tar czf "$DEST/uploads.tgz" -C /root/onestreamer/server uploads

# Prune backups older than 30 days
find /backups/onestreamer -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;

echo "Backup complete: $DEST"
```

Schedule:

```bash
# crontab -e
30 3 * * * /usr/local/bin/onestreamer-backup.sh >> /var/log/onestreamer-backup.log 2>&1
```

**Push backups off-host.** A local-only backup doesn't survive disk failure. The nightly DB tool refuses to run without an off-host target; give this auxiliary script the same treatment. Options:

- `rsync` to a remote host:
  ```bash
  rsync -az --delete /backups/onestreamer/ user@backup-host:/backups/onestreamer/
  ```
- Upload to B2 or any S3-compatible storage (separate bucket from recordings)
- Restic / Borg for deduplicated encrypted backups

Whichever you pick, **test the restore at least once a quarter** — see the [restore drill](#restore-drill-quarterly) below. An untested backup is no backup.

## Restore procedure

### SQLite (main DB) — from a nightly artifact

Artifacts are gzipped snapshots named `onestreamer-nightly-<UTC ts>.db.gz` (in `BACKUP_DIR` locally, and on your off-host target). Verify **before** swapping, stop the app, swap the file, restart:

```bash
# 1. pick the artifact (fetch from the off-host target if the local disk is gone)
ART=/backups/nightly/onestreamer-nightly-20260715-033000.db.gz

# 2. decompress to a scratch path and verify it BEFORE touching the live file
gunzip -c "$ART" > /tmp/restore-candidate.db
sqlite3 /tmp/restore-candidate.db "PRAGMA integrity_check;"   # must print exactly: ok
sqlite3 /tmp/restore-candidate.db "SELECT COUNT(*) FROM users;"  # sanity: plausible row count

# 3. stop the app, swap, restart
docker compose -f ~/onestreamer-deploy/compose.yaml stop
mv /root/onestreamer/server/data/onestreamer.db /root/onestreamer/server/data/onestreamer.db.pre-restore
rm -f /root/onestreamer/server/data/onestreamer.db-wal /root/onestreamer/server/data/onestreamer.db-shm
cp /tmp/restore-candidate.db /root/onestreamer/server/data/onestreamer.db
chown 1001:1001 /root/onestreamer/server/data/onestreamer.db   # containers run as uid 1001
docker compose -f ~/onestreamer-deploy/compose.yaml up -d
```

Verify with `sqlite3 /root/onestreamer/server/data/onestreamer.db "SELECT COUNT(*) FROM users;"` and similar, then hit `/health` and smoke-test a login. Keep the `.pre-restore` copy until you're confident. (Deploy-time backups in `/backups/onestreamer-<sha>-<ts>.db` are uncompressed — same steps, skip the `gunzip`.)

### Restore drill (quarterly)

Run this every quarter (put it on the calendar). It touches nothing live — scratch paths only.

- [ ] Pick the **latest** artifact **from the off-host target** (that proves the push leg works too), copy it to a scratch dir on any machine with `sqlite3`.
- [ ] `gunzip -c <artifact> > /tmp/drill.db` — decompresses cleanly, no truncation errors.
- [ ] `sqlite3 /tmp/drill.db "PRAGMA integrity_check;"` → prints exactly `ok`.
- [ ] Row-count sanity vs prod expectations: `SELECT COUNT(*) FROM users;`, `SELECT COUNT(*) FROM points_transactions;`, `SELECT MAX(created_at) FROM points_transactions;` — counts in the ballpark of production, newest timestamp within the last ~24 h of the artifact's date.
- [ ] Artifact age: newest artifact (local **and** off-host) is < 25 h old.
- [ ] `rm /tmp/drill.db`, note the drill date + result in your ops log.

If any step fails, treat it as an incident: the backup you thought you had does not exist.

### Chat moderation

```bash
pm2 stop onestreamer-chat
cp /backups/onestreamer/2026-05-23-0330/moderation_data.json /root/onestreamer/chat-service/moderation_data.json
pm2 restart onestreamer-chat
```

### Strapi DB + uploads

```bash
systemctl stop strapi    # adjust to your Strapi process manager
cp /backups/onestreamer/2026-05-23-0330/strapi.db /root/strapi-blog/backend/.tmp/data.db
tar xzf /backups/onestreamer/2026-05-23-0330/strapi-uploads.tgz -C /root/strapi-blog/backend/public/
systemctl start strapi
```

### `.env` files

Only restore from backup if **(a)** the host was lost and there's no other copy and **(b)** rotating each secret afterwards is harder than restoring. Otherwise prefer to regenerate secrets fresh per [`runbooks/secret-rotation.md`](runbooks/secret-rotation.md).

### TLS certs

If `/etc/letsencrypt/` is intact, certbot will renew automatically. If it's gone:

```bash
sudo tar xzf /backups/onestreamer/2026-05-23-0330/letsencrypt.tgz -C /
sudo systemctl reload nginx
sudo certbot certificates    # verify
sudo certbot renew --dry-run # confirm renewal still works
```

If even the backup is gone, re-issue from scratch:

```bash
sudo certbot --nginx -d onestreamer.live -d www.onestreamer.live -d livekit.onestreamer.live
```

### B2 recordings

Already off-host. Restore only happens if you accidentally delete from B2 — and B2's own delete-protection / object versioning is the right defense there, not these backups.

## Recovery scenarios

### Total host loss

1. Provision a new host with the same OS family.
2. Install dependencies: Node 18+, ffmpeg, streamlink/yt-dlp, build-essential, sqlite3, nginx, certbot, coturn, Ollama, Strapi, and the LiveKit server (the sole WebRTC backend — [ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md); no GStreamer needed anymore).
3. Clone the repo: `git clone https://github.com/onestreamer/onestreamer.git /root/onestreamer`.
4. Restore `.env` files (or rotate fresh — preferred).
5. Restore SQLite + Strapi + moderation_data.json + uploads from backup.
6. Restore or regenerate TLS certs.
7. Restore or regenerate nginx config.
8. `cd /root/onestreamer && npm run install-all`
9. `node setup-whisper.js` to rebuild whisper.cpp and pull models.
10. `pm2 start config/ecosystem.config.js && pm2 save && pm2 startup` (then run the systemd command it prints).
11. Smoke-test per [`/docs/getting-started/first-stream.md`](../getting-started/first-stream.md).

Realistic recovery time: **2–4 hours** assuming backups are accessible and certs can be re-issued (no DNS surprises).

### Selective rollback after a bad schema migration

1. Stop the server.
2. Restore SQLite to pre-migration snapshot.
3. Revert the migration commit (or skip the migration script next time).
4. Restart.

This is why backing up **before** a migration is non-negotiable.

### "I just deleted user 42 by mistake"

If you have a recent backup and minimal user activity since:

1. Spin up a sandbox SQLite copy from backup.
2. Extract the relevant rows from `users`, `user_stats`, `user_inventory`, etc.
3. Re-insert into the live DB with the same `id`.
4. Verify cross-table references still hold.

If significant user activity has happened since, this gets harder (foreign-key collisions, possible point-balance drift). Consider it case-by-case.

## What gets lost in a restore

- **In-memory chat messages** (last 3,000) — gone on any chat-service restart anyway.
- **Active vote tallies** in chat-service — gone on chat restart.
- **In-flight LiveKit room state** — every active stream drops; users have to refresh (LiveKit is the sole WebRTC backend — [ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)).
- **In-progress recordings** — the LiveKit egress writing segments to `egress-recordings/{sessionId}/` stops; whatever was being recorded at the moment of the restart is partial.
- **Active transcriptions** — the current chunk is dropped.

None of these are catastrophic — they're per-user inconveniences. Communicate via `POST /api/system-message` against chat-service before doing anything that requires a restart.

## See also

- [`deployment.md`](deployment.md) — current topology + filesystem layout
- [`upgrades.md`](upgrades.md) — when to back up before a migration
- [`runbooks/secret-rotation.md`](runbooks/secret-rotation.md) — better than restoring secrets from backup in most cases
- [`/docs/architecture/data-model.md`](../architecture/data-model.md) — what's in the SQLite tables you're backing up
