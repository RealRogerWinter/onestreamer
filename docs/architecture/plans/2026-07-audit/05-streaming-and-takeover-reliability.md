# Plan 05 — Streaming & takeover reliability

_Part of the [2026-07 codebase audit](README.md). Owner area: `client/src/services/LiveKitClient.ts`, `client/src/components/stream/WebRTCViewer.tsx` + `WebRTCStreamer.tsx`, `client/src/components/ConnectionMonitor.tsx`, `server/services/LiveKitService.js`, `server/services/StreamService.js`, `server/sockets/streamHandler/takeover.js`, `server/services/RandomStreamRotationService.js` + `random-stream/*`, `server/services/TakeoverService.js`, `server/services/TimeTrackingService.js`._

> Status: **proposed**. This plan targets the recurring **black-screen / ghost-streamer** class of bugs the README and archived `STREAM_RELIABILITY_PLAN.md` already flag as partially-fixed. The audit found the two architectural roots (client init/reconnect arbitration; server `currentStreamer` drift) plus several concrete instances.

## The two architectural roots

1. **Client: five uncoordinated init/reconnect initiators** synchronized only by ad-hoc refs and magic `sleep`s (`WebRTCViewer.tsx:173`). Each new stream-lifecycle feature added another initiator and another guard; the failure mode is always the same — one path tears down the client another just built (black screen), or a guard flag is left set and the viewer wedges. Every individual client bug below is an instance.
2. **Server: `currentStreamer` identity spread across 3+ sources** with string-prefix typing (`StreamService.js:102`) — the dual-source-of-truth drift the README calls partially-fixed. The `streamGeneration` counter fixed client-side *ordering* but not server-side *identity*. Every new writer must remember N mirror writes and pick the right prefix predicate; each drift manifests as a different one-off symptom (black screen, viewbot won't start, stream won't clear).

Fixing instances without fixing these two roots means the class keeps regenerating.

## Confirmed findings

