# ADR-0028: Per-run recording sessions with a terminal upload state

_Status: accepted_
_Date: 2026-07-14_

## Context

Continuous recording wrote every same-day run into one shared per-day bucket: `startRecording()` built `recording_<YYYY-MM-DD>` as the session id, so a stream → stop → re-stream day shared one directory on disk and one `recording_sessions` row. That model was deliberate (the row "represents the whole day's recording"), and two design choices followed from it: the row never reached a terminal status, and `segment_count`/duration accumulated across runs.

The 2026-07 audit ([Plan 01](../plans/2026-07-audit/01-recording-and-clips-pipeline.md)) traced four of its recording findings back to exactly this model:

- **R2** — a same-day second run is skipped by the upload path as "already uploaded" (the day-row already carries `b2_file_id` from the first run), so its footage is never archived — and then deleted.
- **R4** — the post-upload cleanup `rm -rf`s the day directory while a later run is actively writing into it.
- **R3** — restart recovery selected `WHERE status = 'completed'`, a status nothing ever wrote, so a restart stranded every pending upload forever.
- **R9** — day-granularity ids are the root cause underneath R2/R4.

The DB side compounded it: `RecordingCleanupScheduler` only reaps rows with `status IN ('completed','uploaded')`, so finished sessions (all stuck at `'recording'`) accumulated indefinitely (~82 rows on the production DB).

Backblaze B2 archival is currently **disabled** (no `B2_*` env vars), which is why R2/R4 are latent rather than live. The audit's plan gates enabling B2 on fixing this model first.

## Decision

1. **Per-run session ids**: `startRecording()` now builds `recording_<YYYY-MM-DD>_<epochMs>` (the epoch is the run's start, reused as the egress filename-prefix timestamp). Every run owns an immutable directory and its own `recording_sessions` row.
2. **Terminal lifecycle**: `recording → completed → processing → uploaded`, with upload failure reverting `processing → completed`. `stopRecording()` now marks the run's row `'completed'` (guarded `WHERE status = 'recording'`); `setSessionRecording` refuses to downgrade `'uploaded'`/`'processing'` rows (audit R8).
3. **Status-agnostic, additive upload recovery**: `loadPendingUploads` selects `b2_file_id IS NULL AND end_time IS NOT NULL AND status != 'uploaded'` and re-runs on every scheduler tick, but never overwrites an entry already in the queue — preserving the 30-minute retry backoff instead of collapsing it into a tight loop.
4. **Lockstep parser**: `RecordingDiskScanner._parseSessionDir` recognizes the new format first and **keeps** the day-bucket and legacy `session_<ms>` patterns so pre-cutover directories still age out. The producer format and the parser must only ever change together (gated by `RecordingDiskScanner.parseSessionDir.test.js`).
5. **Every-boot backfill** (`202607140001`): finished rows stuck at `'recording'`/`'processing'` with `end_time` set are marked `'completed'`, making them visible to upload recovery and DB-row reaping.

## Consequences

- R2 and R4 dissolve structurally: no two runs ever share a directory or a row, so "already uploaded" is always true-per-run and post-upload deletion only ever removes that run's immutable dir. R3 dissolves via the terminal state + recovery query.
- `recording_sessions` grows one row per run instead of one per day. That is the point — and the terminal state is what lets `RecordingCleanupScheduler` finally reap them, so steady-state row count is bounded by the retention window.
- `updateSessionEnd`'s accumulate semantics (`segment_count = segment_count + ?`) degenerate to set-once on per-run rows — correct, no change needed.
- Admin review endpoints (timeline/playback/master-stream) iterate all session rows ordered by `start_time` and already handle multiple playlists per directory, so they need no structural change; a day now yields several list entries instead of one.
- Old day-format directories on disk remain parseable and age out via segment-mtime rules; their name-derived timestamp (UTC midnight) only matters for empty dirs.
- **B2 stays off.** Per-run ids are necessary but not sufficient for enabling archival: the concat ordering, single-PutObject 5 GB ceiling, and missing ffmpeg timeout (audit R5/R6/R11, Plan 01 P2.2) must land first. _Update 2026-07-15: those blockers are closed by [ADR-0034](0034-b2-upload-ordering-multipart-timeouts.md); enablement remains a deliberate operator decision (P2.1 retention decoupling is still open)._
- A derived `day` column for admin grouping was considered and deferred — the read endpoints don't need it, and schema shape is owned by the Plan 04 single-source-DDL work.

## Alternatives considered

- **Keep per-day buckets, fix upload/cleanup edge cases individually** — every fix fights the shared-mutable-directory model (the skip-and-delete hazards are inherent to sharing); rejected.
- **UUID session ids** — loses the at-a-glance date ordering that operators and the legacy parser rely on; the date+epoch composite keeps ids sortable and human-readable.
- **A `schema_migrations`-tracked one-shot backfill** — ADR-0022 deliberately uses idempotent every-boot migrations; the backfill's predicate (`end_time IS NOT NULL`) is inherently safe to re-run, including against live recordings (their `end_time` is NULL until stop).
