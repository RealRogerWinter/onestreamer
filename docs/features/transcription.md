# Transcription

_Last verified: 2026-05-23 against commit 4a1d325._

Real-time speech-to-text of streamed audio. Runs **locally on the server** via the bundled `whisper.cpp` native binary — no cloud APIs, no per-minute charges, no audio leaving the host. See [ADR-0006](../architecture/adr/0006-whisper-cpp-over-cloud-stt.md) for the rationale.

> [!NOTE]
> Earlier iterations attempted Python `openai-whisper`, `@xenova/transformers` browser-side, and LiveKit-RTMP capture (the latter producing six "FINAL" docs in October 2025 — see [`/docs/archive/transcription/`](../archive/transcription/)). The current production path is exclusively `whisper.cpp` spawned as a child process from the main server. The `openai-whisper` npm package is listed in `package.json` but never required — flag for removal.

## What gets transcribed

When transcription is enabled for an active stream:

1. Audio is consumed from the streamer's MediaSoup producer via a Plain Transport (RTP).
2. FFmpeg decodes Opus → PCM @ 16 kHz mono.
3. Audio is buffered in **5-second chunks** with a **500 ms overlap** for cross-chunk context.
4. Each chunk is written to a temp file and passed to `whisper.cpp/main`.
5. The transcribed text is broadcast over Socket.IO as a `transcription-update` event and persisted to SQLite.

```
MediaSoup audio producer
    ↓ (Plain RTP)
FFmpeg (Opus → PCM 16 kHz mono)
    ↓
Audio buffer (5 s chunks + 0.5 s overlap)
    ↓
whisper.cpp/main (native binary)
    ↓
Text → transcription_chunks table + transcription-update socket event
```

## Models

Whisper model files live under `/root/onestreamer/whisper/models/*.bin` (not committed; download separately).

| Model | Disk size | Latency | Accuracy notes |
|-------|----------:|---------|----------------|
| `tiny`   | ~39 MB | Fastest | Lowest accuracy; OK for keyword spotting |
| `base` (default) | ~142 MB | Fast | Recommended for most use cases |
| `small`  | ~466 MB | Moderate | Noticeably better with accents / background noise |
| `medium` | ~1.5 GB | Slow | High accuracy |
| `large`  | ~2.9 GB | Slowest | Best accuracy |

99+ languages supported (set `language: 'en'` for English, or `'auto'` for detection).

## Setup

```bash
# Build whisper.cpp + download models (one-time)
node setup-whisper.js

# Create the transcription tables (idempotent)
node server/migrations/setup-transcription-tables.js
```

The build step compiles `whisper.cpp/main` from source via `gcc + make + cmake`. On Linux/macOS this is automatic; the resulting binary is at `/root/onestreamer/whisper/whisper.cpp/main`.

## HTTP API

Admin endpoints (require `x-admin-key` header):

| Method | Path | Body / purpose |
|--------|------|----------------|
| `POST` | `/admin/transcription/start` | `{ streamerId, options: { model, language } }` |
| `POST` | `/admin/transcription/stop/:sessionId` | Stop a running session |
| `GET` | `/admin/transcription/status` | Probe state, list active sessions |
| `POST` | `/admin/transcription/config` | `{ enable, model, language }` — global defaults |

User-facing endpoints (JWT auth):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/transcription/:sessionId` | Fetch full transcript |
| `GET` | `/api/transcriptions/active` | List currently-running transcriptions |

## Socket.IO events

Client → server:

```javascript
socket.emit('start-transcription', {
  streamerId: '<streamer-socket-id>',
  options: { model: 'base', language: 'en' }
});

