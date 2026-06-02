# Service catalog

_Last verified: 2026-06-01 against `main` (post-ADR-0024 cleanup). MediaSoup/GStreamer/Puppeteer viewbot stack and the dead-code variants enumerated in earlier revisions are gone — LiveKit is the sole streaming backend._

OneStreamer's backend has **~150 top-level modules in [`server/services/`](../../server/services/)** plus **~80 more in per-domain subdirectories** (e.g. `recording/`, `transcription/`, `urlstream/`, `random-stream/`, `chatbot/`, `streambot/`, `canvasfx/`, `game/`, `moderation/`). This catalog groups the load-bearing services thematically with a one-line description; the small per-domain helper modules are referenced by their parent service rather than listed exhaustively.

**Conventions used below:**
- **Bold** = actively wired in production
- (regular) = supporting service used by another active service

---

## Streaming core

| Service | Role |
|---------|------|
| **`StreamService.js`** | Source of truth for the current streamer and viewer list. Critical state holder. |
| **`StreamOrchestration.js`** | Coordinates start/stop/switch of the active stream across services. |
| **`StreamNotifier.js`** | Single chokepoint for stream lifecycle broadcasts ([ADR-0009](adr/0009-stream-notifier-chokepoint.md)) — collapses the old N-emit-sites of `stream-ended`/`stream-status` into one. |
| **`SessionService.js`** | Maps IP ↔ user ID ↔ socket ID; survives socket reconnect. |
| **`TakeoverService.js`** | Takeover handshake (request/approve/deny) + cooldown enforcement (global + per-user). |
| **`LiveKitService.js`** | **The WebRTC backend.** Wraps the LiveKit `RoomServiceClient` + ingress/egress clients: room/token management, `createIngress`/`deleteIngress` (URL relay + viewbots), webhook receipt. The sole streaming backend since [ADR-0024](adr/0024-retire-mediasoup-livekit-only.md). |
| **`AudioOptimizationService.js`** | Audio quality profiles (raw / voice / music / streaming). |
| **`AdaptiveEncodingSettings.js`** | Adaptive frame-rate / bitrate settings for ingress encodes. |
| **`TestStreamService.js`** | Synthetic test streams (SMPTE bars, gradients, scrolling text, clock). |
| **`SimpleMediaStreamService.js`** | Basic media stream helper. |
| **`LifecycleManager.js`** | Named-timer scheduler used across streaming lifecycle ([ADR-0011](adr/0011-lifecycle-manager.md)). |

Client-side, the streamer/viewer talk to LiveKit through [`client/src/services/LiveKitClient.ts`](../../client/src/services/LiveKitClient.ts) (a `Room` wrapper) via the thin [`WebRTCClientAdapter.ts`](../../client/src/services/WebRTCClientAdapter.ts) shim, so the React stream components never import the LiveKit class directly.

---

## Viewbots (synthetic streamers)

See [`viewbot-fleet.md`](viewbot-fleet.md) for the full pipeline. Every viewbot is a LiveKit ingress now; there is no Plain-RTP/WebRTC mode toggle.

| Service | Role |
|---------|------|
| **`ViewBotURLService.js`** | URL relay: `streamlink`/`yt-dlp` → FFmpeg → RTMP → LiveKit ingress. The primary viewbot path. |
| **`ViewBotLiveKitService.js`** | Local-video viewbot: FFmpeg → RTMP → LiveKit ingress. |
| **`ViewbotService.js`** | Shared viewbot bookkeeping / identity (note the lowercase 'b'). |
| **`SimpleViewBotRotation.js`** | Rotation gating — real-streamer / URL-relay protection (`isRealStreamerActive`). |
| **`URLStreamExtractorService.js`** | Resolves a Twitch/Kick/HTTP URL to a playable stream; builds the `streamlink` pipe. |
| **`URLStreamDatabaseService.js`** | Persists URL-stream configurations. |
| **`URLStreamHealthService.js`** | Liveness monitoring of active relays. |
| **`StreamProbeService.js`** | `ffprobe`-based source inspection. |
| (`urlstream/FFmpegPipeline.js`, `IngressJanitor.js`, `StreamReconnector.js`, `WhitelistGate.js`, `ViewerNotifier.js`) | URL-relay internals — FFmpeg→RTMP build, ingress teardown, reconnect, policy gate, viewer notify. |
| (`viewbot/ffmpegArgs.js`, `viewbot/streamDefaults.js`, `viewbot/UsernameCache.js`, `viewbotLivekit/helpers.js`) | Local-video FFmpeg arg builders + helpers. |

---

## Rotation + external feeds

