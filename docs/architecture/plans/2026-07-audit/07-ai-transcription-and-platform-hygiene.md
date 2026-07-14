# Plan 07 — AI/transcription, lifecycle & platform hygiene

_Part of the [2026-07 codebase audit](README.md). Owner area: `server/services/TranscriptionService.js` + `transcription/*`, `server/services/ChatBotService.js` + `chatbot/*` + `llm/*`, `MovieBotService.js`, `VisionBotService.js`, `server/index.js`, `server/bootstrap/*`, `server/services/ProcessManager.js` + `StreamingLogsService.js`, CI (`.github/workflows/ci.yml`), docs, dependencies._

> Status: **proposed**. Grouped because these are the platform's connective tissue: the AI/transcription load model, process lifecycle/shutdown correctness, the `global.*` coupling, and the CI/docs/dependency drift that lets regressions ship unseen.

## Themes

- **AI runs hot on one box.** Whisper, Ollama, ffmpeg, and egress share a single host; the audit found duplicated work (two bot schedulers on the same audio window, N-way chat-event fan-out) and missing timeouts that turn a slow dependency into a wedged bot.
- **Lifecycle is fragile at the edges.** Shutdown can hang or over-kill; fatal startup errors don't stop the process; module-scope timers outlive the drain; `global.*` singletons are the real (untyped, ungrepped) dependency graph.
- **The safety net is dark.** CI can't run the DB-heavy suite and never sees the deployed code; docs and dependencies still describe the pre-LiveKit world.

## Confirmed findings

### AI / transcription

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| A1 | medium | Continuous transcription mode is dead code that still writes unbounded PCM to disk (`TranscriptionService.js:258`); the whole-file `readFileSync`+`Buffer.concat` on finalize is at `TranscriptionAudioAdapter.js:428` (OOM risk, shared with timed mode); continuous ASR moderation is effectively off | `services/TranscriptionAudioAdapter.js:428` |
| A2 | medium | VisionBot stream-takeover guard is dead code (`streamService` never passed) → a bot comment from streamer A's frame posts into streamer B's chat after takeover | `services/chatbot/BotMessageDispatch.js:283` |
| A3 | medium | Whisper 20s hard timeout silently truncates 45s windows; the SIGTERM branch is unreachable so killed runs are treated as success → truncated ASR fed to bots + moderation as if complete | `services/transcription/WhisperRunner.js:85` |
| A4 | medium | Every connected bot re-emits each chat message onto `BotEventBus` → LLM "recent chat" context is N duplicate copies per message (models fixate/repeat); O(N²) event volume | `services/ChatBotService.js:336` |
| A5 | medium | MovieBot and VisionBot each run their own transcription scheduler → 2× whisper/LiveKit load on the same audio window | `services/VisionBotService.js:89` |
| A6 | low | No timeout on Groq fetch or Ollama chat → a hung LLM request permanently stalls a bot's loop; queued Ollama promises can hang forever | `services/chatbot/llm/groqClient.js:69` |
| A7 | low | Groq API key stored plaintext in two SQLite tables with divergent sources of truth (stale-key confusion after restart) | `services/chatbot/llm/groqConfigStore.js:49` |

### Bootstrap, lifecycle & globals

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| B1 | medium | `TakeoverService` permanently receives `undefined` redisClient — Redis-backed cooldown persistence is silently dead; the explaining comment is wrong (cooldowns reset every restart) | `index.js:443` |
| B2 | medium | Graceful shutdown can hang forever: no watchdog, `server.close()` waits on active connections, second HTTP listener never closed, `shutdown()` not re-entrancy-guarded | `bootstrap/shutdown.js:189` |
| B3 | medium | Fatal startup failures are swallowed → zombie process: `startServer().catch` only logs, HTTP `EADDRINUSE` only logs, HTTPS server has no error handler | `index.js:1654` |
| B4 | **high** | Shutdown safety net kills **all** host-wide ffmpeg + puppeteer-chrome on **every** graceful restart (not just crashes) — SIGTERMs the LiveKit egress recorder (Chrome + ffmpeg), corrupting in-progress recordings on each deploy | `bootstrap/shutdown.js:144` |
| B5 | medium | Eleven `global.*` singletons form the real dependency graph for lazy services — hidden coupling, ordering bugs, defeats extraction/testing | `index.js:1489` |
| B6 | low | Three module-scope `setInterval`s have no handle/stop/unref → outlive the drain, leak handles + live DB refs in tests (a "test flakiness" source) | `services/StreamingLogsService.js:347` |

