# ADR-0011: LifecycleManager for deferred one-shot work

**Date**: 2026-05-27
**Status**: Accepted
**Phase**: 4 (`server/index.js` decomposition)
**PR**: 4.2 — first PR of Phase 4 that warrants an architectural decision.

## Context

[`docs/architecture/background-work.md`](../background-work.md) catalogues the
process's `setInterval` / `setTimeout` / child-process surface. The "Notable
hazards" section names the `setTimeout` chains in `server/index.js` startup as
the open problem this ADR addresses:

> `server/index.js:5242, 5319, 5401, 5505, 5514, 5913, 5952, 6140` schedule
> autostarts and graceful-shutdown work with no per-handle reference. If
> service init fails partway, the deferred work still fires against
> torn-down state. Phase 4 (`startServer()` decomposition into a phased
> `LifecycleManager.start()`) cleans this up.

(Line numbers in that quote pre-date Phase 3; PR 4.1's mapping artifact in
the CHANGELOG entry has the post-PR-4.1 site list.)

At the start of Phase 4 there were **9** scheduler-candidate `setTimeout`
sites — 7 in `server/index.js`, 2 inside `server/sockets/DisconnectHandler.js`
(extracted from `server/index.js` in PR 4.1). Each `setTimeout(fn, delayMs)`
returned a handle that nobody stored, so nothing could `clearTimeout(handle)`
on SIGTERM. A graceful shutdown that landed inside any of those grace
windows fired the callback against half-torn-down state — sometimes a
swallowed exception, sometimes a wedged child process, occasionally a
zombie rotation cycle.

Two additional `setTimeout` sites in the same file (line 5150 — boot-time
`global.io.emit('test-event', {test: true})`; line 5706 — diagnostic
iteration over every authed session at boot, logging
`getStreamerDisplayName` resolution) were dev-debug code that should never
have shipped. They're not scheduler candidates; they're deletion candidates.

Two other `setTimeout` sites in the same file have non-scheduler shapes and
are intentionally left alone:
- **Line 5749** — `setTimeout(...timeout 5s...)` inside a `Promise.race`
  for the per-service `stop()` deadline. The handle is captured in `timer`,
  the corresponding `clearTimeout(timer)` already runs in the loop's
  `finally`. Correctly scoped.
- **Line 5920** — `await new Promise(resolve => setTimeout(resolve, 500))`.
  Used as a sleep, not a deferred callback. Different shape; the
  LifecycleManager's API doesn't fit.

## Decision

Introduce a **`LifecycleManager`** service (`server/services/LifecycleManager.js`)
as the central registry for one-shot deferred work. Two methods:

- `schedule(name, fn, delayMs) -> handle | null`
- `cancel(handle) -> boolean`
- `async stop()` — clears every pending handle. Registered as a stoppable
  so SIGTERM drains the registry through the existing reverse-iteration
  loop in `server/index.js`'s `shutdown(signal)` handler.

Every call site that previously read

```js
setTimeout(fn, delayMs);
```

is replaced with

```js
lifecycleManager.schedule('name-for-observability', fn, delayMs);
```

Errors thrown by `fn` are caught and logged with the task `name` and the
original `delayMs`. The wrapper does **not** re-throw — symmetry with the
existing inline pattern, where every `setTimeout(async () => {...})` site
already absorbed its own exceptions in nested try/catch blocks.

The two dev-debug `setTimeout` sites are **deleted**, not relocated.
Producing zero deferred work is strictly better than producing one wrapped
piece of deferred work that does nothing useful.

## Consequences

### Positive

- **SIGTERM during a delay window cancels the work.** The headline win for
  the *pre-fire* race. Production has had at least one observed instance of
  a viewbot rotation start firing against a half-shut-down LiveKit room
  after a `pm2 restart`; that race is now closed.
- **SIGTERM after a fn has fired but before it has resolved is awaited, not
  ignored.** The wrapper tracks each in-flight promise in `this.inFlight`;
  `stop()` `Promise.allSettled`s them before resolving. Without this, the
  `async stop()` qualifier would have been misleading — it would have
  returned on the next microtask while the in-flight fn ran free. The
  shutdown loop's per-service 5-second `Promise.race` deadline still
  bounds the total wait, so a wedged background task gets the existing
  "stop() timed out" telemetry rather than a silent hang. (This was a
  review-feedback fix; the first draft of the wrapper deleted the handle
  from `pending` and then awaited fn without tracking the resulting
  promise — caught by the reviewer.)
- **Per-task names land in logs.** A failed deferred fn now logs
  `[Lifecycle] <name> threw after <delayMs>ms`. Previously a thrown
  exception inside a `setTimeout(async () => {...})` was a microtask-loss
  black hole unless the inner code had its own catch.
