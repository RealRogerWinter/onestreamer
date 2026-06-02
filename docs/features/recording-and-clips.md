# Recording and clips

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer continuously records every active stream, uploads segments to Backblaze B2, captures synced chat messages, and supports extracting playable clips from any segment. Recordings are reviewable in the admin panel; clips are user-visible in a gallery.

> [!NOTE]
> Earlier versions of this system captured WebM directly from a MediaSoup Plain-RTP transport; that path was retired with MediaSoup ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). The current production path is **LiveKit Egress → HLS segments → B2 segment upload** — see the [Recording pipeline](#recording-pipeline) below. Legacy recording-system notes live in [`/docs/archive/`](../archive/).

## What gets recorded

Every active stream is recorded by default. Per-stream metadata: streamer ID, start/end times, segment count, duration, file size, status. Chat messages from the same session are timestamped and stored alongside, enabling synced replay.

## Recording pipeline

```
LiveKit room → LiveKit Egress (Room Composite / Participant) → HLS segments
                                                              ├── written to egress-recordings/{sessionId}/
                                                              └── RecordingUploadScheduler → Backblaze B2 bucket (async, non-blocking)

Chat messages → SessionChatCaptureService → timestamped JSON sidecar
                                            └── persisted with recording metadata
```

The encode happens inside LiveKit Egress, not in the app — there is no in-process GStreamer or MediaSoup pipeline anymore ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). Components:

