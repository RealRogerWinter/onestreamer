# ADR-0031: Viewer reconnect worker — minimal C5 state-machine slice pulled forward into LiveKitClient

_Status: accepted_
_Date: 2026-07-14_

## Context

The 2026-07 audit (Plan 05, "Streaming & takeover reliability") confirmed that
viewer auto-reconnection was dead code (finding C1): once LiveKit's built-in
`reconnectPolicy` exhausted its ~5 retries and the room fired a full
`RoomEvent.Disconnected`, the client only flipped fake transport state and
called `onConnectionLost` — the viewer wedged behind "Connection lost -
attempting recovery..." forever, and the "Attempt X of N" counter never
incremented (its only writer, `attemptReconnection()`, had zero callers).

Fixing C1 naively would add a **sixth** uncoordinated init/reconnect initiator
to the client — the audit's architectural root #1 (finding C5): five paths in
`WebRTCViewer.tsx` (the main init/cleanup effect, the streamer-change effect,
`onStreamUpdate → attemptStreamSwitch`, the socket stream-event handlers, and
manual `handleForceReconnection`) already synchronize only through ad-hoc refs
and magic sleeps, and "one path tears down what another built" is exactly the
recurring black-screen bug class. C5's full fix — a single client connection
state machine with a desired target + generation and one serialized worker —
is a P2 item measured in weeks.

The plan doc offered two options for C1: (a) pull a minimal version of the C5
serialized worker forward, or (b) ship C1 reading `streamGeneration` and the
existing refs directly. We chose (a).

## Decision

A **minimal serialized reconnect worker lives inside `LiveKitClient`**
(`startReconnectWorker` / `scheduleReconnectAttempt` / `runReconnectAttempt`),
replacing the dead `attemptReconnection()`:

- **Trigger**: only a full `RoomEvent.Disconnected` whose reason is not
  `CLIENT_INITIATED` (and not after `destroy()`). At that point LiveKit's
  built-in retries have already given up, so the worker cannot race or storm
  them — this is the thrash guard the audit red-teamed.
- **Behavior**: single-flight (`isReconnecting`), up to **8 attempts** with
  exponential backoff `1s·2^k` capped at 30s, each attempt re-fetching a
  **fresh token** via `getLiveKitToken()` (the old token may have expired
  mid-outage, and the refetch picks up the post-reconnect socket.id identity)
  before `room.connect()`. Timers go through `createTrackedTimeout` so
  `destroy()` cancels them. Each attempt increments `reconnectionAttempts`,
  which makes the existing polled "Attempt X of 8" overlay real. On success
  the existing `Connected → onConnectionRecovered` and `TrackSubscribed →
  onStreamUpdate` wiring restores the video. On exhaustion the worker fires
  `onReconnectionFailed`, which `WebRTCViewer` now wires to a terminal error
  plus the existing manual retry/Force Reconnect affordances.
- **Containment (epoch/teardown argument)**: a `connectEpoch` counter is
  bumped by every deliberate teardown or fresh-connect path —
  `destroy()`/`cleanup()`, `reset()`, `forceReconnection()`, and the connect
  starts inside `produce()`/`consume()`. The worker captures the epoch when it
  starts and aborts (before and after every await) if the epoch moved or the
  client was destroyed. All five `WebRTCViewer` initiators funnel their
  teardowns through `cleanup()`/`destroy()` on the adapter, so any of them
  superseding the connection kills the worker rather than the worker
  resurrecting a torn-down connection. None of the five initiators themselves
  were touched.

### Why inside LiveKitClient (and not a new ConnectionOrchestrator module)

Lowest blast radius: the worker sits *below* the five existing initiators,
where every teardown is already observable via `cleanup()`/`destroy()`, and
the change is invisible to `WebRTCViewer`'s ordering logic. A separate
orchestrator module would have had to intercept the initiators now — that is
C5's job, not C1's.

### Budget for the C5 re-home

This is explicitly **not** presented as self-contained. When C5 lands the
single client connection state machine (desired `targetStreamId` +
generation, one serialized worker, delete the sleep-based sequencing), this
worker is expected to be **re-homed into it**: the epoch becomes the state
machine's generation, the Disconnected trigger becomes a "desired target:
stay connected" submission, and `LiveKitClient` stops owning retry policy.
Budget the migration as part of C5, not as new scope.

### Why 8 attempts

The audit's success criterion is "a viewer survives a 2-minute network drop
and auto-recovers without a manual refresh". Five attempts at 1+2+4+8+16s
(~31s) fail that criterion; 8 attempts at 1+2+4+8+16+30+30+30 ≈ **121s** meet
it without an unbounded loop against the SFU. The overlay copy changed from
"of 5" to "of 8" to match.

## Consequences

- Viewers recover from outages up to ~2 minutes automatically; the
  reconnection UI counts real attempts (`reconnectionAttempts` finally has a
  live writer).
- `onConnectionLost` now drives the viewer to `connectionState:
  'reconnecting'` (attempt-counting overlay) instead of a dead-end
  `'disconnected'` error.
- A token-endpoint outage during network recovery counts as a failed attempt
  and keeps backing off (fetch failure ≠ crash).
- The worker adds retry state to `LiveKitClient` that C5 must absorb; until
  then, any future code path that disconnects the room **without** going
  through `cleanup()`/`destroy()`/`reset()`/`forceReconnection()` must bump
  `connectEpoch` or risk the worker reviving a deliberate teardown.
- Related fixes shipped alongside (same audit plan): C2 (`replaceAudioTrack`/
  `replaceVideoTrack` now use `LocalTrack.replaceTrack` like the screen-share
  path), C3 (publish failure aborts stream start instead of a silent
  local-preview fallback), C4 (socket listeners removed by reference, not by
  bare event name).
