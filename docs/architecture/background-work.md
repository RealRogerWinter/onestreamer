# Background work inventory

_Last verified: 2026-06-01 against `main` (post-ADR-0024 LiveKit-only cleanup)._

Mechanical catalogue of every `setInterval`, `setTimeout`, and long-lived child process across `server/`. Companion to [`/docs/architecture/service-catalog.md`](service-catalog.md): the catalog says what each service *is*, this page says what work each service *runs in the background*.

The point of the page is to make the Phase 2 lifecycle work mechanical. Today the timers are scattered across module scope and constructors with no central registry; once each service that owns a handle gets a `stop()` method, this list is the work-item.

## Counts

| Kind | Where |
|------|-------|
| `setInterval` | live services (most — see the two tables below), `server/index.js` (the streaming-time sync at `server/index.js` `setInterval` callsite) |
| `setTimeout` | services (most), `server/index.js`; the bulk are one-shot deferred work and are not lifecycle hazards. The "schedule autostart / grace-period" shapes now route through `LifecycleManager` (see hazard note). |
| `ffmpeg` child processes | URL relay (`urlstream/FFmpegPipeline.js`, spawned per URL stream), recording (`ContinuousRecordingService`), clip processing — exit on stream end / EOF |
| `streamlink` / `yt-dlp` | URL relay source pull (`ViewBotURLService` → `urlstream/`), piped into `ffmpeg` → RTMP → LiveKit ingress — exit on stream end |
| `whisper.cpp` | spawned per transcription run by `transcription/WhisperRunner.js` (driven by `TranscriptionService`) — exits when the WAV chunk is transcribed |

> [!NOTE]
> Re-run the refresh grep (bottom of page) for exact counts; the tables below are the verified, named timers as of the last-verified date, not a raw count. The old per-viewbot Puppeteer/Chromium fleet and the in-process MediaSoup SFU are **gone** ([ADR-0024](adr/0024-retire-mediasoup-livekit-only.md)) — LiveKit is the sole WebRTC backend, so there is no longer any browser-per-viewbot or `MediasoupService` stats-polling background work.

## The two patterns

### "Owned" — handle stored on `this`, can be cleared on `stop()`

Already lifecycle-ready. Phase 2 adds `stop() { clearInterval(this.X); }` to each, and the service factory returns these in a `stoppables` array for reverse-order shutdown. The 20 services below are the **easy** half.

| Service / file | Handle | Description |
|----------------|--------|-------------|
| `ResourceMonitor` (`services/ResourceMonitor.js`) | `monitoringInterval` | CPU/mem polling for the admin dashboard |
| `LiveKitService` (`services/LiveKitService.js`) | `healthCheckTimer` | LiveKit server/room health probe (the sole WebRTC backend) |
| `EgressFrameCaptureService` (`services/EgressFrameCaptureService.js`) | `_cleanupTimer` | reaps stale LiveKit egress frame-capture jobs |
| `ContinuousRecordingService` (`services/ContinuousRecordingService.js`) | `autoRecordInterval` | polls the LiveKit room for active streams to start egress recording |
| `ContinuousRecordingService` → disk scanner (`recording/RecordingDiskScanner.js`) | `cleanupInterval` | scans recording disk, prunes old segments |
| `RecordingUploadScheduler` (`services/RecordingUploadScheduler.js`) | `checkInterval` | scan local recording segments, push to B2 |
| `RecordingCleanupScheduler` (`services/RecordingCleanupScheduler.js`) | `checkInterval` | delete-by-age cleanup *(see hazard note below)* |
| `TranscriptionService` (`services/TranscriptionService.js`) | `session.transcriptionInterval` | per-session tick that hands the buffered WAV to `WhisperRunner` |
| `AudioFileJanitor` (`services/transcription/AudioFileJanitor.js`) | anonymous | deletes consumed PCM/WAV transcription chunks |
| `RandomStreamRotationService` → scheduler (`random-stream/RotationScheduler.js`) | `rotationTimer` + `countdownAnnouncementTimers` | next-rotation `setTimeout` + `!extend` countdown nudges |
| `RandomStreamRotationService` → recovery (`random-stream/RotationRecoveryMonitor.js`) | `autoRestartMonitor` | auto-restart watchdog for a wedged rotation |
| `URLStreamHealthService` (`services/URLStreamHealthService.js`) | `checkTimer` | URL stream up/down probe |
| `AudioOptimizationService` (`services/AudioOptimizationService.js`) | `monitoringInterval` | audio quality polling |
| `PortMonitorService` (`services/PortMonitorService.js`) | `monitorInterval` | port state polling |
| `BuffDebuffService` (`services/BuffDebuffService.js`) | `updateInterval` | buff duration tick |
| `CanvasFxService` → bridge (`services/canvasfx/BuffEffectBridge.js`) | `streamerCheckInterval` | streamer-online polling for canvas FX |
| `BuffDebuffService` cache (`services/buffdebuff/CacheCleaner.js`) | `cacheCleanupInterval` | evicts stale buff cache entries |
| `game/GameLoopManager.js` | `intervalId` | game world tick |
| `TimeTrackingService` (`services/TimeTrackingService.js`) | `cleanupIntervalId` | session cleanup |
| `AccountDeletionScheduler` (`services/AccountDeletionScheduler.js`) | `intervalId` | 15-day grace check |
| `moderation/Retention.js` | `_retentionTimer` | daily retention/purge scheduler |
| `StreamBotService` schedulers (`services/streambot/PeriodicMessageScheduler.js`, `AutoSummonManager.js`) | `intervalId` / `autoSummonIntervalId` | periodic announcements + auto-summon ticks |