| Service | Role |
|---------|------|
| [`ContinuousRecordingService.js`](../../server/services/ContinuousRecordingService.js) | Orchestrates recording; starts/stops the LiveKit Egress (Room Composite for viewbots, Participant Egress for a real streamer); tracks per-recording state in `recording_sessions` |
| [`recording/RecordingDiskScanner.js`](../../server/services/recording/RecordingDiskScanner.js) | Reconciles the `egress-recordings/` directory against the `recording_sessions` table |
| [`B2StorageService.js`](../../server/services/B2StorageService.js) | S3-compatible client (uses `@aws-sdk/client-s3` against B2's S3 endpoint), generates signed URLs for playback |
| [`RecordingUploadScheduler.js`](../../server/services/RecordingUploadScheduler.js) | Pushes finished segments to B2 and retries stuck uploads |
| [`RecordingCleanupScheduler.js`](../../server/services/RecordingCleanupScheduler.js) | Deletes local files after B2 upload confirmed; respects retention policy |
| [`SessionChatCaptureService.js`](../../server/services/SessionChatCaptureService.js) | Captures chat during stream; aligns to recording timeline |

## Storage layout

Local disk:

```
recordings/
├── active/        currently writing
├── processing/    being compressed (if compression enabled)
├── completed/     finalized; ready to upload / serve
├── archived/      long-term local copies
├── thumbnails/    JPEG previews
├── metadata/      per-recording JSON
├── temp/          SDP files, scratch
└── backups/       backup copies
```

Cloud (Backblaze B2):

```
{bucket}/segments/{sessionId}/{segmentName}.ts    — HLS .ts segments
{bucket}/segments/{sessionId}/playlist.m3u8       — HLS manifest
```

## Database schema

In SQLite ([`server/database/recording-schema.sql`](../../server/database/recording-schema.sql)):

```sql
recordings (id, stream_id, streamer_id, start_time, end_time, duration,
            file_path, file_size, quality_profile, format, status,
            compression_status, thumbnail_path, metadata_json, created_at)

recording_events (id, recording_id, event_type, event_data, user_id, timestamp)

recording_settings (key, value, description, updated_at)

b2_uploaded_segments (...)  -- tracks segment-upload completion
```

## Clip system

Clips are user-extractable portions of any recording (or, if recording is active, of the recent rolling window).

### What the user sees

1. Open the clip gallery (`/clips` link) — see [`ClipsGallery.tsx`](../../client/src/components/clips/ClipsGallery.tsx). Search, sort by recent / most-viewed, paginated 20/page.
2. Click a clip card → [`ClipPlayer.tsx`](../../client/src/components/clips/ClipPlayer.tsx) shows video + synced chat replay.
3. During a live stream: click **Create Clip** in the player controls; pick the duration (last N seconds, min 30 s / max 120 s — see live status endpoint); enter title/description.
4. Admin can extract clips from recorded sessions via the **Recording Review** tab — see [`AdminRecordingReview.tsx`](../../client/src/components/admin/AdminRecordingReview.tsx).

### Live status (probe)

```bash
curl -sk https://onestreamer.live/api/clips/status
# {"success":true,"available":<bool>,"isRecording":<bool>,"availableDuration":<ms>,
#  "maxClipDuration":120000,"minClipDuration":30000,...}
```

Clips are available when `isRecording=true` — they're extracted from the rolling segment buffer. If no stream is active, the gallery still works for browsing past clips; new clip creation is disabled.

### Routes

In [`server/routes/clips.js`](../../server/routes/clips.js):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/clips/status` | Liveness probe; reports availability + min/max duration |
| `GET` | `/api/clips` | List public clips (paginated, sortable, searchable) |
| `GET` | `/api/clips/:clipId` | Get a single clip's metadata |
| `GET` | `/api/clips/:clipId/chat` | Get the chat messages for the clip's time window |
| `GET` | `/api/clips/:clipId/stream` | Stream the clip video (range-request support) |
| `POST` | `/api/clips` | Create a new clip |
| `PUT` | `/api/clips/:clipId` | Update clip metadata |
| `DELETE` | `/api/clips/:clipId` | Delete a clip |
| `POST` | `/api/clips/:clipId/publish` | Make a clip publicly visible |

Clip processing services:

| Service | Role |
|---------|------|
| [`ClipService.js`](../../server/services/ClipService.js) | CRUD, lifecycle, public/private toggle |
| [`ClipProcessorService.js`](../../server/services/ClipProcessorService.js) | FFmpeg-based segment extraction + thumbnail |
| [`ClipStorageService.js`](../../server/services/ClipStorageService.js) | File storage (local + B2) |

Clips live in `/root/onestreamer/clips/{videos,thumbnails,temp}/`.

## Admin recording review

[`AdminRecordingReview.tsx`](../../client/src/components/admin/AdminRecordingReview.tsx) is the largest single React component in the app (~1.1k LOC). It provides:

- Browse sessions by streamer ([`StreamerList.tsx`](../../client/src/components/recording-review/StreamerList.tsx)) and session ([`SessionList.tsx`](../../client/src/components/recording-review/SessionList.tsx))
- Play recording with seek + speed (0.5×–2×) — [`SessionPlayer` / `PlaybackTimeline.tsx`](../../client/src/components/recording-review/PlaybackTimeline.tsx)
- Synced chat replay alongside the timeline ([`SyncedChatReplay.tsx`](../../client/src/components/recording-review/SyncedChatReplay.tsx))
- Extract a clip from a selected segment

Backend routes for review at `/admin/review/sessions/...` (see [`server/routes/admin-recordings.js`](../../server/routes/admin-recordings.js)).

## Operational notes

- **B2 streaming mode** is controlled by `B2_STREAMING_ENABLED`. When `true`, the admin review and clip-stream endpoints serve video directly from B2 via signed URLs (default TTL ~4 h); when `false`, they serve local files only.
- **Disk pressure**: `RecordingCleanupScheduler` deletes local files once the B2 upload is confirmed. If B2 credentials break, local files accumulate — monitor disk usage.
- **Concurrent recordings**: limited by `maxConcurrentRecordings` (3 by default; tunable in code).
- **Retention**: default 30 days locally (then deletion); B2 retention follows the bucket's lifecycle policy.

## Recording controls (admin)

In the admin panel → Recordings tab:

| Endpoint | Purpose |
|----------|---------|
| `POST /admin/recordings/start` | Start a new recording for a specific streamer |
| `POST /admin/recordings/stop/:recordingId` | Stop an active recording |
| `GET /admin/recordings/status/:recordingId` | Status snapshot |
| `GET /admin/recordings/list` | List all recordings |
| `GET /admin/recordings/download/:recordingId` | Download a finalized file |
| `DELETE /admin/recordings/:recordingId` | Delete |
| `GET /admin/recordings/active` | List active recordings |
| `GET /admin/recordings/system-status` | Aggregate stats (disk usage, compression queue, etc.) |
| `POST /admin/recordings/cleanup` | Manual cleanup pass |
| `POST /admin/recordings/settings` | Update recording config |

## Troubleshooting

| Symptom | First check |
|---------|-------------|
| Clips show `available:false` even with a live stream | `isRecording` flag in `/api/clips/status`. Recording may have stopped despite the stream being active; check `ContinuousRecordingService` logs. |
| New clip fails to render | `ClipProcessorService` log — FFmpeg error, missing source segment, or B2 fetch failure. |
| Segments missing in B2 | `RecordingUploadScheduler` log + B2 credentials valid. |
| Disk filling up | Confirm `RecordingUploadScheduler` is keeping pace; if not, egress segments stay local in `egress-recordings/`. See the [`recording-upload-failed.md`](../operations/runbooks/recording-upload-failed.md) runbook. |
| Admin review playback stutters | Browser fetching directly from B2 — check B2 bandwidth + signed-URL TTL hasn't expired mid-playback. |

## See also

- [`docs/integrations/backblaze-b2.md`](../integrations/backblaze-b2.md) — B2 credentials and bucket setup
- [`docs/operations/runbooks/recording-upload-failed.md`](../operations/runbooks/recording-upload-failed.md) — what to do when B2 uploads start failing
- [`docs/features/admin-panel.md`](admin-panel.md) — the full Recordings + Recording Review tabs
