# ADR-0006: whisper.cpp over cloud STT

_Status: accepted_
_Date: 2026-05-23_

## Context

OneStreamer transcribes live stream audio to text in near-real-time. The transcripts feed MovieBot's context-aware commentary, support optional live captions, and are searchable in the admin panel. Several cloud STT options exist (Google Cloud Speech-to-Text, AWS Transcribe, Deepgram, OpenAI Whisper API, AssemblyAI). Several local options also exist (Python `openai-whisper`, [`whisper.cpp`](https://github.com/ggerganov/whisper.cpp), wav2vec, browser-side `@xenova/transformers`).

The constraints:

- **Streams run continuously when active** — cloud per-minute pricing scales with watch time, not user count. Heavy use makes cloud STT meaningful budget.
- **Audio is private user content.** Sending streamer voices to a cloud STT vendor creates a trust boundary worth thinking about.
- **Latency target is 5-second chunks** — fast enough for live-ish feel, not real-time. Local inference is plenty fast for this.
- **OneStreamer already runs on a moderately-resourced host** — local model inference is feasible.

## Decision

**Transcription uses [`whisper.cpp`](https://github.com/ggerganov/whisper.cpp), the C++ port of OpenAI's Whisper model.** OneStreamer spawns the bundled binary (`/whisper/whisper.cpp/main`) as a child process per audio chunk. The default model is `base` (~142 MB on disk); larger models can be swapped at runtime via the admin panel.

No cloud STT API is integrated. No browser-side STT.

## Consequences

**Positive.**
- **Zero per-minute cost.** Continuous streaming doesn't hit a budget cliff.
- **Audio never leaves the host.** Privacy story is straightforward — there's no third party.
- **Configurable accuracy / cost tradeoff** via model size. Operators choose `tiny` for low-CPU hosts, `medium`/`large` when accuracy matters.
- **No external service dependency.** Transcription works as long as the host is up; no risk of cloud STT vendor outages.
- **`whisper.cpp` is fast enough** for the 5-second chunk cadence on CPU; GPU acceleration is possible but not required.

**Negative.**
- **CPU footprint.** Each active transcription consumes 20–40% of one CPU core on the default `base` model. Multiple concurrent transcriptions can saturate the host.
- **Model files are large.** The `large` model is ~3 GB on disk and ~3 GB resident RAM. Hosts with constrained RAM are stuck on smaller, less-accurate models.
- **No automatic language switching.** Whisper supports 99+ languages, but the model loads with one language at a time. Setting `language: 'auto'` works but is slower and less accurate than knowing the language up front.
- **Model files aren't in git.** Operators must run `node setup-whisper.js` (or `download-ggml-model.sh`) per host to populate models.
- **whisper.cpp updates are manual.** No package-manager update path — operators `git pull && make` in `whisper/whisper.cpp/` to update.
- **The unused `openai-whisper` package** in `package.json` is a phantom dependency from earlier exploration. Safe to remove; flagged in [`/docs/_verification-notes.md`](../../_verification-notes.md) Q1.

## Alternatives considered

- **OpenAI Whisper API (cloud).** Rejected on cost and privacy. ~$0.006/min adds up fast for continuous transcription.
- **Google Cloud Speech-to-Text.** Same cost and privacy considerations. Better punctuation than Whisper but not enough to justify the price.
- **Deepgram.** Excellent quality, lowest latency of the cloud options. Cost still prohibitive for continuous streams.
- **Python `openai-whisper`.** Same model, but requires Python runtime and PyTorch — much heavier deployment than the standalone C++ binary.
- **`@xenova/transformers` in the browser.** Considered for client-side transcription, but bandwidth + CPU cost per viewer would be ridiculous (every viewer transcribing the same stream independently).
- **No transcription at all.** Considered. Rejected because MovieBot's context-awareness is one of the more interesting AI features, and live captions are a real accessibility feature.

## References

- [`/docs/features/transcription.md`](../../features/transcription.md)
- [`/docs/integrations/whisper.md`](../../integrations/whisper.md)
- [`/docs/_verification-notes.md`](../../_verification-notes.md) — Q1 confirms `whisper.cpp` is the live path
- [whisper.cpp on GitHub](https://github.com/ggerganov/whisper.cpp)
- [OpenAI Whisper paper](https://cdn.openai.com/papers/whisper.pdf)
