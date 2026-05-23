# Service catalog

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer's backend has **~100 modules in [`server/services/`](../../server/services/)**. They have accumulated over time and there is real iteration debris — some files are dead code or superseded variants. This catalog groups every service thematically, with a one-line description and notes on which ones are dead-code candidates.

**Conventions used below:**
- **Bold** = actively wired in production
- _Italic_ = legacy / superseded / dead-code candidate
- (regular) = supporting service used by another active service

---

## Streaming core

| Service | Role |
|---------|------|
| **`StreamService.js`** | Source of truth for the current streamer and viewer list. Critical state holder. |
| **`SessionService.js`** | Maps IP ↔ user ID ↔ socket ID; survives socket reconnect. |
| **`TakeoverService.js`** | Takeover handshake (request/approve/deny) + cooldown enforcement (global + per-user). |
| **`MediasoupService.js`** | The WebRTC SFU. Manages routers, transports, producers, consumers. |
| **`MediasoupPlainTransportService.js`** | Plain RTP transport creation for the secondary pipelines (recording, transcription, viewbots) that need raw RTP rather than DTLS-wrapped WebRTC. |
| **`MediasoupSyncConfig.js`** | MediaSoup configuration helpers. |
| `LiveKitService.js` | Alternative WebRTC backend (RoomServiceClient, ingress, egress). Currently dormant — see [ADR-0002](adr/0002-mediasoup-primary-livekit-dormant.md). |
| `LiveKitIngressService.js` | RTMP ingress via LiveKit. Dormant. |
| `LiveKitAudioCapture.js` | Audio capture via LiveKit SDK. Dormant. |
| `WebRTCAdapter.js` | Abstraction layer for swapping MediaSoup ↔ LiveKit. |
| `WebRTCAdapterV2.js` | Second-generation adapter (used by `UnifiedViewBotRotation`). |
| **`TestStreamService.js`** | Synthetic test streams (SMPTE bars, color gradients, scrolling text, clock). |
| **`SimpleMediaStreamService.js`** | Basic media stream service. |
| `MediaStreamService.js` | (Variant; check usage before relying on.) |

---

## Viewbot fleet (~20 variants)

See [`viewbot-fleet.md`](viewbot-fleet.md) for the live/dead breakdown.

### Orchestration

| Service | Role |
|---------|------|
| **`UnifiedViewBotRotation.js`** | Current rotation orchestrator. Wired in production. |
| **`ViewBotClientService.js`** | Per-bot lifecycle (start, stop, monitor). |
| **`ViewBotManager.js`** | Plain RTP ↔ WebRTC mode toggle. |
| **`ViewBotStateManager.js`** | Shared state across bot lifecycles. |
| **`ViewBotMonitor.js`** | Health checks. |
| **`ViewBotMetrics.js`** | Per-bot stats reporting. |
| _`ViewBotRotationService.js`_ | Legacy rotation; replaced by Unified. |
| _`ViewBotRotationIntegration.js`_ | Old integration wrapper. |
| _`SimpleViewBotRotation.js`_ | Earlier rotation experiment. |
| _`WebRTCViewBotRotation.js`_ | Earlier WebRTC-only rotation. |
| _`InitializeSimpleRotation.js`_ | Bootstrap for an earlier rotation. |
| _`SimpleViewBotSocket.js`_ | Socket-only experimental viewbot. |

### Ingest pipelines

| Service | Role |
|---------|------|
| **`ViewBotGStreamerService.js`** | GStreamer pipeline for Plain RTP mode. |
| **`ViewBotWebRTCService.js`** | Puppeteer-driven Chrome for WebRTC mode. |
| _`ViewBotGStreamerWebRTC.js`_ | GStreamer → WebRTC bridge variant. |
| _`ViewBotFFmpegService.js`_ | FFmpeg-based viewbot (alternative to GStreamer). |
| _`ViewBotMuxedStreamService.js`_ | Earlier muxed-stream variant. |
| _`SimpleViewBotMediaSoup.js`_ | Simple MediaSoup viewbot. |
| _`SimpleTestBot.js`_ | Test-only viewbot. |
| _`WebRTCViewBot.js`_ | Earlier WebRTC viewbot. |

### LiveKit-backed variants (all dormant — see [ADR-0003](adr/0003-livekit-dual-stack-rollback.md))

| Service |
|---------|
| _`ViewBotLiveKitService.js`_ |
| _`ViewBotLiveKitFFmpeg.js`_ |
| _`ViewBotLiveKitSDK.js`_ |
| _`ViewBotLiveKitNode.js`_ |
| _`ViewBotLiveKitPuppeteer.js`_ |
| _`ViewBotLiveKitRTMP.js`_ |

### Helpers