_(Socket.IO allow-all CORS also lives in this file — tracked as S10 in [Plan 02](02-security-and-access-control.md).)_

### CI, docs & dependencies

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| O1 | high | CI installs with `npm ci --ignore-scripts` → skips `better-sqlite3`/`bcrypt` native bindings, so the DB-heavy server suite can't pass; no chat-service job. (Separately, because the git *remote* push is disabled — Plan 03 D1 — deployed commits never reach GitHub, so the otherwise-enabled push-triggered CI never runs against deployed code.) | `.github/workflows/ci.yml:23` |
| O2 | medium | `overview.md` still documents the retired "React dev server in production" model, contradicting the actual PM2 config; `ci.yml`/`.gitignore` carry stale mediasoup/dormant-LiveKit comments; root `package.json` ships both `sqlite3` and `better-sqlite3` plus browser libs in server deps | `docs/architecture/overview.md:164` |

## Remediation plan

### P1 — cheap correctness + reliability (days)

- **M2-adjacent / A2** — Pass `streamService` into VisionBot dispatch so the cross-stream guard fires; add a test through the real call path. (Privacy/correctness; pairs with the moderation work in [Plan 06](06-chat-moderation-and-viewbots.md).)
- **A4** — Emit chat onto the bus from a single source (one designated listener, or the chat-service HTTP callback) or dedup in `addChatMessage` by id/timestamp. Immediately improves bot context quality and cuts event volume.
- **A6** — Wrap all LLM calls in `AbortSignal.timeout(15s)` / `Promise.race`; give queued requests a max-age; `skip` (not `break`) saturated-model requests in `processQueue`.
- **A3** — Scale the whisper timeout with input duration (`max(20s, 2×audio_seconds)`); detect the kill via the `close` handler's `signal` and flag partial results (`{text, truncated:true}`); bound concurrent whisper processes with a small semaphore.
- **B1** — Wire Redis into `TakeoverService`. **Prefer adding a post-connect `setRedisClient(client)` setter** (TakeoverService is constructor-only today, so a new method is needed) — relocating `createServices` past `bootInitializeRedis` is a ~1200-line module-scope reordering, not a cheap tweak. Fix the misleading comment; log whether cooldowns are actually Redis-backed at startup.
- **B3** — Make the `startServer` catch `process.exit(1)` after a log flush; add an HTTPS `error` handler; treat listen errors as fatal (the "refuse to start" flags must actually stop the process).

### P1 — restore the safety net (days)

