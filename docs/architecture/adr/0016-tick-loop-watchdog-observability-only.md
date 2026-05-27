# ADR-0016: Tick-loop watchdog pattern (observability only)

_Status: accepted_
_Date: 2026-05-27_
_Phase: 8 (Reliability hardening)_
_PR: 8.2 (`viewbot-rotation-watchdog`)_
_Cross-references: [ADR-0011](0011-lifecycle-manager.md) (lifecycle handles whose teardown the watchdog respects)._

## Context

The viewbot rotation runs as a `setTimeout`-chained tick loop:
`rotateToNextBot()` selects the next bot, starts it, then calls
`scheduleNextRotation(interval)` which sets a `setTimeout` that will
invoke `rotateToNextBot()` again. The chain lives in two services
behind a single orchestrator:

- `server/services/SimpleViewBotRotation.js` (Plain RTP / GStreamer mode)
- `server/services/WebRTCViewBotRotation.js` (WebRTC / Puppeteer mode)
- `server/services/UnifiedViewBotRotation.js` — owner of `isRotating`
  and the `activeRotation` pointer.

The runbook [`viewbot-fleet-misbehaving.md`](../../operations/runbooks/viewbot-fleet-misbehaving.md)
flags one of the most reproducible failure modes: an unhandled
exception inside `rotateToNextBot()` (or one of its awaited calls)
breaks the `setTimeout` chain. No further tick is scheduled. The
current bot — if any — keeps streaming forever; the rotation appears
"frozen on one channel." Operators today have no signal until somebody
notices visually or until the bot's underlying media file ends.

The Phase 6+ roadmap allocated PR 8.2 to closing this hazard. The
question is **what to do when the loop is detected stalled**.

## Decision

The watchdog is **observability only**: when a stalled loop is
detected, log a `level: error` event with full rotation-state
context, and do nothing else.

Concretely:

1. Each sub-rotation (`SimpleViewBotRotation`, `WebRTCViewBotRotation`)
   records `this.lastTickAt = Date.now()` at the **entry** of every
   `rotateToNextBot()` invocation — before any early-return guards.
2. `UnifiedViewBotRotation` runs a `setInterval` watchdog that polls
   every `watchdogCheckMs` (default 30 s) and fires a log line when:
   - `isRotating === true` (rotation is supposed to be running), AND
   - `activeRotation.lastTickAt !== null` (the loop has ticked at
     least once), AND
   - `Date.now() - lastTickAt > activeRotation.settings.maxRotationInterval * 2`.
3. The watchdog is started by `startRotation()`, stopped by
   `stopRotation()` and (defensively again) by `shutdown()`.
4. The log line includes: `mode` (`plainrtp` | `webrtc`), `backend`
   (`mediasoup` | `livekit`), `sinceLastTickMs`, `thresholdMs`,
   `maxRotationIntervalMs`, `isRotating`, and `realStreamerActive`
   (so a "wedged because a real streamer is active" wedge can be
   distinguished from "wedged because the loop threw").

The actual recovery is **a pm2 (or equivalent supervisor) restart of
the whole onestreamer-server process**, triggered by a human responding
to the log line. That path is documented in the runbook's "Full reset"
section. The watchdog's job is to make the log line happen.

## Consequences

**What this enables:**

- A stalled rotation no longer silently persists. Detection latency
  is bounded by `watchdogCheckMs` (30 s in production).
- The error context is structured enough that a future structured-
  logging pipeline (Phase 12) can route on `event:
  viewbot-rotation-stalled` without parsing free-text.
- The `realStreamerActive: true` case (rotation is "wedged" by design
  because a real human is broadcasting) still fires the log, but the
  receiver can filter it out — it's not actually a bug, just a
  long-running pause. The honest choice is to surface both states and
  let the operator's tooling decide.

**What this costs:**

- One extra `setInterval` per rotation lifecycle. Trivially cheap.
- A noisy "false positive" log line every time a real streamer
  broadcasts for more than `maxRotationInterval * 2` (~6 minutes for
  plainrtp, ~10 minutes for webrtc). Operators must filter on the
  `realStreamerActive` flag, or — if the noise is intolerable — a
  future PR can suppress the log when that flag is true (deferred
  decision; we don't want to suppress before we've seen the real noise
  shape in production).

**What becomes harder:**

- Nothing materially. The watchdog is purely additive — no behavior
  change to the rotation itself, no new code paths through the
  existing tick loop.

## Alternatives considered

### 1. Restart the rotation on detection

The "obvious" recovery: `await activeRotation.stopRotation();
await activeRotation.startRotation();` on detection.

**Rejected** for two reasons:

1. **Restart on top of a still-hung promise queues a second hung
   promise.** If the stall was caused by an awaited call that never
   resolves (e.g. a GStreamer spawn that hangs in `await new
   Promise(resolve => proc.on('error', resolve))` because the error
   handler is wrong, or a `livekitViewBotService.createViewBot()` that
   awaits an HTTP response that never comes), the original
   `rotateToNextBot()` is still in the JS heap, holding closures and
   any locks it claimed. Calling `stopRotation()` on the sub-rotation
   doesn't unstick the original promise — it just runs concurrently.
   `startRotation()` then enqueues a fresh `rotateToNextBot()` that
   competes with the first. The result is two parallel rotation
   chains, not a recovery.
2. **Process supervisors already do the right thing.** pm2 is
   configured to restart `onestreamer-server` on `SIGKILL` /
   non-zero exit / `pm2 restart`. The runbook documents the manual
   `pm2 restart onestreamer-server --update-env` step. Adding a
   different restart path inside the process competes with the one
   the operator already knows.

The red-team review during plan drafting (red-team #2) explicitly
flagged restart-from-watchdog as the wrong shape. PR 8.2 honors that.

### 2. Throw / promote to a process exit

`process.exit(1)` would cause pm2 to restart. Cleaner than the
in-process restart, but conflates two concerns: detecting a stall and
deciding the response. An operator at 3 AM wants to *see* the log line
and *decide* whether to restart based on the rest of the
system's state. Auto-exiting on a watchdog signal removes that
choice.

If the runbook later wants an aggressive auto-exit policy, the log line
is the trigger any structured-log routing can wrap with that policy.

### 3. Add a separate background process

A standalone watchdog process polling the API. Useful for
distributed deployments; massive overkill for onestreamer's single-
host single-tenant posture (per ADR-0014 / ADR-0011). In-process
watchdog reuses the existing lifecycle teardown.

### 4. Skip the warmup window with a grace period

The current implementation skips the check when `lastTickAt === null`
(rotation just started, no tick yet). An alternative was to track a
`startedAt` timestamp and add `maxRotationInterval * 2` before the
first check could fire. The null-check is simpler and achieves the
same effect: the first tick (inside `startRotation()` →
`rotateToNextBot()`) sets `lastTickAt` synchronously before the
sub-rotation's await chain begins.

## Future work

The watchdog is observability only at this stage. If production
operations later shows that:

- the "real streamer active" false-positive rate is too high → suppress
  when `realStreamerActive: true`, or change the threshold;
- the supervisor restart is too slow → consider an auto-exit shim
  (still NOT in-process restart);
- the structured log fields need extension → add them, the schema is
  not load-bearing yet.

PR 8.2 deliberately ships the **smallest log-and-alert hook** that
detects the documented runbook hazard. Anything more reactive is
deferred to a future PR with operational data to justify it.