- **One stoppable, not nine.** Without LifecycleManager, fixing this hazard
  service-by-service would have meant N new `stop()` methods, N new
  pending-handle maps, N tests. One registry means one mock + one identity
  pin in the bootstrap test.
- **Stoppables ordering**: lifecycleManager appears LAST in `stoppables`,
  so reverse-iteration drains it FIRST. Any pending deferred work
  scheduled against the other services is cancelled before those services
  start tearing down.

### Negative / Trade-offs

- **No back-pressure / no priority queues.** Two scheduled tasks can fire
  in the same tick if their `delayMs` collides; their order is whatever
  Node's timer queue picks. None of the current callsites care, but a
  future caller that does will need a different mechanism.
- **No "fire-on-condition" or "schedule-relative-to-other-task" shape.**
  The 7 baseline callsites are all "fire once after N ms"; this ADR
  scopes the API to exactly that. A future PR with a different shape
  (e.g. "fire when service X reports ready") gets its own mechanism.
- **The two dev-debug deletions are a behaviour change.** A motivated
  developer who was relying on the `test-event` broadcast or the
  `getStreamerDisplayName` boot-log iteration loses those affordances.
  The judgement call: dev-debug code that's been shipping to production
  unguarded is more noise than signal. If either is wanted back, it
  should land behind `process.env.NODE_ENV !== 'production'`.
- **AccountDeletionScheduler push.** The
  `'account-deletion-scheduler-start'` task body now also pushes the
  scheduler onto `stoppables` after it starts. This closes a pre-existing
  gap (the scheduler was constructed inside a setTimeout, so the
  bootstrap factory could never have registered it) — but it's a
  behaviour change adjacent to the headline relocation. Called out in the
  CHANGELOG entry rather than scoped out, because the deferred
  construction is exactly the failure mode this PR is closing. **Why this
  isn't itself a race**: the task body
  (`require → new → start → stoppables.push`) is fully synchronous JS —
  no awaits between the construction and the `push`. SIGTERM can't
  interleave a half-pushed scheduler because the body completes
  atomically with respect to the event loop. Either the task fires
  before SIGTERM and the push completes, or `stop()` cancels the timer
  before it fires and the scheduler is never constructed. A cleaner
  fix (PR-deferred): construct the scheduler eagerly in the bootstrap
  factory and only defer `.start()`. Out of scope here.

## Alternatives considered

### A. Service-by-service `stop()` methods

Each service that schedules deferred work gets its own pending-handle map +
`stop()`. Rejected because:
1. 9 callsites span at least 5 different files (`server/index.js`,
   `server/sockets/DisconnectHandler.js`, plus services that PR 4.3 will
   move other work into). Each would need its own per-service registry.
2. The shape of the work is identical at every site — `setTimeout(fn,
   delayMs)`. There's no service-specific cancellation semantic.
3. The shutdown loop already iterates `stoppables`. A single new entry
   gets all 9 sites for free.

### B. A free-function module instead of a class

`module.exports = { schedule, cancel, stop }` with module-scope `pending`
state. Rejected because:
1. The bootstrap factory's identity-pin tests (PR 2.3's fail-fast guard)
   are easier against a class.
2. A second LifecycleManager instance (e.g. for tests, or for a future
   sub-process) needs separate state. A free-function module would have
   to expose a constructor anyway.

### C. Replacing every `setTimeout` (not just scheduler candidates)

Including the `Promise.race` deadline (`server/index.js:5749`) and the sleep
(`:5920`). Rejected because both have different shapes — the deadline
already correctly captures and clears its handle, the sleep doesn't return
control flow. Forcing both through `schedule` would distort the API.

## Implementation notes

- Constructed in `server/bootstrap/services.js`'s `createServices` factory
  with no deps. Added to `expectedKeys` (38 → 39).
- Appended to `stoppables` LAST in the construction-order array so
  reverse-iteration drains it FIRST.
- Threaded into `server/index.js`'s module-scope destructure alongside the
  other notifiers.
- Threaded into `DisconnectHandler.js` via the existing per-connection
  deps bag at the call site in `io.on('connection', ...)`.
- Bootstrap test bumped to 39 keys + new identity-pin test (no-arg ctor)
  + new ordering test (`lifecycleManager` is the last stoppable).
- Dedicated test file `server/tests/services/LifecycleManager.test.js` (14
  tests) covers schedule, cancel, stop, validation, error swallowing,
  edge cases (cancel-after-fire, cancel-foreign-handle, schedule-after-stop).

## References

- [`docs/architecture/background-work.md`](../background-work.md) — the
  hazard catalog this ADR closes.
- ADR-0009 — StreamNotifier chokepoint (same shape: a single registry
  replacing N callsites for a single concern).