- **O1 — the ci.yml edits are independent of D1; land them now.** The `pull_request:` trigger is already active, so dropping `--ignore-scripts` (or following with `npm rebuild better-sqlite3 bcrypt`), deleting the stale mediasoup rationale, and adding a chat-service job (`cd chat-service && npm ci && npm test`) immediately start gating PRs — they do **not** wait on the git-history rewrite. Validate the native build on the CI runner image first (dropping `--ignore-scripts` can turn CI red if the build fails there — that's why "CI red OK" has been the norm). Only the end-to-end "green against the deployed HEAD" outcome awaits push-restore ([Plan 03](03-data-durability-and-disaster-recovery.md) D1). Without O1, none of the money-flow tests gate anything.

### P2 — lifecycle hardening & load model (days–weeks)

- **B2** — Add a top-of-shutdown watchdog (`setTimeout(()=>process.exit(1), 30_000).unref()`), a re-entrancy flag, `server.closeAllConnections?.()`, and close both HTTP and HTTPS servers.
- **B4 (promote to P1 — it fires on every restart, and bundle with B2, same `shutdown.js`).** The `pkill` block runs in the normal `shutdown()` path, so every PM2 restart/deploy corrupts any in-progress egress recording — far more frequent than "on crash." Scope the kill to descendants (iterate `ProcessManager`'s registry or `pkill -P <tree>`). **Critically, extend past ffmpeg to the two Chrome kills** (`shutdown.js:147,150` — `pkill -f "puppeteer.*chrome"` / `"chrome.*--no-sandbox…"`): the egress recorder is headless Chrome + ffmpeg and launches with `--no-sandbox`, so it'd still be killed after only the ffmpeg fix, and you **can't** stamp a `-metadata` marker onto Chrome. Match OneStreamer's own puppeteer by a distinctive `--user-data-dir`, or drop the pkills entirely in favor of ProcessManager-registry teardown. (Verify the host `pkill` actually reaches egress's ffmpeg given LiveKit's process/PID-namespace model before sizing.) Directly protects the recording pipeline in [Plan 01](01-recording-and-clips-pipeline.md).
- **B5** — Fold lazy services into the existing `app.locals.services` bag with a `lateServices` object populated by `start-streaming-backend`; pass getter functions to remaining readers; delete `global.*` writes one consumer-cluster at a time. Unblocks unit-testing and removes the ordering-bug class.
- **B6** — Store/`unref()` the module-scope timer handles (the moderation retention timer at `index.js:1391` already models this) or move them into owning classes with a `stop()`.
- **A5** — Centralize a single "transcription window" producer both bots subscribe to (per-bot cadence applied at consumption), or suppress VisionBot's scheduler when MovieBot is active — halves whisper/LiveKit load on a saturated box.
- **A1** — Decide continuous transcription's fate: delete it + `AudioBufferService` and make the admin route timed-only, or reimplement the 5s loop against the live PCM file (byte offsets + snapshot convert + rotate). Extend the audio janitor to `.pcm`; stream the WAV finalize instead of `readFileSync`.
- **A7** — Single source of truth for the Groq key (drop `moviebot_config.groq_api_key`, read via `ChatBotLLMService`, prefer `GROQ_API_KEY` env); at minimum encrypt-at-rest.
- **O2** — Update `overview.md` to the real two-PM2-apps + nginx-served-build model; sweep `ci.yml`/`.gitignore` comments for mediasoup/dormant references; prune server `package.json` of browser libs and the unused driver once the [Plan 04](04-database-and-economy-integrity.md) driver decision lands.

## Risks & red-team notes

- **B4's scoped-kill must still catch genuine strays.** The point of the host-wide kill was to reap orphaned ffmpeg after crashes. A marker-based approach only works if *every* spawn adds the marker — audit all `spawn('ffmpeg'…)` sites (there are ~8) and add the marker uniformly, else B4 trades a massacre for a leak.
- **O1 can turn CI red** the moment `--ignore-scripts` is dropped if native builds fail on the runner — validate the build on the CI image first; this is why it's sequenced after push-restore (D1), so a red CI is actionable rather than ignored ("CI red OK" has been the norm precisely because CI was broken).
- **A5/A1 change bot behavior timing** — fewer/less-frequent transcription windows may make bots feel less reactive. Tune cadence at the consumption layer; treat as a product decision, not just perf.
- **B5 is a long tail** — do it incrementally per consumer cluster; a big-bang globals removal risks the exact ordering bugs it's meant to cure. The `getViewbotService`/`getTranscriptionService` getter pattern already in the code is the template.

## Success criteria

- CI runs the server suite with native bindings and a chat-service job, green, on every PR (post push-restore).
- A hung Groq/Ollama call times out and the bot recovers; whisper timeouts scale with window length and flag truncation.
- Shutdown completes within the watchdog window or force-exits; a main-server crash no longer kills the egress recorder.
- `overview.md` matches the deployed process model; server `package.json` carries one DB driver and no browser libs.