| Service | Role |
|---------|------|
| **`RandomStreamRotationService.js`** | Top-level orchestrator: picks the next stream (Twitch / Kick / saved URL), drives the relay, pauses on real takeover, auto-resumes. Internals in [`server/services/random-stream/`](../../server/services/) (scheduler, announcer, recovery monitor, dependency wiring, state persistence). |
| **`TwitchRandomService.js`** | Twitch Helix API client; filtered random channel pick. |
| **`KickRandomService.js`** | Kick public scrape via the Python helper (`curl_cffi`). |
| **`kick-api-helper.py`** | Python helper for Kick (subprocess-spawned, not a Node module). |
| **`WhitelistService.js`** | URL-relay content policy ([ADR-0010](adr/0010-url-relay-whitelist-mode.md)): per-platform `off`/`blacklist`/`whitelist` + CCL/mature gates. |
| **`WhitelistEnforcer.js`** | Mid-stream drift checker — re-checks the active relay against `WhitelistService` and stops it on policy drift. |

---

## Recording + clips

Recording is LiveKit **egress** → local HLS → B2. The old ffmpeg/HLS recorder (`RecordingService`, `RecordingStorageService`, `FileCompressionService`) and the `fluent-ffmpeg` dependency were removed.

| Service | Role |
|---------|------|
| **`ContinuousRecordingService.js`** | Drives LiveKit Egress (Room Composite for viewbots, Participant Egress for the real streamer) → HLS segments on disk → `recording_sessions` table. Cleans up stale egress jobs on boot. |
| **`recording/RecordingDiskScanner.js`** | Scans the egress-recordings directory; reconciles on-disk segments with DB sessions and clip lookups. |
| **`recording/RecordingSessionStore.js`** | In-memory + DB session bookkeeping. |
| **`recording/RoomParticipantInspector.js`** | Inspects LiveKit room participants to decide room-vs-participant egress. |
| **`RecordingUploadScheduler.js`** | Periodic sweep that retries stuck B2 uploads. |
| **`RecordingCleanupScheduler.js`** | Deletes local files once B2 upload is confirmed; respects retention. |
| **`B2StorageService.js`** | S3-compatible client (AWS SDK against B2); generates signed URLs. |
| **`EgressFrameCaptureService.js`** | Extracts a JPEG frame from the egress HLS for a transcription window (feeds VisionBot). |
| **`SessionChatCaptureService.js`** | Captures chat aligned to the recording timeline (chat replay). |
| **`ClipService.js`** | Clip CRUD, lifecycle, public/private toggle. |
| **`ClipProcessorService.js`** | FFmpeg-based clip extraction + thumbnail generation. |
| **`ClipStorageService.js`** | Clip file storage (local + B2). |

The recording-review surface is served at `/admin/review/*` ([`server/routes/admin-recordings.js`](../../server/routes/admin-recordings.js) + `admin-recordings/`).

---

## Transcription + AI

Transcription captures audio from the LiveKit room (not Plain RTP) and runs whisper.cpp locally.

| Service | Role |
|---------|------|
| **`TranscriptionService.js`** | Transcription orchestrator (sessions, config, persistence, socket broadcast). |
| **`TranscriptionAudioAdapter.js`** | Captures audio via `@livekit/rtc-node` (`Room`/`AudioStream`/`TrackKind.KIND_AUDIO`) → PCM → WAV. |
| **`transcription/WhisperRunner.js`** | Self-contained whisper.cpp subprocess driver (spawns `whisper.cpp/main`). |
| **`transcription/TranscriptionRepository.js`** | `transcriptions` / `transcription_chunks` DB access. |
| **`transcription/AudioFileJanitor.js`** | Cleans up temp PCM/WAV buffer files. |
| **`TranscriptionDrivenBotService.js`** | Bridges transcription output into bot context. |
| **`AudioBufferService.js`** | Rolling audio buffer (5 s chunks + 0.5 s overlap). |
| **`ChatBotService.js`** | Multi-bot LLM orchestrator; per-bot scheduling. Internals under `chatbot/` (identity, dispatch, temporary-bot lifecycle, LLM clients). |
| **`ChatBotLLMService.js`** | LLM provider abstraction (Ollama / Groq + canned fallback). |
| **`MovieBotService.js`** | Live stream commentary bot (consumes transcription + chat context). |
| **`StreamBotService.js`** | Periodic-announcement bot (internals under `streambot/`). |
| **`VisionBotService.js`** | Screenshot-aware commentary ([ADR-0018](adr/0018-visionbot-screenshot-comments.md)) — pairs an egress frame with a transcription window. |

---

## Moderation

