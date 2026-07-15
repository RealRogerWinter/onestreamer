# ADR-0033: Serialized takeover critical section (per-server promise chain + `takeoverInProgress` flag)

_Status: accepted_
_Date: 2026-07-15_

## Context

The 2026-07 audit (Plan 05, finding **T2**, the plan's top P1 item) confirmed a
race between takeover approval and rotation:

- `request-to-stream` (`server/sockets/streamHandler/takeover.js`) awaited
  `takeoverService.canTakeOver()` and then performed ~14 more awaits before
  `recordTakeover()` finally armed the global cooldown. Two concurrent
  handlers both passed the cooldown gate (`canTakeOver` reads
  `lastStreamStartTime`, which only `recordTakeover` sets), and the last
  writer silently won `setStreamer`.
- Rotation actors — the `RotationScheduler` timer callback, `forceRotate`
  (chat `!next` votes / admin), and the 5s `RotationRecoveryMonitor` poll —
  could interleave anywhere in that window and `setStreamer(urlId)` right
  over a human takeover (the recovery monitor is the worst: mid-takeover,
  before `setStreamer` lands, `hasRealStreamer()` is still false, so it would
  *start* a rotation).
- The rotation pause ran near the *end* of the handler — after `setStreamer`
  **and** `recordTakeover` — so an armed rotation timer survived into the new
  stream.
- A 200ms "viewer consumer cleanup" sleep in the middle of the section was a
  MediaSoup-era relic (under LiveKit, `webrtcService.cleanup()` only clears
  in-memory maps — ADR-0024) and an instance of the sleep-based sequencing
  anti-pattern the audit calls out.

`canTakeOver` is async (Redis), so no single synchronous step can span the
check and the record. The audit offered two options: a per-server promise
chain, or a synchronous in-progress flag. We use **both**, because they solve
different halves: the chain serializes *takeover vs. takeover*; the flag lets
*rotation actors* (which must not queue behind a takeover — they should skip
and retry later) stand down cheaply.

## Decision

**`StreamService` owns the serialization primitive** (it is the singleton both
sides already share: `deps.streamService === global.streamService`, which the
rotation helpers already read):

- `runExclusiveTakeover(task)` — a per-server promise chain. Tasks run
  strictly one-at-a-time; `takeoverInProgress` is `true` for exactly the
  task's duration (cleared in `finally`; the internal chain swallows
  rejections so one failed takeover cannot wedge the queue).
- The whole `request-to-stream` flow — `getCurrentStreamer` read,
  `canTakeOver` gate, viewbot teardown, `setStreamer`, `recordTakeover` —
  runs inside one exclusive section. The second of two concurrent human
  requests re-runs `canTakeOver` **after** the winner's `recordTakeover` and
  is deterministically denied (`global_cooldown`). This is an intentional,
  user-visible semantics change (previously: silent last-writer-wins).
  Fast pre-checks that mutate nothing (permission gating, IP-ban check, the
  `callback(true)` ack) stay outside the section.
- **Rotation pause moved to before `setStreamer`** (still `!isViewBot`-guarded);
  `pause()` keeps `shouldAutoRestart=true`, so rotation resumes via the
  recovery monitor when the real streamer ends. If the handler throws after
  the pause, the monitor self-heals within ~5s once the flag clears.
- **Rotation actors check `global.streamService?.takeoverInProgress`** and
  stand down: scheduler timer callback (skip + reschedule),
  `executeRotationWithRetry` (early return), `forceRotate` (denied with the
  vote-handler-compatible `{ success:false, error:'Takeover in progress' }`),
  recovery-monitor poll (short-circuit). Optional chaining is load-bearing —
  unit suites construct these helpers with no `global.streamService`.
- **Defensive in-flight abort**: a rotation already past its guards when the
  flag was set tears its just-started URL stream back down
  (`_rotateToNewStream` re-checks the flag / `hasRealStreamer()` after
  `startURLStream` succeeds and returns `{ success:false, error:'superseded
  by takeover' }`).
- The 200ms sleep was deleted (and the takeover characterization test's
  fake-timer dance with it).

## Consequences

- Concurrent `request-to-stream` under load can no longer produce two "live"
  streamers, and rotation cannot clobber a fresh takeover — the plan's
  success criterion.
- Takeover requests now queue: a slow takeover delays the next request. The
  section contains no unbounded waits (the sleep is gone; the chat-service
  announcement POST is fire-and-forget), but a hung `pause()` would stall the
  queue — flagged as the known sharp edge; keep new awaits inside the section
  bounded.
- The residual race window (a rotation between its flag-check and its own
  `setStreamer`) is shrunk by the defensive abort but only fully eliminated
  by the T6 single-writer/`streamerKind` root fix (Plan 05 P2), which should
  reuse the same compare-and-set tool as L1's `clearStreamerIfCurrent`.
- This is the server-side analog of ADR-0031's doctrine (one serialized
  worker instead of N racing initiators); like there, the minimal slice was
  pulled forward rather than the full T6 root fix.
- Shutdown (ADR-0032) does **not** await the takeover chain — an in-flight
  takeover at SIGTERM is abandoned and the watchdog stays authoritative.