socket.emit('stop-transcription', { sessionId: '<session-id>' });
```

Server → client:

| Event | Payload |
|-------|---------|
| `transcription-started` | `{ sessionId, streamerId }` |
| `transcription-update` | `{ chunkNumber, text, wordCount, timestamp }` |
| `transcription-stopped` | `{ duration, wordCount }` |

## Configuration

In [`server/services/TranscriptionService.js`](../../server/services/TranscriptionService.js):

```js
config = {
  enableTranscription: false,   // global enable/disable
  model:               'base',
  language:            'en',
  chunkDuration:       5000,    // ms per Whisper invocation
  overlapDuration:     500,     // ms of overlap with the previous chunk
  maxBufferSize:       30000,   // upper bound on the rolling buffer
}
```

Tuning:

- **Lower `chunkDuration`** → lower latency, more frequent CPU spikes.
- **Higher `chunkDuration`** → better context per chunk, but text appears in chat with more delay.
- **`thread count`** can be tuned in the `whisper.cpp` args if CPU is plentiful.

## Resource footprint

Per active transcription (single stream):

| Model | CPU (% of 1 core) | RAM | Disk (model + temp audio) |
|-------|------------------:|----:|---------------------------|
| `tiny`   | 10–20% | ~150 MB | ~50 MB |
| `base`   | 20–40% | ~250 MB | ~150 MB |
| `small`  | 40–60% | ~550 MB | ~500 MB |
| `medium` | 60–100% | ~1.6 GB | ~1.5 GB |
| `large`  | 100–200% | ~3 GB | ~3 GB |

Service overhead independent of model: ~100 MB. Temp audio adds ~1 MB per minute of recorded stream.

## Database

In SQLite:

```sql
transcriptions (
  id, stream_id, streamer_id, start_time, end_time,
  language, model, word_count, status
)

transcription_chunks (
  transcription_id, chunk_number, text, timestamp, word_count
)

transcription_events (...)
transcription_settings (...)
```

## Who consumes transcripts

- **The chat client** subscribes to `transcription-update` to show live captions (optional UI).
- **MovieBot** (see [`ai-chatbots.md`](ai-chatbots.md)) pulls the last N transcription chunks alongside the last 30 chat messages when generating its commentary prompts. This is what makes MovieBot feel context-aware — it knows what the streamer is *saying*, not just what chat is saying.
- **The admin panel** has a Transcriptions tab ([`TranscriptionManagement.tsx`](../../client/src/components/admin/TranscriptionManagement.tsx), ~750 LOC) for browsing and exporting past transcripts.

## Troubleshooting

| Symptom | First check |
|---------|-------------|
| No transcription appears | Confirm an audio producer exists for the streamer: `mediasoupService.producers.get(streamerId)`. Confirm `ffmpeg -version` works on the server. |
| Quality is poor | Try a larger model (`small`/`medium`). Confirm `language` matches what the streamer speaks. |
| CPU pinned at 100% | Drop to a smaller model. Increase `chunkDuration` (less frequent Whisper invocations). Reduce concurrent transcriptions. |
| Transcription "starts" but no chunks arrive | FFmpeg may have died — check `pm2 logs onestreamer-server` for ffmpeg crash trace. |

## Code paths

| Concern | File |
|---------|------|
| Service entrypoint | [`server/services/TranscriptionService.js`](../../server/services/TranscriptionService.js) (the `whisper.cpp/main` spawn is around line 481) |
| Audio capture from MediaSoup | [`server/services/TranscriptionAudioAdapter.js`](../../server/services/TranscriptionAudioAdapter.js) |
| Buffer mgmt | [`server/services/AudioBufferService.js`](../../server/services/AudioBufferService.js) |
| Admin UI | [`client/src/components/admin/TranscriptionManagement.tsx`](../../client/src/components/admin/TranscriptionManagement.tsx) |

## See also

- [`docs/integrations/whisper.md`](../integrations/whisper.md) — Whisper-specific install + model details
- [`docs/architecture/adr/0006-whisper-cpp-over-cloud-stt.md`](../architecture/adr/0006-whisper-cpp-over-cloud-stt.md) — the decision and trade-offs
- [`docs/features/ai-chatbots.md`](ai-chatbots.md) — how MovieBot consumes transcripts