### Client streaming

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| C1 | high | Viewer auto-reconnection is **dead code**: after LiveKit exhausts ~5 retries the client shows "attempting recovery…" forever; the `reconnectionAttempts` UI never increments | `services/LiveKitClient.ts:311` |
| C2 | high | `replaceAudioTrack`/`replaceVideoTrack` assign the **unawaited** `publishTrack()` Promise as the local track → corrupted producer state after any mid-stream device change (screen-share then fails, duplicate tracks) | `services/LiveKitClient.ts:1222` |
| C3 | high | Streamer publish failure is swallowed (only `console.warn`) → streamer looks live locally while every viewer gets a black screen, no error surfaced | `components/stream/WebRTCStreamer.tsx:968` |
| C4 | medium | `ConnectionMonitor` calls `socket.off('stream-started'/'stream-ended')` **without handler refs** → strips every other component's handlers on cleanup/flap | `components/ConnectionMonitor.tsx:135` |
| C5 | medium | Five uncoordinated init/reconnect initiators (architectural root #1) | `components/stream/WebRTCViewer.tsx:173` |

### Server: takeover, rotation, orchestration

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| T1 | high | Unauthenticated `PUT /api/random-stream/settings` with a non-numeric value poisons the interval to `NaN` → persistent rapid-rotation loop, persisted to disk | `routes/random-stream.js:353` |
| T2 | high | Race between takeover approval and rotation: rotation paused ~15 async steps after the cooldown check; concurrent `request-to-stream` handlers both pass the global-cooldown gate | `sockets/streamHandler/takeover.js:426` |
| T3 | medium | Takeover never ends the ousted streamer's time-tracking session → they keep earning ~500 pts/25s indefinitely (deterministic points exploit); `cleanupStaleSessions` also force-ends legit >60-min streamers | `sockets/streamHandler/takeover.js:210` |
| T4 | medium | Cancelling a pending rotation retry leaves the awaited backoff promise unresolved forever; `forceRotate` doesn't clear retry state → hung control flow + premature double-rotations | `services/random-stream/RotationRetryState.js:101` |
| T5 | medium | `TakeoverService.cooldownSeconds` never initialized: `getRemainingCooldown()` always 0, guard-item extended cooldowns never persisted (swallowed `null.toString()` TypeError) | `services/TakeoverService.js:160` |
| T6 | medium | `currentStreamer` identity spread across 3+ sources with prefix typing (architectural root #2) | `services/StreamService.js:102` |
| L1 | medium | LiveKit health-check `clearStaleStreamer` has a TOCTOU race that can kill a freshly-taken-over healthy stream (ignores `streamGeneration`) | `services/LiveKitService.js:690` |
| T7 | low | `canTakeOver` fails **open**: any thrown error grants takeover, bypassing all cooldowns; the pino misuse hides the error | `services/TakeoverService.js:110` |
| L2 | low | Dead MediaSoup-era compat shims still mint tokens and feed an always-empty `producers` map (readers assume it reflects reality) | `services/LiveKitService.js:261` |

**Refuted** (do not action): the "takeover fallback timer stale-closure destroys the fresh connection 3s after every takeover", "forceReconnection reuses an expired token / identity changes across reconnects", "verifyParticipantTracks inverted TrackType constants", "verifyParticipantTracks ~50s backoff blocks stream-ready", and "LiveKit API errors swallowed with no caller signal" claims were all investigated and **refuted** by the adversarial pass.

## Remediation plan

### P0 (hours)

- **T1** — Validate `PUT /api/random-stream/settings` numerics with `Number.isFinite()` after `parseInt`, reject 400 on `NaN`, cross-validate `min <= max`; add a defense-in-depth clamp in `RotationScheduler.scheduleNext` (`if (!Number.isFinite(interval) || interval < MIN) interval = DEFAULT`). Pairs with the `ENFORCE_STREAM_CONTROL_AUTH` flip in [Plan 02](02-security-and-access-control.md).
- **T3 (economy exploit half)** — Fix the points farm now: on takeover, end the previous streamer's streaming session; the stale-sweep liveness fix can follow in P1.

### P1 — fix the concrete instances (days)

- **C1** — In the `RoomEvent.Disconnected` handler (non-intentional reasons), run a reconnection that actually re-fetches a fresh token and calls `room.connect()` (waiting for `Reconnected` is useless once fully `Disconnected`), with backoff. This is the single biggest long-session reliability hole — **but note it adds a *sixth* init/reconnect initiator to the system architectural-root #1 is about.** Done naively in the pre-C5 world it risks becoming the exact "one path tears down what another built" black-screen bug and will be re-homed by C5. So either pull a minimal version of the C5 serialized worker forward and have C1 submit a *desired target* through it (not a raw `connect()`), or ship C1 explicitly reading/respecting `streamGeneration` + the existing refs and budget its rework under C5. Do not present C1 as fully self-contained.
- **C2** — Use `localTrack.replaceTrack(newTrack)` (as the screen-share path already does) or `await` unpublish/publish and assign `pub.track`. Handle publish rejection.
- **C3** — Treat publish failure as stream-start failure. The catch at `WebRTCStreamer.tsx:968` currently only `console.warn`s and then **falls through** to `setIsLoading(false)` + `onStreamStart?.()` at :982–983, so the streamer is marked live regardless — `setError` alone is insufficient. The catch must **early-return (or rethrow) before the `onStreamStart` call**, then add the retry / `publish-failed` path.
- **C4** — Pass the same handler references to `socket.off` (as `WebRTCViewer`'s cleanup already does).
- **T2 (top P1 item — the only `high` here; it's a handler restructure, not a line edit).** `canTakeOver` is **async** (awaits Redis), so there is no single synchronous step that can atomically span the check and `recordTakeover` ~15 awaits later. Lead with the robust option: **serialize `request-to-stream` through a per-server promise chain**, or set a synchronous `takeoverInProgress` flag *before* `await canTakeOver` and clear it after `recordTakeover` (the scheduler/forceRotate/recovery-monitor check it). Pause/disable rotation first, before `setStreamer`. This changes global-cooldown semantics for all users, so cover with the takeover characterization tests. Also remove the redundant 200ms `sleep` at `takeover.js:256` (the server-side instance of the sleep-sequencing anti-pattern).
- **T4** — Have `clearTimer()` (and every cancel site) resolve the pending promise with `{success:false, cancelled:true}`; make `forceRotate` call `_recordSuccess()` on success so the retry counter resets.
- **T5 — "live-but-broken," not dead.** `getCooldownSeconds()` has two live callers (`user.js:99` serves it in `/admin/dashboard`; `takeover.js:218` uses it as a fallback) and its current `undefined` value is pinned by a characterization test (`TakeoverService.test.js:109`). So **alias** `getCooldownSeconds()`→`individualCooldownSeconds` (don't delete — that breaks the build) and **update the pinning test**; confirm the admin dashboard client tolerates the value change. The one *real* bug is that `extendedCooldownUntil` is never persisted (only `last_stream_start_time` is), so guard-item cooldowns vanish on restart — persist it (Redis TTL) and reload it. (`getRemainingCooldown()` "always 0" has no callers and the swallowed `null.toString()` is caught and harmless — treat both as context, not the fix.)
- **L1** — Guard `clearStaleStreamer` with compare-and-clear: capture `streamGeneration` before the await and only clear if it still matches (`StreamService.clearStreamerIfCurrent(id)`).
- **T7** — Make `canTakeOver` fail **closed** on error; convert its `logger.error` calls to `{ err }` form.

### P2 — fix the roots (weeks)

- **C5** — Introduce a single client connection state machine (reducer or small class) holding desired `targetStreamId` + generation. All triggers only submit a desired target; one serialized worker performs teardown/connect and checks its generation before touching refs/DOM. Delete the sleep-based sequencing. The C1–C4 fixes then have a coherent home.
- **T6** — Make `StreamService` the single writer of streamer identity (delete direct `webrtcService.currentStreamer` assignments; readers subscribe or read through it); replace prefix-sniffing with an explicit `streamerKind` (`'human'|'viewbot'|'url-relay'`) set by `setStreamer(socketId, streamType, kind)` and exposed as `isRealStreamer()`. This also underpins the viewbot bot-over-human fix in [Plan 06](06-chat-moderation-and-viewbots.md).
- **T3 (stale-sweep half)** — Change `cleanupStaleSessions` to check liveness (socket still in the `streamer` room) rather than raw 1-hour age, so legit long streamers keep accruing.
- **L2** — Delete the unreachable MediaSoup shims and the empty `producers`/`consumers`/`transports` maps; replace `takeover.js`'s `producers.get()` track check with a LiveKit `listParticipants` query (the real source of truth).

## Risks & red-team notes

- **C1 reconnection can thrash** if it races LiveKit's own built-in reconnect — only start the manual path on full `Disconnected` (built-in already gave up), and back off; a bad implementation reconnect-storms the SFU. Cover with a simulated-outage test.
- **T6 is a wide refactor** touching every `currentStreamer` reader; it is the highest-value but highest-churn item here. Sequence it *after* the concrete P1 fixes so it lands on a stable base, and lean on the existing takeover/stream characterization tests as the safety net. This is exactly the work the archived `STREAM_RELIABILITY_PLAN.md` left as TODO — treat that plan as prior art, not a competing one.
- **C5 (client state machine) must preserve the existing socket-event contract** — it changes *how* the client arbitrates, not *what* events it reacts to. Keep the `WebRTCViewer` RTL suite green throughout.
- Respect the refuted findings above — do not "fix" the fallback-timer or token-reuse non-bugs; that churn risks introducing the very races the verifiers confirmed aren't there.

## Success criteria

- A viewer survives a 2-minute network drop and auto-recovers without a manual refresh; the reconnection UI reflects real attempts.
- Mid-stream camera/mic swap keeps all viewers live; screen-share still works afterward.
- A streamer whose publish fails sees an error + retry, and viewers are not told a black stream is live.
- Concurrent `request-to-stream` under load never produces two "live" streamers; rotation cannot clobber a fresh takeover.
- `currentStreamer` has a single server-side writer and an explicit kind; the ghost-streamer characterization tests pass.
