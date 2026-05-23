# Whisper (local STT)

_Last verified: 2026-05-23 against commit 4a1d325._

Speech-to-text for the live transcription feature. Runs **entirely locally** via the bundled `whisper.cpp` native binary — no cloud APIs, no per-minute charges, no audio leaving the host. See [ADR-0006](../architecture/adr/0006-whisper-cpp-over-cloud-stt.md) for the rationale.

## What it is

- **[OpenAI Whisper](https://github.com/openai/whisper)** — open-source speech-to-text model.
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** — efficient C++ port of Whisper inference. Single native binary, no Python runtime.
- **OneStreamer spawns the binary as a child process** for each audio chunk via `child_process.spawn()`.

## Where the binary lives

```
/root/onestreamer/whisper/whisper.cpp/main          (the binary — built from source)
/root/onestreamer/whisper/models/*.bin              (model weights — not in git; downloaded separately)
```

The binary is invoked with arguments like:

```bash
./main -m models/ggml-base.bin -f /tmp/chunk.wav -ojf -of /tmp/chunk -nt -t 4
```

(Flags vary by version of whisper.cpp; see [`TranscriptionService.js:481`](../../server/services/TranscriptionService.js) for the exact spawn invocation.)

## Models

| Model | Size | Speed | Use case |
|-------|-----:|-------|----------|
| `tiny` | ~39 MB | Fastest | Keyword spotting, testing, low-CPU hosts |
| `base` | ~142 MB | Fast | **Default — recommended for most use cases** |
| `small` | ~466 MB | Moderate | Noticeably better with accents / background noise |
| `medium` | ~1.5 GB | Slow | High accuracy |
| `large` | ~2.9 GB | Slowest | Best accuracy |

99+ languages supported. Setting `language: 'en'` is faster than `'auto'`-detect.

## Setup

The convenience script:

```bash
cd /root/onestreamer
node setup-whisper.js
```

This:

1. Clones the [whisper.cpp](https://github.com/ggerganov/whisper.cpp) repo if not already present.
2. Builds `main` with `make`.
3. Downloads the default model (`ggml-base.bin`).
4. Confirms the binary runs.

Manually, if you prefer:

```bash
cd /root/onestreamer/whisper
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
make                          # requires gcc, make, cmake
# Pull a model
bash ./models/download-ggml-model.sh base
```

The model files are large; they're explicitly gitignored. Re-run `setup-whisper.js` (or the `download-ggml-model.sh` script) on each host where you deploy.

## How OneStreamer uses it

[`TranscriptionService`](../../server/services/TranscriptionService.js) (~line 481):

1. Receives audio chunks from the [`AudioBufferService`](../../server/services/AudioBufferService.js) (5-second windows with 500 ms overlap).
2. Writes each chunk as a WAV file to a temp directory.
3. Spawns `whisper.cpp/main` against the file with the configured model.
4. Captures the text output, parses it.
5. Persists the chunk to the `transcription_chunks` table.
6. Broadcasts `transcription-update` over Socket.IO.
7. Cleans up the temp WAV.

The whole loop runs per chunk — there's no warm-process kept around. (`whisper.cpp` is fast enough that the spawn overhead is acceptable for the `tiny`/`base` models; larger models bring their own slowness that dominates.)

## Phantom dependency: `openai-whisper`

`package.json` used to list `openai-whisper` v1.0.2 as a dependency. **It was never `require`d anywhere** — likely a dead-end during the transcription iteration captured in [`/docs/archive/transcription/`](../archive/transcription/) (four `LIVEKIT_TRANSCRIPTION_*` variants from Oct 6 2025). Removed in #21. The only live transcription path is the `whisper.cpp` binary.

## Env vars

No env vars needed — paths and the default model are hardcoded in [`TranscriptionService.js`](../../server/services/TranscriptionService.js). The active model is set via the admin panel (Transcriptions tab) and persisted in the `transcription_settings` SQLite table.

## Resource footprint (per active transcription)

| Model | CPU (% of 1 core) | RAM | Disk (model + temp audio) |
|-------|------------------:|----:|---------------------------|
| `tiny`   | 10–20% | ~150 MB | ~50 MB |
| `base`   | 20–40% | ~250 MB | ~150 MB |
| `small`  | 40–60% | ~550 MB | ~500 MB |
| `medium` | 60–100% | ~1.6 GB | ~1.5 GB |
| `large`  | 100–200% | ~3 GB | ~3 GB |

Per-stream temp audio: ~1 MB/min.

## Operational notes

- **GPU acceleration** — `whisper.cpp` supports CUDA, Metal, OpenCL, and other backends if built with the right flags. The default build is CPU-only. Rebuilding with GPU support is out of scope of this doc; see the [`whisper.cpp` README](https://github.com/ggerganov/whisper.cpp#blas-cuda-support).
- **Thread count** — `whisper.cpp` defaults to a sensible number for the host. Override with `-t <n>` in the spawn args if you want to cap CPU usage.
- **Multiple concurrent transcriptions** — each one spawns its own `whisper.cpp/main` process. On a busy host, limit concurrency in [`TranscriptionService`](../../server/services/TranscriptionService.js) to avoid CPU saturation.
- **Model file gotcha** — if you switch models in the admin UI but the new model file isn't on disk, the next transcription attempt fails. Pre-pull all models you intend to use.

## Updating whisper.cpp

```bash
cd /root/onestreamer/whisper/whisper.cpp
git pull
make clean && make
./main --version
pm2 restart onestreamer-server
```

Models are forward-compatible across `whisper.cpp` versions (same `ggml-*.bin` format).

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Transcription "starts" but no chunks arrive | `whisper.cpp/main` may be crashing — check `pm2 logs onestreamer-server` for spawn errors. |
| Garbled text | Probably wrong `language` setting (audio is Spanish, transcribing as English). Set the matching language in the admin panel. |
| All chunks empty | Audio input may be silent — check the streamer's mic permission and audio-level meter. |
| Excessive CPU | Smaller model; increase `chunkDuration` so spawns are less frequent; cap concurrent transcriptions. |
| `ENOENT: spawn whisper.cpp/main` | The binary doesn't exist — re-run `node setup-whisper.js`. |
| Model file missing | `ls /root/onestreamer/whisper/models/*.bin` — pull the missing one via `download-ggml-model.sh`. |

## Code paths

| Concern | File |
|---------|------|
| Service entrypoint | [`server/services/TranscriptionService.js`](../../server/services/TranscriptionService.js) (line ~481 is the `whisper.cpp/main` spawn) |
| Audio capture from MediaSoup | [`server/services/TranscriptionAudioAdapter.js`](../../server/services/TranscriptionAudioAdapter.js) |
| Buffer management | [`server/services/AudioBufferService.js`](../../server/services/AudioBufferService.js) |
| Admin UI | [`client/src/components/admin/TranscriptionManagement.tsx`](../../client/src/components/admin/TranscriptionManagement.tsx) |
| Setup script | [`/setup-whisper.js`](../../setup-whisper.js) |

## See also

- [`/docs/features/transcription.md`](../features/transcription.md) — user-facing feature
- [ADR-0006](../architecture/adr/0006-whisper-cpp-over-cloud-stt.md) — why local Whisper over cloud STT
- [`ollama-and-groq.md`](ollama-and-groq.md) — the LLM side of the AI story (also local-first)
- [whisper.cpp on GitHub](https://github.com/ggerganov/whisper.cpp)
- [OpenAI Whisper paper / model card](https://github.com/openai/whisper)