| Service | Role |
|---------|------|
| **`createViewBotSDP.js`** | Crafts SDP offers for viewbot transports. |
| **`launch-chrome-xvfb.sh`** | Shell wrapper that launches Puppeteer Chrome under Xvfb (X virtual framebuffer) for headless rendering. |
| **`ViewBotSocketClient.js`** | Socket.IO client used by certain bot variants. |
| **`ViewBotDatabaseService.js`** | Viewbot config persistence. |
| **`ViewbotService.js`** | Legacy main viewbot service. (Lowercase 'b' — note the inconsistent capitalization.) |

### URL-based ingest

| Service | Role |
|---------|------|
| **`ViewBotURLService.js`** | Accepts arbitrary HTTP/Twitch/Kick URLs and feeds them through the pipeline. |
| **`URLStreamExtractorService.js`** | Extracts the actual playable URL from a Twitch/Kick HTML page. |
| **`URLStreamDatabaseService.js`** | Persists URL stream configurations. |
| **`URLStreamHealthService.js`** | Monitors URL streams for liveness. |

---

## Recording + clips

| Service | Role |
|---------|------|
| **`ContinuousRecordingService.js`** | Main recording orchestrator. Spawns the per-recording pipeline; tracks state. |
| **`RecordingStorageService.js`** | Local FS layout, size tracking, DB metadata. |
| **`RecordingUploadScheduler.js`** | Periodic sweep for retry of stuck B2 uploads. |
| **`RecordingCleanupScheduler.js`** | Deletes local files after B2 upload confirmed; respects retention. |
| **`B2StorageService.js`** | S3-compatible client (AWS SDK against B2). Generates signed URLs. |
| **`B2SegmentUploadService.js`** | Background per-segment upload to B2. |
| **`SessionChatCaptureService.js`** | Captures chat aligned to recording timeline. |
| **`FileCompressionService.js`** | Post-recording compression (HLS → optimized output). |
| **`ClipService.js`** | Clip CRUD, lifecycle, public/private toggle. |
| **`ClipProcessorService.js`** | FFmpeg-based clip extraction + thumbnail generation. |
| **`ClipStorageService.js`** | Clip file storage (local + B2). |
| **`StreamProbeService.js`** | Probes stream properties via `ffprobe`. |
| **`VideoTimestampMapper.js`** | Maps wall-clock timestamps to recording timeline. |
| **`VideoTransitionDetector.js`** | Detects scene changes (used for thumbnails and clip suggestions). |
| **`BlackFrameDetectorService.js`** | Detects black frames (clip cut-points). |

---

## Transcription + AI

| Service | Role |
|---------|------|
| **`TranscriptionService.js`** | Whisper-based audio transcription orchestrator (spawns `whisper.cpp/main`). |
| **`TranscriptionAudioAdapter.js`** | Audio capture abstraction for the transcription pipeline. |
| **`AudioBufferService.js`** | Audio buffer management for transcription (5-second chunks + 0.5 s overlap). |
| **`OpusDecoder.js`** | Decodes Opus audio (utility). |
| **`MpegTsDemuxerService.js`** | Demultiplexes MPEG-TS streams (used in recording / external ingest). |
| **`RtpReceiver.js`** | Low-level RTP packet receiver. |
| **`ChatBotService.js`** | Multi-bot LLM orchestrator; per-bot scheduling. |
| **`ChatBotLLMService.js`** | LLM provider abstraction (Ollama / Groq + canned fallback). |
| **`MovieBotService.js`** | Live stream commentary bot (consumes transcription + chat context). |
| **`StreamBotService.js`** | Periodic-announcement bot. |

---

## Audio + effects

| Service | Role |
|---------|------|
| **`AudioOptimizationService.js`** | Codec negotiation, audio quality profiles. |
| **`SoundFxService.js`** | Sound effect playback + TTS + 101soundboards queue. |
| **`VisualFxService.js`** | Server-side video pipeline filters (resolution, bitrate, network sim, color, glitch, etc.). |
| **`CanvasFxService.js`** | Server-side trigger for client-rendered overlay effects. |

---

## Items + economy

| Service | Role |
|---------|------|
| **`ItemService.js`** | Item CRUD, category management, type detection (`isCooldownModifierItem`, etc.). |
| **`InventoryService.js`** | User inventory state (acquire, use, stack). |
| **`ShopService.js`** | Shop catalog read + purchase logic (deducts points, adds inventory). |
| **`BuffDebuffService.js`** | Buff/debuff lifecycle (apply, track expiry, broadcast). |

---

## Authentication + accounts

| Service | Role |
|---------|------|
| **`AuthService.js`** | JWT signing/verifying, Google OAuth flow, password reset, login/signup. |
| **`AccountService.js`** | User profile reads/writes, stat aggregation, the points-balance ledger, account-deletion DB operations. |
| **`AccountDeletionScheduler.js`** | Hourly cron-like check for accounts past their 15-day grace period; calls `permanentlyDeleteAccount()`. |
| **`IPBanService.js`** | IP ban DB + in-memory cache. Checked at socket connect. |
| **`EmailService.js`** | SMTP email sending (verification, password reset, deletion confirmation). |
| **`ProfanityFilterService.js`** | Local profanity detection with character-substitution normalization (~600 entries). |

