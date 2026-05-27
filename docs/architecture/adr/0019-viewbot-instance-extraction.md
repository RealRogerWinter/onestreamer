# ADR-0019: ViewBotClientService decomposition outcome

* **Status:** Accepted
* **Date:** 2026-05-27
* **Phase:** 11 (refactor & modularity)
* **PR:** 11.1 (`viewbot-instance-extraction`)
* **Related:** [ADR-0012](0012-startserver-decomposition-partial.md) (decomposition discipline), PR 6.1 ([ViewBotRepository extraction](../../../server/database/repository/ViewBotRepository.js))

## Context

`server/services/ViewBotClientService.js` was, at Phase 10 close, the single largest server file in the repo at **6015 lines**. Phase 11 was scoped to decompose it.

The Phase 11 brief inherited a hypothesis from the codebase-hotspot agent that the file contained "2–3 separate rotation modes tangled together" and that the right decomposition was to extract one mode (or rotation strategy) per file with the parent class becoming a thin dispatcher. The red team correctly flagged a contingency: if the modes share state (`this.activeBots`, `this.botCooldowns`, `this.rotationLock`, `this.pendingTakeoverTimer`, plus the rotation queue and live-bot tracker), extracting one breaks the other two, and the plan needs a path B (in-file reorganization + helper extraction + DB-code migration to ViewBotRepository) as the honest fallback.

When we actually opened the file, **neither path A as framed nor path B applied** in the way the brief expected. The structural reality:

1. **The file is two classes, not one.** Lines 1–2287 define `class ViewBotClientService` (orchestrator). Lines 2289–6012 define `class ViewBotInstance` (per-bot streaming client). Only the orchestrator is exported (`module.exports = ViewBotClientService;` at the foot); the bot-instance class is constructed exclusively by the orchestrator (at two callsites: the create-bot fast path and the restore-from-DB rehydrate path). No other module in the codebase imports it.

2. **The orchestrator does not have separable rotation modes.** Its ~50 methods comprise a *single* rotation system with multiple concern areas — rotation config (`loadRotationConfig`, `saveRotationConfig`, `updateRotationSettings`), bot lifecycle (`createBot`, `startBotStreaming`, `stopBotStreaming`, `destroyBot`), rotation control (`toggleRotation`, `startViewBotRotation`, `setRealStreamerStatus`, `maintainViewBotPresence`), rotation queue (`queueRotationRequest`, `processRotationQueue`, `handleRotation`), and the cooldown subsystem (`startCooldownCleanup`, `applyBotCooldown`, `getBotProbabilityMultiplier`, `selectViewBotWithCooldown`). These methods share `this.activeBots`, `this.currentLiveBot`, `this.rotationLock`, and the queue — extracting any one as a "mode" would create artificial coupling.

3. **Path B's premise was already done.** Path B contemplated pulling DB code into `ViewBotRepository`. PR 6.1 already did that exhaustively: `ViewBotClientService.js` contains *zero* SQL statements (verified by grep). All persistence flows through `this.dbService` (an instance of `ViewBotDatabaseService`, which uses `ViewBotRepository`).

4. **The bot-instance class is the actual giant.** At 3724 lines (lines 2289–6012), it dwarfs the orchestrator (~2280 lines). It owns its own state — `this.socket`, `this.browser`, `this.page`, `this.mediaStream`, `this.videoFFmpeg`, `this.audioFFmpeg`, `this.gstreamerVideoProcess`, etc. — and reaches into the orchestrator only through `this.parentService.X` accesses (read-mostly: `ffmpegPath`, `dbService`, `dbInitialized`, `realStreamerActive`, `rotationProbability`, `rotationCheckIntervalMin`, `rotationCheckIntervalMax`, `rotationEnabled`; two writes: `currentLiveBot`, `currentLiveBotSetTime`). The coupling is unidirectional and clean.

## Decision

**Class-level file split**: extract `ViewBotInstance` into `server/services/viewbot/ViewBotInstance.js`. `ViewBotClientService.js` keeps only the orchestrator and adds `const ViewBotInstance = require('./viewbot/ViewBotInstance');` at the top of its requires block.

This is path A *along an axis the original brief did not anticipate*. It is mechanical and behavior-preserving: the runtime semantics of `this.parentService.X` inside the bot-instance class are identical whether the class lives in the same file or is imported from a sibling module. Node's module cache makes the additional `require()` free after first load.

