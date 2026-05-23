# Backup and restore

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer's state lives in a handful of places. Backing up requires capturing each one; restoring requires putting each back. There is no integrated backup tool today — this is the manual playbook.

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

- `recordings/` local files — uploaded to B2; expendable once B2 confirms upload
- `clips/temp/` — scratch
- `audio-buffers/` — transcription scratch
- `egress-recordings/` — LiveKit egress; dormant
- `whisper/models/*.bin` — downloadable from upstream (`setup-whisper.js`)
- `logs/*.log` — rotated automatically by PM2
- `node_modules/` — `npm install` regenerates

## Backup procedure

A simple shell script run as cron, with versioned outputs:

```bash
#!/bin/bash
# /usr/local/bin/onestreamer-backup.sh
set -euo pipefail

DATE=$(date +%Y-%m-%d-%H%M)
DEST=/backups/onestreamer/$DATE
mkdir -p "$DEST"

# 1. SQLite DB — use sqlite3 .backup for a consistent snapshot
#    (cp can capture a half-written WAL file)
sqlite3 /root/onestreamer/server/data/onestreamer.db ".backup '$DEST/onestreamer.db'"

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

**Push backups off-host.** A local-only backup doesn't survive disk failure. Options:

- `rsync` to a remote host:
  ```bash
  rsync -az --delete /backups/onestreamer/ user@backup-host:/backups/onestreamer/
  ```
- Upload to B2 or any S3-compatible storage (separate bucket from recordings)
- Restic / Borg for deduplicated encrypted backups

Whichever you pick, **test the restore at least once a quarter**. An untested backup is no backup.

## Restore procedure

### SQLite (main DB)

Stop the app, swap the file, restart:

```bash
pm2 stop onestreamer-server onestreamer-chat
cp /backups/onestreamer/2026-05-23-0330/onestreamer.db /root/onestreamer/server/data/onestreamer.db
chown root:root /root/onestreamer/server/data/onestreamer.db
chmod 644 /root/onestreamer/server/data/onestreamer.db
pm2 restart onestreamer-server onestreamer-chat --update-env
```

Verify with `sqlite3 /root/onestreamer/server/data/onestreamer.db "SELECT COUNT(*) FROM users;"` and similar.

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
2. Install dependencies: Node 18+, ffmpeg, GStreamer, build-essential, sqlite3, nginx, certbot, coturn, Ollama, Strapi.
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
- **In-flight MediaSoup state** — every active stream drops; users have to refresh.
- **In-progress recordings** — the segment writing in `recordings/active/` stops; whatever was being recorded at the moment of the restart is partial.
- **Active transcriptions** — the current chunk is dropped.

None of these are catastrophic — they're per-user inconveniences. Communicate via `POST /api/system-message` against chat-service before doing anything that requires a restart.

## See also

- [`deployment.md`](deployment.md) — current topology + filesystem layout
- [`upgrades.md`](upgrades.md) — when to back up before a migration
- [`runbooks/secret-rotation.md`](runbooks/secret-rotation.md) — better than restoring secrets from backup in most cases
- [`/docs/architecture/data-model.md`](../architecture/data-model.md) — what's in the SQLite tables you're backing up