### "Module-scope" or "constructor-leaked" — no handle on instance, can't be stopped

These are the **hard** half. Each is created without storing the handle on a state location, so there's nothing to clear. Phase 2 fixes each one by relocating the handle and adding `stop()`. The surface shrank sharply post-ADR-0024: the ~45-site `ViewBotClientService`, the 5-site `MediasoupService`, `ViewBotSocketClient`, `VisualFxService`, `RecordingStorageService`, and `FileCompressionService` rows that used to dominate this list are **all deleted** along with the per-viewbot browser fleet and the in-process MediaSoup SFU. What remains:

| Site | Severity | Notes |
|------|----------|-------|
| `server/index.js` streaming-time sync (`setInterval` callsite) | Medium | Module-scope, never stopped. |
| `services/chatbot/llm/ollamaQueue.js:117` | Medium | Anonymous `setInterval` (Ollama request-queue drain), no handle saved. |
| `services/transcription/AudioFileJanitor.js:87` | Low-Medium | Anonymous `setInterval` (consumed-WAV sweep); fires for the process lifetime — relocate the handle when `TranscriptionService` gets a `stop()`. |
| `services/TimeTrackingService.js:351` | Low | A second anonymous `setInterval` inside a method (distinct from the owned `cleanupIntervalId`), no handle saved. |

## Notable hazards

### Recording cleanup races recording upload

`RecordingCleanupScheduler.js:27` deletes local segments **by age** with no check on `b2_file_id IS NOT NULL`. `RecordingUploadScheduler.js:37` retries failed uploads on a separate cadence. If an upload fails for longer than the cleanup window, the local segment vanishes before the upload retries — silent data loss.

This is Phase 2 PR 2.6's target (see refactor plan); the fix is to gate cleanup on confirmed upload, in the same PR that adds the deterministic test.

### ~~`setTimeout` chains in `server/index.js` startup~~ (resolved by PR 4.2)

Originally flagged: `server/index.js:5242, 5319, 5401, 5505, 5514, 5913, 5952, 6140` schedule autostarts and graceful-shutdown work with no per-handle reference. If service init fails partway, the deferred work still fires against torn-down state.

**Resolved in PR 4.2** ([ADR-0011](adr/0011-lifecycle-manager.md)). New `LifecycleManager` service (`server/services/LifecycleManager.js`) is the registry for one-shot deferred work; every `setTimeout(fn, delayMs)` callsite that matched the "schedule autostart / grace-period" pattern was relocated to `lifecycleManager.schedule(name, fn, delayMs)`. Stoppable; SIGTERM clears every pending handle before the dependent services tear down. Two dev-debug `setTimeout` sites (`'test-event'` emit + `getStreamerDisplayName` smoke loop) were **deleted** rather than relocated. Two non-scheduler shapes (`Promise.race` deadline + `await new Promise(r => setTimeout(r, 500))` sleep) are intentionally left untouched — different shape, different teardown story.

### ~~`global.viewBotIntervals` Map~~ (resolved by deletion in PR 3.4)

This section originally flagged a `Map<streamerId, interval>` at `server/index.js:859–883` as a partial-cleanup hazard. Phase 3 PR 3.4 mapped the callsites and found the Map had zero producers in practice: the three module-scope helpers that wrote to it (`createViewBotProducer`, `startSyntheticMediaGeneration`, `generateViewBotRtpParameters`) had **no callers anywhere in the codebase since the initial commit** — confirmed by `grep` across `server/`, `client/`, `chat-service/`, and `git log --all -S "createViewBotProducer("` showing no commit ever added a call site. The "leak on incomplete cleanup" was structurally impossible because nothing ever populated the Map.

PR 3.4 deleted the three helpers and the Map reference. The previous wording here ("some paths clear, others don't") was based on reading the file rather than tracing callers — corrected for the record.

## Child processes

Less concerning for lifecycle since they exit on their own work boundaries:

- **`ffmpeg`**: spawned for recording (`ContinuousRecordingService`), URL relay (`urlstream/FFmpegPipeline.js`, driven by `ViewBotURLService`), and clip processing. On the URL-relay path it transcodes the source to RTMP that feeds **LiveKit ingress**. Exits when the stream ends or input EOFs. Wedge cases (stuck source) are not currently reaped by timeout — flagged as Phase 1 PR 2.6 territory. Orphans from server restarts / failed cleanup are pattern-killed on the next URL-stream start by `urlstream/IngressJanitor.js` (`pkill -f "streamlink.*twitch|..."`), which runs on-demand, not on a timer.
- **`streamlink` / `yt-dlp`**: pull the upstream source (Twitch/Kick/YouTube/etc.) for the URL-relay path and pipe into `ffmpeg`. Spawned per URL stream, torn down with the relay. There is **no per-viewbot Chromium** anymore — the Puppeteer browser fleet was removed with the MediaSoup retirement ([ADR-0024](adr/0024-retire-mediasoup-livekit-only.md)); viewbots now join the LiveKit room headlessly (`ViewBotLiveKitService`) or via the URL-relay ingress.
- **`whisper.cpp`**: spawned by `transcription/WhisperRunner.js` per transcription run (whisper.cpp). It has its own SIGTERM→SIGKILL timeout (`WhisperRunner.js`) so a hung run is reaped; the PCM/WAV it consumes comes from `TranscriptionAudioAdapter` (LiveKit RTC audio capture).

## Atomic-SQL audit closure

_Verified 2026-05-27 (Phase 8 PR 8.1)._ Cross-reference: [ADR-0013a](adr/0013a-atomic-sql-for-mutable-counters.md).

[ADR-0013a](adr/0013a-atomic-sql-for-mutable-counters.md) codifies the relative-arithmetic write pattern (`SET col = col + ?`) for mutable counters. This audit enumerates the six counter columns called out in the runbook follow-up — `total_stream_time`, `total_view_time`, `stream_count`, `chat_message_count`, `view_count`, `quantity` — and classifies the write path of each.

| Column | Table(s) | Writer | Pattern |
|--------|----------|--------|---------|
| `total_stream_time` | `user_stats` | `AccountService.updateUserStats` ([line 170](../../server/services/AccountService.js)) | Relative arithmetic ✓ |
| `total_view_time` | `user_stats` | `AccountService.updateUserStats` ([line 175](../../server/services/AccountService.js)) | Relative arithmetic ✓ |
| `stream_count` | `user_stats` | `AccountService.updateUserStats` ([line 180](../../server/services/AccountService.js)) | Relative arithmetic ✓ |
| `chat_message_count` | `user_stats` | `AccountService.updateUserStats` ([line 185](../../server/services/AccountService.js)) | Relative arithmetic ✓ |
| `view_count` | `clips` | `ClipService.incrementClipViews` ([line 431](../../server/services/ClipService.js)) | Relative arithmetic ✓ |
| `chat_message_count` | `recording_sessions` | `SessionChatCaptureService.updateSessionChatCount` ([line 164](../../server/services/SessionChatCaptureService.js)) | Derived recompute — `SELECT COUNT(*) FROM session_chat_messages WHERE session_id = ?` followed by absolute `SET chat_message_count = ?`. A single capture-service instance owns each session_id; the next tick re-derives, so a missed message becomes lag, not loss. |
| `quantity` | `user_inventory` | `UserInventoryRepository.updateQuantity` ([line 194](../../server/database/repository/UserInventoryRepository.js)) | Absolute set (read-compute-write). The purchase path is closed by PR 7.4's `withTransaction` wrap. Other callers (`InventoryService.addItemToInventory` / `removeItemFromInventory`) are invoked from request handlers only (auth signup grant, `routes/buffs.js`, `routes/internal.js` admin grant + gift, `sockets/BuffHandler.js`) — never from background timers. Race-vulnerable only if the same user fires concurrent inventory-mutating requests for the same item_id; in the [single-tenant single-streamer scope](../../README.md) this is bounded by per-user request cadence. Flagged for follow-up if a future feature adds a background mutator. |
| `quantity` | `item_transactions`, `gift_transactions` | Insert-only audit ledgers | Not a mutable counter — each row is immutable once written. |

**Repro:**

```bash
grep -rnE "(SELECT|getAsync|allAsync|UPDATE).*(stream_time|view_time|chat_message_count|stream_count|quantity|view_count)" server/ --include='*.js' | grep -v tests/
```

No race-vulnerable read-compute-write site found among the six listed counters as of the verification date. Future audits should re-run the grep before adding new counter writes.

## Refresh

```bash
grep -rn -E '\b(setInterval|setTimeout)\b' server/ --include='*.js' | grep -v node_modules | wc -l
grep -rn 'this\.\w*(Interval|Timer|Id) = setInterval' server/ --include='*.js' | grep -v node_modules
```

When this file drifts, it drifts toward "more leaked, more scattered" — drift in the wrong direction is a Phase 2 signal.