| Service | Role |
|---------|------|
| **`ModerationService.js`** | AI moderation pipeline orchestrator ([ADR-0013](adr/0013-ai-moderation-pipeline.md)). |
| **`ModerationStage1.js` / `Stage2.js` / `Stage3.js`** | The staged moderation passes. |
| **`ModerationActionArbiter.js`** | Decides the action from stage results. |
| **`ModerationNotifier.js`** | Broadcasts moderation outcomes. |
| **`ProfanityFilterService.js`** | Local profanity detection with character-substitution normalization. |
| **`IPBanService.js`** | IP ban DB + in-memory cache; checked at socket connect. |
| (`moderation/ImageModerationConfig.js`, `Retention.js`, `SchemaSeed.js`, `TermsAdmin.js`) | Image-moderation config ([ADR-0021](adr/0021-omni-image-moderation.md)), retention, seed, terms admin. |

---

## Audio + effects

| Service | Role |
|---------|------|
| **`SoundFxService.js`** | Sound effect playback + TTS + 101soundboards queue. |
| **`CanvasFxService.js`** | Server-side trigger for client-rendered overlay effects (internals under `canvasfx/`). |
| **`DrawingService.js`** | Collaborative drawing-overlay state. |
| **`AudioBufferService.js`** | (also used by transcription — see above). |

---

## Items + economy

| Service | Role |
|---------|------|
| **`ItemService.js`** | Item CRUD, category management, type detection. Internals under `item/`. |
| **`ItemUseService.js`** | Dispatches item use to the right handler (`itemUse/`: buff/debuff, cooldown modifier, interactive, utility, auto-trigger). |
| **`InventoryService.js`** | User inventory state (acquire, use, stack). |
| **`ShopService.js`** | Shop catalog read + purchase logic. |
| **`BuffDebuffService.js`** | Buff/debuff lifecycle (apply, track expiry, broadcast). Internals under `buffdebuff/`. |
| **`ThrowingService.js`** | Throwable-item mechanics. |

---

## Authentication + accounts

| Service | Role |
|---------|------|
| **`AuthService.js`** | JWT signing/verifying, Google OAuth flow, password reset, login/signup. |
| **`AccountService.js`** | Profile reads/writes, stat aggregation, points ledger, account-deletion DB ops. Internals under `account/` (lifecycle manager, profile manager, points). |
| **`AccountDeletionScheduler.js`** | Hourly check for accounts past their 15-day grace period. |
| **`EmailService.js`** | SMTP email (verification, password reset, deletion confirmation). |
| **`SessionService.js`** | (see Streaming core). |

---

## Monitoring + admin

| Service | Role |
|---------|------|
| **`TimeTrackingService.js`** | Per-user stream/view/chat time accumulation; awards points on a tick. |
| **`StreamingLogsService.js`** | Stream event audit trail (start, end, takeover, disconnect). |
| **`ResourceMonitor.js`** | CPU / memory / disk monitoring loop. |
| **`PortMonitorService.js`** | Network port availability checks. |
| **`ProcessManager.js`** | Child-process lifecycle (kill stale ffmpeg / streamlink). |
| **`BotEventBus.js`** | In-process event bus for bot subsystems. |

---

## Game subsystem

Lives in [`server/services/game/`](../../server/services/) as a self-contained subdirectory: `GameService.js` (orchestrator), `GameLoopManager.js`, `PlayerManager.js`, `EnemyManager.js`, `WorldManager.js`, `CollisionManager.js`, `GameBroadcaster.js`, `GameStreamService.js`, plus `GameMechanicsService.js`. `index.js` exports the set.

---

## Counting the fleet

Approximate counts for orientation (top-level `server/services/*.js`; subdirectory helpers add ~80 more):

| Group | Count |
|-------|------:|
| Streaming core | ~10 |
| Viewbots + rotation + external | ~14 |
| Recording + clips | ~12 |
| Transcription + AI | ~12 |
| Moderation | ~8 |
| Audio + effects | ~4 |
| Items + economy | ~8 |
| Auth + accounts | ~5 |
| Monitoring + admin | ~6 |
| Game subsystem | ~10 |
| **Top-level total** | **~150** |
| **+ subdirectory modules** | **~80** |

---

## See also

- [`overview.md`](overview.md) — where each group of services fits in the layered view
- [`viewbot-fleet.md`](viewbot-fleet.md) — the live LiveKit ingest paths in detail
- [`streaming-stack.md`](streaming-stack.md) — the LiveKit media pipeline
- [`/docs/contributing/adding-a-service.md`](../contributing/adding-a-service.md) — how to add a service that survives this catalog's "is it actually used?" test
- [ADR-0024](adr/0024-retire-mediasoup-livekit-only.md) — the MediaSoup retirement that shrank this catalog