**Rejected: the brief's path A (rotation-mode extraction).** No separable modes exist. The orchestrator's rotation system is one coherent unit; pulling part of it out would split state coupling artificially and leave the dispatcher with the same volume of code plus more indirection.

**Rejected: the brief's path B (in-file reorg + helper extraction).** The DB-extraction half of path B was already completed by PR 6.1. The "reorganize into clearly-marked regions" half would have under-delivered relative to the available class-split. We can still extract pure helpers (FFmpeg argument builders, RTP parameter builders) and the cooldown subsystem in PR 11.2 — but those should be done *after* the file split, where each extracted helper has a single natural home (the bot-instance file or the orchestrator file).

## Consequences

**Quantitative:**

* `ViewBotClientService.js`: 6015 → **2290 lines** (62% smaller).
* `server/services/viewbot/ViewBotInstance.js`: **3750 lines** (new; 24-line header + 3724-line class body + footer).
* Net diff: ~+30 lines (the new header comment, new require line, and the `module.exports` for the new file).

**Qualitative:**

* `ViewBotClientService.js` is now reachable cold: a reader sees the orchestrator class top-to-bottom in one file, with no "scroll past 3700 lines to reach the bottom" tax.
* The `server/services/viewbot/` subdirectory is now established as the home for further bot-internal decomposition. PR 11.2 candidates include:
    * **FFmpeg argument builders** (`createVideoFFmpegArgs`, `createH264VideoFFmpegArgs`, `createAudioFFmpegArgs`, `createVideoRtpParameters`, `createAudioRtpParameters`) — ~300 lines of pure functions. Trivially extractable to `viewbot/ffmpeg-args.js`.
    * **Cooldown subsystem** (`applyBotCooldown`, `getBotProbabilityMultiplier`, `selectViewBotWithCooldown`, `startCooldownCleanup`) — ~120 lines, takes the cooldown `Map` as constructor arg, callable from the orchestrator via a thin facade.
* No behavior change. No API change. `ViewBotClientService` constructor signature, public methods, exported shape unchanged. Bootstrap (`server/bootstrap/services.js:157`) and the bootstrap services test (`server/tests/bootstrap/services.test.js:226`) do not need to change.
* Bot-instance state lifetime unchanged. The orchestrator still owns the `Map<botId, ViewBotInstance>` and still drives lifecycle.

## Things deliberately deferred

* **Pre-existing typo** at the *post-extraction* orchestrator line 192 (was original line 191): `Array.from(this.viewBots.values()).filter(...)`. The field is `this.activeBots`, not `this.viewBots`. The call path (`updateRotationSettings` → restart timers for active bots) would `TypeError` if invoked while any bots are streaming. Pre-existing on main; honoring "Don't refactor adjacent code while fixing a specific bug" — left as-is. A future PR (likely 11.2's cleanup) should fix it.

* **Trimming unused requires.** `ViewBotClientService.js` still imports `uuidv4` (unused inside the orchestrator class) and `puppeteer` (only mentioned in command-string matches inside `killOrphanedPuppeteerProcesses`, never invoked as a JS API). These are mechanical-extraction casualties: leaving them keeps the diff strictly a split. Drop in PR 11.2.

* **Further decomposition of `ViewBotInstance`.** The 3750-line file is its own iceberg — generation methods (`startCombinedFFmpegGeneration`, `startMultiplexedFFmpegGeneration`, `startPlainTransportFFmpegGeneration`, `startGStreamerVideoFileStreaming`, `startDirectRTPPipelines`) all live there. PR 11.2 may carve helpers out; the class itself stays as the integration point.

## How to verify

Test baseline at Phase 10 close (exclusion list: `worktrees|EgressFrameCaptureService|TranscriptionDrivenBotService|ChatBotLLMService.vision|VisionBotService`, `--runInBand`): **858 / 859 passing**. The single failure is the pre-existing `server/tests/database/transaction.test.js` better-sqlite3 rollback-on-constraint-violation case, same teardown-flake family as the `database-better.test.js` flake documented in earlier phases. Post-PR 11.1 the count must remain 858 / 859 — anything below would indicate the split changed semantics.

Live smoke (maintainer-gated; autonomous agent cannot run): `npm run dev`, take over a stream, create + start + destroy ViewBots through the admin panel, exercise the real-streamer takeover path, confirm rotation transitions still emit through the same socket channels.
