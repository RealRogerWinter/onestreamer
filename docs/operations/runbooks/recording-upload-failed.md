# Recording upload failed

_Last verified: 2026-05-23 against commit 4a1d325._

## Symptoms

- Local disk is filling up; `recordings/active/` or `recordings/completed/` is growing without bound
- Admin panel → Recordings tab shows stale segment counts (or recording entries with `upload_status: pending` for hours)
- Admin recording-review playback fails with "segment not found" when `B2_STREAMING_ENABLED=true`
- B2 dashboard shows no recent upload activity
- `pm2 logs onestreamer-server` shows repeated `RecordingUploadScheduler` errors or `NetworkError` / `403 Forbidden`

## How to confirm

1. **Check the local recording footprint vs B2:**
   ```bash
   du -sh /root/onestreamer/recordings/
   ls /root/onestreamer/recordings/active/ | wc -l
   ls /root/onestreamer/recordings/completed/ | wc -l
   ```
   A healthy steady state has active < ~10 files and completed < ~100 (depending on retention).
2. **Check the upload service logs:**
   ```bash
   pm2 logs onestreamer-server --lines 200 --nostream | grep -E "B2(SegmentUploadService|StorageService)"
   ```
3. **Query the DB for stuck segments:**
   ```bash
   sqlite3 /root/onestreamer/server/data/onestreamer.db <<'SQL'
   SELECT recording_id, COUNT(*) AS stuck
   FROM b2_uploaded_segments
   WHERE uploaded_at IS NULL
   GROUP BY recording_id
   ORDER BY stuck DESC LIMIT 10;
   SQL
   ```
4. **Probe B2 credentials directly:**
   ```bash
   # Replace with your actual env vars
   aws s3 ls "s3://$B2_BUCKET_NAME/" \
     --endpoint-url "https://$B2_ENDPOINT" \
     --profile b2
   ```
   If this fails, the credentials are bad. If it works, the credentials are fine but something else is broken.

## Likely causes

### 1. Expired or revoked B2 credentials

Most common cause. B2 application keys can be revoked from the dashboard. Verify:

```bash
pm2 env onestreamer-server | grep -E "B2_APPLICATION_KEY"
```

…and try a probe upload:

```bash
echo "test" > /tmp/probe.txt
aws s3 cp /tmp/probe.txt "s3://$B2_BUCKET_NAME/probe.txt" \
  --endpoint-url "https://$B2_ENDPOINT"
```

If you get `403 Forbidden` or `InvalidAccessKeyId`: rotate the key per [`secret-rotation.md`](secret-rotation.md) → "Backblaze B2".

### 2. B2 bucket lifecycle deleted the destination prefix

If a bucket lifecycle rule was set too aggressively (e.g. "delete after 1 day") and the segments are being deleted faster than the app can write them, B2 reports success but the segments aren't there. Check bucket lifecycle in the B2 dashboard.

### 3. Network outage from the host to B2

Transient. Should self-recover. Check:

```bash
curl -I "https://$B2_ENDPOINT"
```

`RecordingUploadScheduler` has retry logic — short outages are absorbed. Long outages cause a backlog that takes time to drain even after connectivity returns.

### 4. Disk filled up, blocking new segment writes too

A meta-issue: if the disk is already full because uploads stopped, *new* segments can't be written either. Recording silently degrades.

```bash
df -h /root/onestreamer/recordings/
```

If <1 GB free: clear space *before* trying to fix the upload (otherwise the fix might not even be able to log).

### 5. Recording pipeline crashed (so nothing to upload)

If segments stopped being *produced*, uploads have nothing to push. Check:

```bash
ls -lat /root/onestreamer/recordings/active/ | head -10   # newest files first
pgrep -fa ffmpeg | head
```

If no recent files and no ffmpeg processes — the recording pipeline is down, not the upload. See `ContinuousRecordingService` logs.

### 6. The `B2_BUCKET_ID` doesn't match the `B2_BUCKET_NAME`

B2 requires both. If you regenerated keys but pointed them at a different bucket, the bucket-name URL won't match the bucket-ID auth scope.

```bash
pm2 env onestreamer-server | grep -E "B2_BUCKET"
```

Cross-check both values against the B2 dashboard.

## Resolution

In order of escalation:

1. **Clear disk space.** If disk is >85% full, archive or delete old recordings *that have already uploaded*:
   ```bash
   # Find recordings where every segment has uploaded
   sqlite3 /root/onestreamer/server/data/onestreamer.db <<'SQL'
   SELECT r.id, r.file_path
   FROM recordings r
   WHERE r.status = 'completed'
     AND NOT EXISTS (
       SELECT 1 FROM b2_uploaded_segments s
       WHERE s.recording_id = r.id AND s.uploaded_at IS NULL
     )
   ORDER BY r.end_time ASC
   LIMIT 20;
   SQL
   # Then delete the local files (B2 has the cloud copy)
   ```
2. **Restart the upload scheduler.** It runs as part of the main server:
   ```bash
   pm2 restart onestreamer-server --update-env
   ```
3. **Rotate B2 credentials** if it's a credentials issue. See [`secret-rotation.md`](secret-rotation.md) → "Backblaze B2".
4. **Trigger a manual cleanup** if the scheduler isn't catching up:
   ```bash
   curl -X POST -H "x-admin-key: $ADMIN_KEY" \
     https://onestreamer.live/admin/recordings/cleanup
   ```
5. **Re-queue stuck segments** if you've fixed the underlying issue but the scheduler isn't picking up old segments:
   ```bash
   # Force-reset upload timestamps so the scheduler retries
   sqlite3 /root/onestreamer/server/data/onestreamer.db <<'SQL'
   UPDATE b2_uploaded_segments SET uploaded_at = NULL
   WHERE uploaded_at IS NULL AND retry_count > 5;
   SQL
   pm2 restart onestreamer-server --update-env
   ```

## Prevention

- **Alert on disk usage** (>80%). Per [`monitoring.md`](../monitoring.md).
- **Alert on B2 upload activity dropping to zero** for >10 minutes. Check via the B2 dashboard.
- **Monitor the count of stuck segments**:
  ```bash
  # Run as a check
  STUCK=$(sqlite3 /root/onestreamer/server/data/onestreamer.db \
    "SELECT COUNT(*) FROM b2_uploaded_segments WHERE uploaded_at IS NULL;")
  if [ "$STUCK" -gt 100 ]; then echo "ALERT: $STUCK stuck segments"; fi
  ```
- **Don't let `B2_STREAMING_ENABLED=true`** become a hard dependency for admin recording review until you trust the upload pipeline. Local-disk fallback is safer.
- **Set B2 lifecycle rules conservatively.** "Delete after 1 year" not "delete after 1 day."

## See also

- [`/docs/integrations/backblaze-b2.md`](../../integrations/backblaze-b2.md) — B2 credentials and bucket setup
- [`/docs/features/recording-and-clips.md`](../../features/recording-and-clips.md) — the recording feature in depth
- [`monitoring.md`](../monitoring.md) — alerts that catch this earlier
- [`secret-rotation.md`](secret-rotation.md) — when to rotate B2 keys
