# Background work inventory

_Last verified: 2026-05-26 against `main` at the start of Phase 0._

Mechanical catalogue of every `setInterval`, `setTimeout`, and long-lived child process across `server/`. Companion to [`/docs/architecture/service-catalog.md`](service-catalog.md): the catalog says what each service *is*, this page says what work each service *runs in the background*.

The point of the page is to make the Phase 2 lifecycle work mechanical. Today the timers are scattered across module scope and constructors with no central registry; once each service that owns a handle gets a `stop()` method, this list is the work-item.

## Counts

| Kind | Count | Where |
|------|-------|-------|
| `setInterval` | 53 | services (most), `server/index.js` (5), socket handlers (1) |
| `setTimeout` | 175 | services (most), `server/index.js` (~10); the bulk are one-shot deferred work and are not lifecycle hazards |
| `ffmpeg` child processes | ~21 callsites across `ContinuousRecordingService`, `RecordingService`, `ViewBotURLService`, clip processing | spawned per stream/session, exit on stream end |
| `puppeteer` / Chromium | ~8 launches across `ViewBotClientService`, `ViewBotWebRTCService` | one browser per viewbot |
| `whisper.cpp` | spawned per transcription session in `TranscriptionService` | exit on stream end |

## The two patterns

### "Owned" — handle stored on `this`, can be cleared on `stop()`

Already lifecycle-ready. Phase 2 adds `stop() { clearInterval(this.X); }` to each, and the service factory returns these in a `stoppables` array for reverse-order shutdown. The 20 services below are the **easy** half.

| Site | Service | Description |
|------|---------|-------------|
| `services/ResourceMonitor.js:76` | `ResourceMonitor` | `monitoringInterval` — CPU/mem polling for the admin dashboard |
| `services/RecordingUploadScheduler.js:37` | `RecordingUploadScheduler` | `checkInterval` — scan local segments, push to B2 |
| `services/LiveKitService.js:592` | `LiveKitService` | `healthCheckTimer` — server-room health |
| `services/ViewBotClientService.js:1452` | `ViewBotClientService` | `validationTimer` — Puppeteer page validation |
| `services/ViewBotClientService.js:3901` | `ViewBotClientService` | `pipelineHealthCheckTimer` — WebRTC pipeline checks |
| `services/ViewBotManager.js:199` | `ViewBotManager` | `rotationTimer` — viewbot rotation tick |
| `services/RtpReceiver.js:127` | `RtpReceiver` | `accumulatorInterval` — RTP packet accumulation |
| `services/URLStreamHealthService.js:49` | `URLStreamHealthService` | `checkTimer` — URL stream up/down probe |
| `services/AudioOptimizationService.js:416` | `AudioOptimizationService` | `monitoringInterval` — audio quality polling |
| `services/PortMonitorService.js:29` | `PortMonitorService` | `monitorInterval` — port state polling |
| `services/ViewbotService.js:427` | `ViewbotService` | `simulationTimer` — viewbot frame simulation |
| `services/BuffDebuffService.js:597` | `BuffDebuffService` | `updateInterval` — buff duration tick |
| `services/CanvasFxService.js:183` | `CanvasFxService` | `streamerCheckInterval` — streamer-online polling |
| `services/RecordingCleanupScheduler.js:27` | `RecordingCleanupScheduler` | `checkInterval` — delete-by-age cleanup *(see hazard note below)* |
| `services/game/GameLoopManager.js:32` | `GameLoopManager` | `intervalId` — game world tick |
| `services/TimeTrackingService.js:115` | `TimeTrackingService` | `cleanupIntervalId` — session cleanup |
| `services/AccountDeletionScheduler.js:27` | `AccountDeletionScheduler` | `intervalId` — 15-day grace check |
| `services/ContinuousRecordingService.js:745` | `ContinuousRecordingService` | `autoRecordInterval` — LiveKit room polling for active streams |
| `services/ContinuousRecordingService.js:1368` | `ContinuousRecordingService` | `cleanupInterval` — old recording purge |
| `services/StreamBotService.js:305` | `StreamBotService` | `intervalId` — periodic announcement timer |

### "Module-scope" or "constructor-leaked" — no handle on instance, can't be stopped

These are the **hard** half. Each is created without storing the handle on a state location, so there's nothing to clear. Phase 2 fixes each one by relocating the handle and adding `stop()`. Listed in order of severity.

