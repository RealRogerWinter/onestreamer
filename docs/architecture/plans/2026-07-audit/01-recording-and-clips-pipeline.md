# Plan 01 — Recording & Clips pipeline redesign

_Part of the [2026-07 codebase audit](README.md). Owner area: `server/services/ContinuousRecordingService.js`, `server/services/recording/*`, `server/services/Recording*Scheduler.js`, `server/services/B2StorageService.js`, `server/services/ClipService.js`, `server/services/Clip*Service.js`, `server/routes/admin-recordings/*`._

> Status: **P0 merged (PR #25); P1.1–P1.3 landed via [ADR-0028](../../adr/0028-per-run-recording-sessions.md) (per-run session ids, terminal upload state, downgrade guard); P1.4 was shipped early as P0.5. P2.2 (R5/R6/R11 + terminal `upload_failed`) landed via [ADR-0034](../../adr/0034-b2-upload-ordering-multipart-timeouts.md) — B2 archival remains OFF as an operator decision (P2.1 still open).** Original audit status: proposed — the "known issues with the continuous recording system" resolve to one architectural decision (per-UTC-day session buckets) that is incompatible with the three cleanup/upload state machines layered on top of it.

## TL;DR

`egress-recordings/` is **37 GB** (day-buckets back to 2026-05-27) despite a configured **10-minute** local retention. This is not a tuning bug; it is a deadlock between three subsystems. It was independently verified against the live DB during the audit: **82 of 84 `recording_sessions` rows are stuck at `status='recording'`, 81 with `b2_file_id` NULL; exactly one session ever uploaded.** When this volume fills, SQLite, logs, HLS egress, and clipping all fail together — a full-site outage originating in the recording subsystem.

## How the pipeline works today

1. **`ContinuousRecordingService`** polls LiveKit every 5s. When a participant publishes video it starts a LiveKit Egress — **Participant Egress** for a real streamer, **Room Composite Egress** for a viewbot — writing 4s HLS `.ts` segments to a **per-UTC-day** directory `egress-recordings/recording_<YYYY-MM-DD>/`. Every same-day (re)start reuses that directory with a fresh `seg_<epochMs>` filename prefix.
2. **`RecordingSessionStore`** mirrors this to `recording_sessions` via `INSERT OR IGNORE` + `SET status='recording'`, and **deliberately never marks a session `'completed'`** (`RecordingSessionStore.js:76` — "session represents the whole day").
3. **`RecordingDiskScanner.cleanupOldRecordings`** (every 60s) deletes day-dirs older than 10 min **except** `currentSessionId` and **except** any dir whose row has `b2_file_id IS NULL` (`listSessionsPendingUpload` — `SELECT session_id FROM recording_sessions WHERE b2_file_id IS NULL`, no age cap, no status filter).
4. **`RecordingUploadScheduler`** (every 5 min) uploads on the `recording-stopped` event (`index.js:553`), but `start()` and `scheduleUpload()` both early-return when B2 is disabled, and restart-recovery (`loadPendingUploads`) selects only `status='completed'`.
5. **`RecordingCleanupScheduler`** (hourly) deletes DB rows + B2 files for sessions older than 7 days, but only `WHERE status IN ('completed','uploaded')`; it never deletes local files.

## Root cause — the deadlock

The state machine has no path out of `'recording'`:

- Nothing in the steady state sets `status='completed'` (the only writer is the upload-**failure** revert). → `RecordingCleanupScheduler` never fires, and `loadPendingUploads` recovers nothing after a restart.
- B2 is **disabled in the deployed env** (all six `B2_*` vars empty → `B2StorageService.enabled=false`). → uploads never run → `b2_file_id` stays NULL forever.
- `RecordingDiskScanner`'s pending-upload gate is **fail-closed with no age backstop**. → every day-dir is skipped forever.

A guard designed to prevent losing un-uploaded footage became the cause of unbounded disk growth. The directory-level deletion unit also makes "10-minute retention" semantically impossible: the active day is always `currentSessionId`, so it is never cleaned during the day regardless of segment age.

## Confirmed findings (all CONFIRMED unless noted)

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| R1 | **critical** | Fail-closed pending-upload gate with no age cap exempts every day bucket — the 37 GB leak | `recording/RecordingDiskScanner.js:367` |
| R2 | **critical** _(latent — needs B2 on)_ | Second recording of the same UTC day is silently destroyed: upload skipped as "already uploaded" while the 60s cleanup deletes its local files | `RecordingUploadScheduler.js:138` |
| R3 | high | Upload can never recover after restart: sessions never reach `status='completed'`, the only recovery status | `RecordingUploadScheduler.js:53` |
| R4 | high _(latent — needs B2 on)_ | Scheduled upload `rm -rf`s the LIVE day bucket when recording restarted the same day (data loss + breaks live buffer) | `RecordingUploadScheduler.js:184` |
| R5 | high | B2 concat sorts by shared egress timestamp only, leaving within-run order to `readdir()` → scrambled archive video | `B2StorageService.js:66` |
| R6 | high | Whole-day recordings uploaded via single `PutObject`: files > 5 GB can never upload, retry every 30 min forever | `B2StorageService.js:146` |
| R7 | **high** | Room-composite egress never auto-stops when the room empties → encodes an empty room 24/7 (explains the 11 GB / 8.6 GB day-buckets); the active-dir runaway P0 backstops can't bound | `ContinuousRecordingService.js:231` |
| R8 | medium | Same-day restart flips `'uploaded'`→`'recording'`, hiding the row from DB cleanup forever (observed live on `recording_2026-06-09`) | `ContinuousRecordingRepository.js:89` |
| R9 | medium | Day-granularity session IDs make retention unenforceable and create a delete-fresh-segments race on target switches | `recording/RecordingDiskScanner.js:359` |
| R10 | medium | Both non-live clip-creation paths are dead: `createClipFromRecording` calls nonexistent `checkRateLimit`; `POST /api/clips` calls nonexistent `createClip` — both throw before any DB write (phantom `processing` rows come from the *live* `createLiveClip`, not these) | `ClipService.js:239` |
| R11 | medium | B2 concat ffmpeg has no timeout; one hung ffmpeg latches `isProcessing=true` and halts all future uploads | `B2StorageService.js:85` |
| R12 | medium | Pino misuse drops error objects across `recording/*` — weeks of cleanup failures were unobservable | `recording/RecordingDiskScanner.js:398` |
| — | (ops) | 37 GB retention breakage restated from the operability lens; needs a disk-budget backstop | `ContinuousRecordingRepository.js:191` |

## Remediation plan

### P0 — stop the bleeding (hours, low risk, no redesign)

These are surgical and independently shippable; they end the outage risk without waiting for the redesign.

- **P0.1 — Age-backstop the disk gate.** In `cleanupOldRecordings`, only honor the pending-upload skip while the dir is younger than `localBufferHours + retryWindow`; past that, delete regardless and `logger.warn` loudly. Mirrors the DB side's existing `extendedCutoff` valve. **Measure dir age from the newest segment's mtime, never the dir-name date** — the dir-name date reads a whole UTC day as "hours old" and would delete today's minutes-old segments the moment `currentSessionId` goes null (the target-switch gap, widened by P1.4). Before B2 is ever enabled, re-derive the backstop window from the worst-case multipart-upload duration (or make it honor an in-flight `status='processing'` row regardless of age) so P0.1 can't race an upload in progress. _(Fixes R1.)_
- **P0.2 — Hard disk-budget backstop.** Independent of upload state: if `egress-recordings/` exceeds a configured budget (e.g. 20 GB), delete oldest **non-current** day-dirs until under budget, logging each deletion. Never delete `currentSessionId`, a dir with a segment mtime inside the retention window, or a dir referenced by an in-flight `ClipProcessorService` job (the processor reads `.ts` files **in place** via ffmpeg's concat list — it does not stage copies — so deleting under it corrupts the clip). Defense in depth against any future gate regression. **Caveat:** P0.2 exempts `currentSessionId`, so it does **not** bound an *active* runaway — a single continuous egress (especially the empty-room composite of R7, which never auto-stops) keeps one dir as `currentSessionId` for days. The active-dir bound is R7 auto-stop (see P0.5) or segment-level retention (P2.1); on today's day-granularity dirs, P0 alone bounds only reclaimable non-current buckets.
- **P0.3 — One-time reclaim.** Manually remove the May/June day-dirs after confirming no un-uploaded footage is wanted (B2 is off, so none is archived anyway). ~37 GB back immediately.
- **P0.4 — Fix pino calls** in `recording/*` to `logger.error({ err }, 'msg')` so P0.1/P0.2 are verifiable in prod logs. _(Fixes R12; prerequisite for trusting the rest.)_
- **P0.5 — Auto-stop idle egress (pulled forward from P1.4).** This is the real bleed-stopper for the 11 GB / 8.6 GB single-day buckets: R7 is what lets one `currentSessionId` grow unbounded past every P0 backstop. Track consecutive no-publisher polls and `stopRecording()` after a bounded grace (e.g. 6 polls = 30s). Ship *before* P1.1 is not required, but P0.1's mtime-based age measure **is** a prerequisite, since auto-stop widens the `currentSessionId=null` window. _(Fixes R7; R7 is effectively high, not medium.)_

### P1 — correct the lifecycle (days, medium risk)

- **P1.1 — Per-run session IDs.** Change `sessionId` from `recording_<date>` to `recording_<date>_<startEpoch>` so each egress run owns an **immutable** directory. This single change dissolves R2, R4, R8, R9 (dirs stop being reused; age tests become meaningful; upload units are immutable; no live-bucket deletion). **Load-bearing requirement (do NOT skip):** `RecordingDiskScanner._parseSessionDir` (`RecordingDiskScanner.js:285`) hard-codes `^recording_(\d{4}-\d{2}-\d{2})$`, and every consumer gates on it — `_scanSessionDirs` skips non-matching dirs, `cleanupOldRecordings` only deletes what it parses, and `findSegmentsForClip` reads the scan output. If the regex isn't updated in lockstep to accept `recording_<date>_<epoch>` (returning the epoch as `sessionTs` so age uses run-start), new-format dirs become invisible to cleanup (**the leak returns, worse**) *and* invisible to clip lookup (**all new clips silently break**). The earlier claim that "clip lookup keys on mtime so it's unaffected" was wrong — mtime only orders segments *within* an already-name-matched dir. Also requires: `createSessionRecord` per run; admin-review timeline/playback to group runs by day for the UI (add a derived `day` column). **Gate P1.1 behind a scanner unit test** asserting new-format dirs are both cleaned and clippable — the admin-recordings characterization test only covers the read API.
- **P1.2 — Reach a terminal upload state.** On `recording-stopped`, set `status='completed'` (or add `awaiting_upload`). Make `loadPendingUploads` status-agnostic: `b2_file_id IS NULL AND end_time IS NOT NULL AND status != 'uploaded'`, and reset stale `processing` rows on boot. Re-run discovery on every tick, but **additively** — enqueue a session only if it is not already in `uploadQueue` and not currently processing. A naive "reload every tick" would overwrite the 30-min retry backoff (`RecordingUploadScheduler.js:112`) with `end_time + localBufferHours` (a past timestamp for old rows), making the session immediately "due" and turning backoff into a tight 5-min retry against B2 / a hung ffmpeg. _(Fixes R3.)_
- **P1.3 — Guard `setSessionRecording` against downgrading terminal states** (`... WHERE status NOT IN ('uploaded','processing')`) — but P1.1 largely moots this since runs no longer share rows. _(Fixes R8.)_
- **P1.4 — Auto-stop idle egress.** Track consecutive no-publisher polls; after a bounded grace (e.g. 6 polls = 30s) call `stopRecording()` regardless of target type. _(Fixes R7 — a major contributor to per-day GB.)_

### P2 — archive correctness & decoupling (days–weeks)

- **P2.1 — Decouple local retention from B2.** Make local a pure rolling clip buffer with **segment-level** retention (delete `.ts` by mtime older than the window, then prune empty dirs), never gated on upload. B2 becomes an independent archive tier. **This forces a change to *when* B2 uploads:** today the uploader fires at `end_time + localBufferHours` (2h), but a 10-minute local window deletes the segments long before then, starving the archive. So P2.1 must land with **eager upload** (concat + push while segments are still inside the rolling window) **or** a staged copy of the run for B2 — not the current 2h-delayed whole-day upload. This is the durable fix for R1/R9 and makes the 10-minute window actually mean 10 minutes.
- **P2.2 — Ordered, multipart, timed B2 upload.** Sort concat by `(timestamp, index)` tuples parsed from `seg_<ts>_<idx>.ts` (or read order from each `playlist_<ts>.m3u8`); switch `uploadRecording` to `@aws-sdk/lib-storage` `Upload` (automatic multipart) so > 5 GB works; add a spawn timeout to the concat ffmpeg and a watchdog on the `isProcessing` latch; add a terminal `upload_failed` status after N retries so the cleaner can reclaim. _(Fixes R5, R6, R11.)_
- **P2.3 — Fix or delete the dead clip paths.** Either implement `createClipFromRecording` (rename `checkRateLimit`→`checkRateLimits`, resolve `sessionId`→segments via `findSegmentsForClip`) and `POST /api/clips` (the nonexistent `createClip`) or delete both. These dead paths **throw before any DB write**, so they do not orphan rows. The genuine phantom-`processing`-row risk is on the **live** path: `createLiveClip` inserts the `clips` row (`ClipService.js:177`) *before* `queueClip`, so a processor failure leaves a stuck `processing` row. Move the "insert only after preconditions pass" guard there. _(Fixes R10.)_

## Risks & red-team notes

- **P1.1 changes the admin-review data model.** The timeline/playback/master-stream endpoints currently assume one row per day. They must group runs by day for display. Mitigation: keep a `day` column derived from `start_time`; the UI groups on it. Ship P1.1 behind read-side compatibility tests (`admin-recordings.characterization.test.js` is the byte-equivalence anchor).
- **P0.2's disk-budget deletion could race an in-progress clip extraction.** `ClipProcessorService` reads `.ts` files **in place** from `egress-recordings` via ffmpeg's concat list (only the concat `.txt` goes to temp) — it does **not** stage copies. So the mitigation is: never delete `currentSessionId`, a dir with a segment mtime inside the retention window, or a dir referenced by an in-flight clip job. (A cleaner long-term fix is to have the processor copy segments to a staging dir first, which it currently does not.)
- **B2 is off today**, so R2, R4, R5, R6 and the P1.2/P2.2 fixes are all **latent until B2 is enabled** — only R1, R7, R12 are causing the live 37 GB leak now. But the latent items must land *before* B2 is enabled, or enabling it triggers R4's live-bucket deletion. Sequencing: **P1.1 (per-run dirs) is a hard prerequisite for turning B2 on**, and P0.1's backstop window must be re-derived against worst-case upload duration first.
- **Do not** "fix" this by raising `retentionMinutes` — that treats the symptom and still can't express a rolling window over day-dirs.

## Success criteria

- `egress-recordings/` steady-state size tracks the configured rolling window (≈ minutes of segments), verified over a multi-day run with several restarts and takeovers.
- A same-day second stream is fully recorded and (when B2 on) archived — no silent loss; `admin-recordings.characterization.test.js` still green.
- With B2 enabled, a > 5 GB run uploads via multipart, in-order, and to the archive tier; local retention runs on its own rolling-window clock (segment mtime), **not** gated on upload confirmation (the tiers are decoupled per P2.1).
- New tests: per-run session isolation; disk-budget backstop; auto-stop-on-empty; concat ordering with two same-timestamp runs.