---

## Rotation + external feeds

| Service | Role |
|---------|------|
| **`RandomStreamRotationService.js`** | Top-level orchestrator that picks the next stream (Twitch / Kick / saved URL) and triggers the rotation. |
| **`TwitchRandomService.js`** | Twitch Helix API client; filtered random channel pick. |
| **`KickRandomService.js`** | Kick public scrape via Python helper (`curl_cffi`). |
| **`kick-api-helper.py`** | Python helper script for Kick (not a Node module; subprocess-spawned). |
| **`SimpleViewBotRotation.js`** | Simple in-memory rotation state (used by URL-stream rotation). |

---

## Monitoring + admin

| Service | Role |
|---------|------|
| **`TimeTrackingService.js`** | Per-user stream/view/chat time accumulation; awards points on a 25-second tick. |
| **`StreamingLogsService.js`** | Stream event audit trail (start, end, takeover, disconnect). |
| **`ResourceMonitor.js`** | CPU / memory / disk monitoring loop (5 s interval). |
| **`PortMonitorService.js`** | Network port availability checks. |
| **`ProcessManager.js`** | Child process lifecycle (kill stale ffmpeg / gstreamer / chrome). |

---

## Stream interceptor (intermediate processing)

| Service | Role |
|---------|------|
| **`StreamInterceptorService.js`** | Intercepts/processes the stream mid-pipeline (GStreamer-based — used by VisualFX effects). |
| **`StreamInterceptorIntegration.js`** | Integration wrapper that wires the interceptor into MediaSoup. |

---

## Game subsystem

Lives in [`server/services/game/`](../../server/services/) as a self-contained subdirectory.

| Service | Role |
|---------|------|
| **`GameService.js`** | Main orchestrator. |
| **`GameLoopManager.js`** | Per-tick game loop. |
| **`PlayerManager.js`** | Player state, movement, inventory in-game. |
| **`EnemyManager.js`** | Enemy spawning + AI. |
| **`WorldManager.js`** | Map, tiles, spawn points, persistence. |
| **`CollisionManager.js`** | Collision detection. |
| **`GameBroadcaster.js`** | Per-tick state broadcast via Socket.IO. |
| **`GameStreamService.js`** | Streams game video to viewers when game-mode is active. |
| **`index.js`** | Exports the game services. |

---

## Backup / superseded / clearly dead

These have `.backup-{timestamp}` suffixes or no callers in the current code path:

- _`ItemService.js.backup-1756156123506`_ — old item service backup
- _`StreamService.js.backup-1756156123508`_ — old stream service backup
- _`ConestreamerserverservicesItemService.js`_ — empty file; likely a tooling artifact (rename gone wrong)
- _`Conestreamertest-potato-item.js`_ — 1-byte file; same artifact pattern

These should be deleted in a cleanup pass (out of scope for the docs overhaul — capture as a follow-up).

---

## Counting the fleet

Approximate counts for orientation:

| Group | Count |
|-------|------:|
| Streaming core | ~12 |
| Viewbot fleet (active + legacy + LiveKit-dormant) | ~25 |
| Recording + clips | ~14 |
| Transcription + AI | ~9 |
| Audio + effects | ~4 |
| Items + economy | ~4 |
| Auth + accounts | ~6 |
| Rotation + external | ~5 |
| Monitoring + admin | ~5 |
| Stream interceptor | ~2 |
| Game subsystem | ~9 |
| Backups / dead code | ~4 |
| **Total** | **~100** |

---

## Pruning candidates (follow-up work, out of scope for docs)

The biggest cleanup wins:

1. **Delete all `*.backup-*` files** — old snapshots committed by accident.
2. **Delete the typo-named files** — `ConestreamerserverservicesItemService.js`, `Conestreamertest-potato-item.js`.
3. **Decide on dormant LiveKit infrastructure** — either revive it (resolve ADR-0003's open questions) or delete the 6 `ViewBotLiveKit*.js` + supporting files.
4. **Delete the superseded rotation services** — `ViewBotRotationService.js`, `ViewBotRotationIntegration.js`, `SimpleViewBotRotation.js`, `WebRTCViewBotRotation.js`, `InitializeSimpleRotation.js`.
5. **Delete the early viewbot experiments** — `WebRTCViewBot.js`, `ViewBotMuxedStreamService.js`, `SimpleViewBotSocket.js`, `SimpleTestBot.js`, `SimpleViewBotMediaSoup.js`.

A focused cleanup PR could remove ~15 files and ~5,000 lines of dead code without changing any behavior. Capture as `<issue>` in the tracker rather than mixing into the docs overhaul.

---

## See also

- [`overview.md`](overview.md) — where each group of services fits in the layered view
- [`viewbot-fleet.md`](viewbot-fleet.md) — the live vs dead breakdown in detail
- [`/docs/contributing/adding-a-service.md`](../contributing/adding-a-service.md) — how to add a new service that survives this catalog's "is it actually used?" test
