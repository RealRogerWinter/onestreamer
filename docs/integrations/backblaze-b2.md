# Backblaze B2

_Last verified: 2026-05-23 against commit 4a1d325._

The cloud-storage tier for recording segments and clip videos. B2 is used via its S3-compatible API; the `@aws-sdk/client-s3` library talks to it as if it were AWS S3. See [ADR-0005](../architecture/adr/0005-b2-over-direct-s3.md) for why B2 over direct AWS S3.

## What it is

- **[Backblaze B2 Cloud Storage](https://www.backblaze.com/b2/cloud-storage.html)** — S3-compatible object storage with significantly lower egress + storage cost than AWS S3.
- **Account-key + Application-key** auth model (more granular than AWS IAM).
- **OneStreamer talks to it via the AWS S3 SDK** pointed at B2's S3-compatible endpoint — no special B2 SDK needed.

## What it stores

| Path | Contents |
|------|----------|
| `s3://<bucket>/segments/<sessionId>/<segmentName>.ts` | HLS video segments (one per few seconds of recording) |
| `s3://<bucket>/segments/<sessionId>/playlist.m3u8` | HLS manifest for the session |
| (Clip videos may be stored similarly under their own prefix) | |

## Credentials

| Env var | Purpose |
|---------|---------|
| `B2_APPLICATION_KEY_ID` | B2 application key ID (recommended: scope to the OneStreamer bucket only) |
| `B2_APPLICATION_KEY` | B2 application key secret |
| `B2_BUCKET_ID` | B2 bucket UUID (different from name; required by some B2 APIs) |
| `B2_BUCKET_NAME` | B2 bucket name |
| `B2_ENDPOINT` | B2 S3 endpoint URL (e.g. `s3.us-east-005.backblazeb2.com`) |
| `B2_STREAMING_ENABLED` | `true` to stream video from B2 signed URLs in admin review; `false` to serve from local disk only |

All required for the recording-and-clips feature. Without them, [`B2StorageService`](../../server/services/B2StorageService.js) initialization throws, and recording-upload fails.

## Setting up a B2 bucket

1. Sign in to [B2 Cloud Storage](https://secure.backblaze.com/).
2. **Buckets** → Create a Bucket. Choose **Private**. Name: `onestreamer-recordings` (or whatever).
3. Note the **Bucket ID** and **Bucket Name**.
4. **App Keys** → Add a New Application Key:
   - Name: `onestreamer-server`
   - Allow access to: just this bucket
   - Type of Access: `Read and Write`
   - File name prefix: leave blank (full bucket access)
   - Duration: leave blank (never expires)
5. Copy the **Application Key ID** and **Application Key** (the secret is shown ONCE — don't lose it).
6. Find the S3 endpoint URL — it's shown on the bucket settings page (something like `https://s3.us-east-005.backblazeb2.com`).
7. Set the env vars per the table above.
8. (Optional) Add a bucket **Lifecycle Rule** to delete files older than N days for automatic retention.

## Operational notes

- **Upload is asynchronous and non-blocking.** [`B2SegmentUploadService`](../../server/services/B2SegmentUploadService.js) queues segments as they're written locally and uploads them in the background. The main recording pipeline doesn't wait.
- **Local files are cleaned up after B2 confirms the upload.** [`RecordingCleanupScheduler`](../../server/services/RecordingCleanupScheduler.js) handles this. If B2 uploads stall, local disk fills — see [`/docs/operations/runbooks/recording-upload-failed.md`](../operations/runbooks/recording-upload-failed.md).
- **`B2_STREAMING_ENABLED=true`** lets the admin recording-review tool stream video directly from B2 (via 4-hour signed URLs). Saves bandwidth on the OneStreamer host but creates a hard dependency on B2 being reachable.
- **Egress cost** — B2 egress is much cheaper than AWS but not free. If you stream a lot of recording playback from B2, factor that into the budget.
- **Bucket lifecycle rules** are managed in the B2 dashboard, not in OneStreamer. Set them conservatively (90 days, not 1 day).

## Code paths

| Concern | File |
|---------|------|
| S3 client setup (against B2 endpoint) | [`server/services/B2StorageService.js`](../../server/services/B2StorageService.js) |
| Per-segment upload queue | [`server/services/B2SegmentUploadService.js`](../../server/services/B2SegmentUploadService.js) |
| Periodic retry of stuck uploads | [`server/services/RecordingUploadScheduler.js`](../../server/services/RecordingUploadScheduler.js) |
| Local file cleanup after upload | [`server/services/RecordingCleanupScheduler.js`](../../server/services/RecordingCleanupScheduler.js) |
| Recording pipeline (the producer of segments) | [`server/services/ContinuousRecordingService.js`](../../server/services/ContinuousRecordingService.js) |
| Signed-URL playback in admin review | server routes under `/admin/review/sessions/...` ([`server/routes/admin-recordings.js`](../../server/routes/admin-recordings.js)) |

## Verifying connectivity

```bash
# Probe with the AWS CLI (configure a profile or pass --profile inline)
aws s3 ls "s3://$B2_BUCKET_NAME/segments/" \
  --endpoint-url "https://$B2_ENDPOINT" \
  --profile b2

# Or upload a probe file
echo "test" > /tmp/probe.txt
aws s3 cp /tmp/probe.txt "s3://$B2_BUCKET_NAME/probe.txt" \
  --endpoint-url "https://$B2_ENDPOINT"
aws s3 rm "s3://$B2_BUCKET_NAME/probe.txt" \
  --endpoint-url "https://$B2_ENDPOINT"
```

If the probe fails:

- `InvalidAccessKeyId` / `403` → credentials issue. Rotate per [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).
- `NoSuchBucket` → bucket-name or bucket-id mismatch.
- Network error → check egress from the host (corporate firewalls sometimes block B2 endpoints).

## Troubleshooting

| Symptom | First check |
|---------|-------------|
| Recordings filling local disk | B2 uploads stuck — see [`/docs/operations/runbooks/recording-upload-failed.md`](../operations/runbooks/recording-upload-failed.md) |
| Admin review playback fails | If `B2_STREAMING_ENABLED=true`, the signed URL may have expired (4h TTL by default) — refresh the admin page |
| All uploads failing | Probe credentials with the `aws s3 ls` command above |
| Some uploads failing, some succeeding | Likely a per-segment retry-able error; check `B2SegmentUploadService` log for the pattern |
| B2 invoice surprise | Egress from `B2_STREAMING_ENABLED=true` usage — consider serving from a CDN, or set `B2_STREAMING_ENABLED=false` and stream from local disk |

## See also

- [`/docs/features/recording-and-clips.md`](../features/recording-and-clips.md) — what gets uploaded and why
- [`/docs/operations/runbooks/recording-upload-failed.md`](../operations/runbooks/recording-upload-failed.md) — when uploads break
- [ADR-0005](../architecture/adr/0005-b2-over-direct-s3.md) — why B2 over direct S3
- [B2 docs](https://www.backblaze.com/b2/docs/) — the upstream reference