| Site | Severity | Notes |
|------|----------|-------|
| `server/index.js:556` | **High** | `visualEffectSyncInterval` — module-scope `let`, started by `startVisualEffectSync()`. The function does check-and-clear, but on hot-reload the previous interval orphans. |
| `server/index.js:5561` | Medium | Streaming time sync — module-scope, never stopped. |
| `server/index.js:5978` | Medium | Stress-test generator (dev only?), module-scope. |
| `services/VisualFxService.js:1537` | Medium | Anonymous `setInterval` inside a method, no handle saved. |
| `services/ChatBotLLMService.js:656` | Medium | Anonymous `setInterval`, no handle saved. |
| `services/RecordingStorageService.js:441` | Medium | Anonymous `setInterval`, no handle saved. |
| `services/FileCompressionService.js:146` | Medium | Anonymous `setInterval`, no handle saved. |
| `services/ViewBotSocketClient.js` (5 sites) | Medium | Multiple `setInterval` per bot instance; partial handle storage. |
| `services/MediasoupService.js` (5 sites) | Medium | Stats polling, transport health — mixed pattern. |
| `services/ViewBotClientService.js` (45 sites total) | Medium-Mixed | A large surface — some sites are `this.X = setInterval(...)`, others anonymous. Audit during Phase 2 viewbot lifecycle work. |
| `services/StreamBotService.js:540` | Low (false positive) | This is a method *named* `setInterval`, not a call to the global. |

## Notable hazards

### Recording cleanup races recording upload

`RecordingCleanupScheduler.js:27` deletes local segments **by age** with no check on `b2_file_id IS NOT NULL`. `RecordingUploadScheduler.js:37` retries failed uploads on a separate cadence. If an upload fails for longer than the cleanup window, the local segment vanishes before the upload retries — silent data loss.

This is Phase 2 PR 2.6's target (see refactor plan); the fix is to gate cleanup on confirmed upload, in the same PR that adds the deterministic test.

### `setTimeout` chains in `server/index.js` startup

`server/index.js:5242, 5319, 5401, 5505, 5514, 5913, 5952, 6140` schedule autostarts and graceful-shutdown work with no per-handle reference. If service init fails partway, the deferred work still fires against torn-down state. Phase 4 (`startServer()` decomposition into a phased `LifecycleManager.start()`) cleans this up.

### ~~`global.viewBotIntervals` Map~~ (resolved by deletion in PR 3.4)

This section originally flagged a `Map<streamerId, interval>` at `server/index.js:859–883` as a partial-cleanup hazard. Phase 3 PR 3.4 mapped the callsites and found the Map had zero producers in practice: the three module-scope helpers that wrote to it (`createViewBotProducer`, `startSyntheticMediaGeneration`, `generateViewBotRtpParameters`) had **no callers anywhere in the codebase since the initial commit** — confirmed by `grep` across `server/`, `client/`, `chat-service/`, and `git log --all -S "createViewBotProducer("` showing no commit ever added a call site. The "leak on incomplete cleanup" was structurally impossible because nothing ever populated the Map.

PR 3.4 deleted the three helpers and the Map reference. The previous wording here ("some paths clear, others don't") was based on reading the file rather than tracing callers — corrected for the record.

## Child processes

Less concerning for lifecycle since they exit on their own work boundaries:

- **`ffmpeg`**: spawned for recording, URL relay (`ViewBotURLService`), clip processing. Exits when stream ends or input EOFs. Wedge cases (stuck source) are not currently reaped by timeout — flagged as Phase 1 PR 2.6 territory.
- **`puppeteer` / Chromium**: one browser per viewbot in `ViewBotClientService`. Closed in `stopViewbot()`. Browser leaks are a known viewbot fleet issue (`docs/operations/runbooks/viewbot-fleet-misbehaving.md`).
- **`whisper.cpp`**: spawned per active transcription session. Exits when the session ends.

## Refresh

```bash
grep -rn -E '\b(setInterval|setTimeout)\b' server/ --include='*.js' | grep -v node_modules | wc -l
grep -rn 'this\.\w*(Interval|Timer|Id) = setInterval' server/ --include='*.js' | grep -v node_modules
```

When this file drifts, it drifts toward "more leaked, more scattered" — drift in the wrong direction is a Phase 2 signal.
