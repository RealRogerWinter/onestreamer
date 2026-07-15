# ADR-0034: B2 archival upload — tuple-ordered concat, multipart upload, bounded execution, terminal `upload_failed`

_Status: accepted_
_Date: 2026-07-15_

## Context

ADR-0028 (per-run recording sessions) fixed the recording lifecycle but left
three latent defects that make enabling Backblaze B2 archival unsafe — the
audit's Plan 01 P2.2 gate (findings **R5**, **R6**, **R11**):

- **R5** — `B2StorageService.concatenateSegments` sorted segments by the
  *first* number in `seg_<epochMs>_<idx>.ts` — the shared egress timestamp —
  so every segment of one run tied and the order fell back to `readdir()`
  (filesystem hash order): a scrambled archive video.
- **R6** — `uploadRecording` used a single `PutObject`, which S3/B2 hard-caps
  at 5 GB. A larger whole-run archive failed every attempt and retried every
  30 minutes forever.
- **R11** — the concat ffmpeg had no timeout. One hung child never resolved
  the promise chain, latching `RecordingUploadScheduler.isProcessing` and
  halting **all** future uploads.

There was also no terminal failure state: `status` only ever reverted to
`'completed'`, so a permanently-unuploadable session retried until the disk
scanner reclaimed its directory (26 h) and then kept failing on
"Local recording not found" forever.

## Decision

1. **Tuple sort** — concat order is the full numeric `(timestamp, index)`
   tuple parsed from `seg_<ts>_<idx>.ts`. Numeric (not lexicographic) index
   compare, because the `%05d` INDEX grows to 6 digits past segment 99999.
   The tuple (not index alone) keeps legacy day-bucket dirs — multiple
   `seg_<ts>_` prefixes per dir, still on the prod volume back to
   2026-05-27 — in true order. Non-matching `.ts` files are excluded and
   logged, not concatenated. The playlist-read alternative was rejected:
   playlists can be truncated by an egress crash while the `.ts` files
   survive.
2. **Multipart upload** — `@aws-sdk/lib-storage`'s `Upload` (new dependency,
   version-locked to the existing `@aws-sdk/client-s3` line) with 64 MiB
   parts (640 GB ceiling at the 10k-part cap), `queueSize: 2` (~128 MB
   buffer bound), and `leavePartsOnError: false` (no orphaned billed parts).
   Multipart ETags (`hash-N`) land in `b2_file_id`, which nothing parses.
3. **Bounded execution everywhere** — the concat ffmpeg gets a SIGKILL
   timeout (`B2_CONCAT_TIMEOUT_MS`, default 30 min; kill is
   descendant-scoped-safe per ADR-0032), and the `S3Client` gets
   `connectionTimeout: 10s` / `requestTimeout: 120s` (socket-inactivity, so
   slow-but-progressing parts survive). With both, every await under the
   scheduler's `isProcessing` latch terminates. The latch also gains an
   **alarm-only watchdog** (log at > 2 h held) — no forced release, because
   force-clearing could double-run a concat onto the same temp file.
4. **Terminal `upload_failed`** — no schema change (`status` is TEXT, no
   CHECK): (a) a missing local source dir (reclaimed at 26 h) marks the row
   `upload_failed` immediately; (b) `maxUploadAttempts` (12 × 30 min ≈ 6 h)
   consecutive transient failures do the same. The attempt counter is
   deliberately in-memory — a restart resets it, but path (a) guarantees
   termination anyway, and persisting it would cost an ALTER TABLE +
   ADR-0030 snapshot regeneration for no behavioral gain. `upload_failed`
   rows are excluded from upload recovery and from the disk scanner's
   pending-upload gate, and the DB-row cleaner reaps them at plain
   retention. The admin force-upload route still works on them (it keys on
   `b2_file_id`, not status) — a successful manual retry flips them to
   `'uploaded'`.

## Consequences

- The P2.2 blockers recorded in ADR-0028 are closed. **B2 archival remains
  OFF** — enabling it is a deliberate operator decision, and Plan 01 **P2.1
  (decoupled rolling-window retention / eager upload) is still open**: with
  the current 2 h buffer + 26 h pending grace, uploads work, but the
  10-minute local retention still cannot be honored for pending-upload dirs.
- On first enablement, the legacy May/June backlog (dirs long reclaimed)
  will churn through local-missing → `upload_failed` → reaped: a one-time
  burst of `upload_failed` logs is expected and correct.
- The every-boot backfill migration (202607140001) touches only
  `'recording'`/`'processing'` rows — `upload_failed` survives restarts.
