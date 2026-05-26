# ADR-0009: Single `stream-ended` emission chokepoint (`StreamNotifier`)

_Status: accepted_
_Date: 2026-05-26_

## Context

Phase 3 of the refactor is named **state unification + typed socket facade**. The mechanical driver is documented in [`docs/architecture/socket-events-actual.md`](../socket-events-actual.md): a handful of socket events are emitted from many independent sites. For `stream-ended` specifically, there are **17 emit sites across 8 files** — 16 `io.emit('stream-ended', …)` calls plus 1 `socket.broadcast.emit('stream-ended', …)` for the takeover variant. The other Phase 3 fragmentation targets are 13 for `viewer-count-update`, 10 for `buff-error`, and 9 each for `streamer-buffs-update` and `inventory-updated`. Each one of those events represents a **single conceptual change** in server-side state, but the emit logic is duplicated everywhere the state mutates.

That fan-out is exactly the shape that produces cross-channel ordering bugs. PR 2.5's `streamGeneration` counter on `stream-status` was a fix for one such bug — but the structural problem (one truth, many emit sites) is still present everywhere else. Adding a new emit-side invariant today (a monotonic counter on `stream-ended`, a `version` field, a typed payload contract, structured logging) means touching N callsites in N files and praying they all stay in sync.

`stream-ended` is the headline example:

```
server/sockets/ViewBotHandler.js:385         reason: 'stop_stream_request'
server/sockets/StreamHandler.js:414          reason: 'takeover'           (socket.broadcast.emit — different shape)
server/sockets/StreamHandler.js:792          reason: 'user_stopped_streaming'
server/index.js:2016, 2053, 2080, 2788, 3154, 3225, 5112   (7 admin/test/disconnect paths)
server/services/ViewBotURLService.js:1236, 1448             reason: `url_stream_${dynamic}` / 'url_stream_stopped'
server/services/LiveKitService.js:659         reason: 'webrtc_disconnect'
server/services/ViewBotRotationService.js:286 reason: 'rotation'          (uses global.io — no DI)
server/services/RandomStreamRotationService.js:873, 962   reason: 'random_rotation_starting' / '_stopped'
server/services/WebRTCViewBotRotation.js:206  (no reason at all — would silently slip past any client switch-case)
```

Receivers DO discriminate on `reason` — `client/src/hooks/useStreamState.ts:318` has explicit branches for `'takeover'`, `'random_rotation_starting'`, `'random_rotation_stopped'`, `reason.startsWith('url_stream_')`, and `'webrtc_disconnect'`. A typo (`admin_clearr`) or a no-reason emit (the WebRTCViewBotRotation site) silently bypasses every one of those branches and lands in the catch-all "normal stream end" path — visibly wrong (no display-name preservation through a transition), but not loud enough to catch in a code review.

## Decision

Introduce a single service, [`StreamNotifier`](../../../server/services/StreamNotifier.js), as the sole emit chokepoint for `stream-ended`. Constructor takes `io`. One method: `streamEnded({ reason, excludeSocket, ...extras })`.

- **Exactly one `io.emit('stream-ended', payload)`** call lives inside the notifier. Every callsite the PR converts becomes `streamNotifier.streamEnded({ reason: '…', … })`.
- **`excludeSocket` preserves the takeover semantic.** `StreamHandler.js`'s takeover path used `socket.broadcast.emit(…)` to EXCLUDE the new streamer's own socket from the broadcast (so the new streamer's UI doesn't process its own stream as ended). The notifier honors that with an opt-in `excludeSocket` field; everyone else gets `io.emit`.
- **Reason-string surface is pinned** in a static `REASONS` set. Tests assert the 16-emit-site baseline (expanded to 19 reason strings — the dynamic `url_stream_${inner}` template fans out to 4 inner reasons, and `WebRTCViewBotRotation` gets a newly-assigned `webrtc_viewbot_stopped` reason since it previously emitted with no reason at all). At runtime, an unknown reason still emits (so a typo doesn't silently swallow the event) but logs a structured warning so monitoring can catch surface drift.
- **Missing reason suppresses the emit.** Calling `streamEnded()` with no `reason` is a no-op + warn. A malformed payload reaching the client is worse than no payload — the client's reason-discrimination branches all fall through to the "normal stream end" path on absent reason, which is visibly wrong on rotation/transition flows.

### Wiring

- Added to the bootstrap factory ([`server/bootstrap/services.js`](../../../server/bootstrap/services.js)) as the first io-dependent service, alongside `streamService` and `sessionService` — no other deps, so ordering is trivial.
- Threaded into the two extracted socket handlers (`StreamHandler`, `ViewBotHandler`) via their existing `deps` bag.
- Threaded into the 7 inline emit sites in `server/index.js` via module-scope destructure (alongside the other services).
- For the 5 services that historically read `io` via setter or `global.io` (`ViewBotURLService`, `RandomStreamRotationService`, `LiveKitService`, `ViewBotRotationService`) — added a parallel `setStreamNotifier(notifier)` setter. The pre-existing `setSocketIO(io)` setters are kept (they're also used for non-`stream-ended` emits in some of these services).
- `WebRTCViewBotRotation` accepts the notifier as a 3rd constructor arg; `UnifiedViewBotRotation` (the sole caller) threads it through.
- `LiveKitService` is constructed inside `WebRTCAdapter.js` before the bootstrap factory runs. The notifier is wired post-construction in `server/index.js` immediately after services are built.

### What this PR does NOT do

- No `streamGeneration` counter on `stream-ended` payloads. PR 2.5's counter applies to `stream-status` only; the `stream-ended` payload has never carried one. Adding it (and the matching client-side drop-by-counter on the `useStreamState` `stream-ended` listener) is a deliberate follow-up and would have doubled this PR's scope.
- No client-side change. The receivers still pattern-match on `reason` the same way; this PR exists to make the emit-side invariants enforceable.
- No `Map<reason, handler>` dispatcher inside the notifier. Receivers do switch on a handful of reason values, but the dispatch is on the *consumer* side, not the producer side — the notifier doesn't need to know which reasons cause display-name preservation vs. clear-state behavior. Adding one would be ceremony.

## Consequences

**Positive.**
- **Future emit-side invariants (counter, version field, structured trace ID, alerting on rare reasons) become a one-file change.** The architectural intent of Phase 3 is realized for this event; PR 3.2 / 3.3 will follow the same pattern for `viewer-count-update` and the buff/inventory cluster.
- **Typo'd reasons surface as warnings instead of silent client falls-through.** The `REASONS` test asserts that the Phase 3 baseline is intact; any future emit-site refactor that drops a reason fails the suite.
- **`global.io` access is removed from `ViewBotRotationService`.** That was the ugliest of the 16 sites — the rotation service had no DI and reached into the process global for a single emit. The notifier dependency is now explicit.
- **The `WebRTCViewBotRotation` no-reason emit now has a reason** (`webrtc_viewbot_stopped`). Previously it would land in the client's catch-all "normal stream end" branch and clear the display name even mid-rotation; now it's tagged and a future client-side discrimination becomes possible without re-touching the emit site.

**Negative / costs.**
- **One indirection layer.** Reading `streamNotifier.streamEnded(...)` vs. a literal `io.emit('stream-ended', ...)` requires a hop to the notifier source. The tradeoff is that future changes happen in one place, not 16.
- **Test fixtures must mock `StreamNotifier`** when the system-under-test indirectly emits `stream-ended`. The bootstrap mock pattern is established; new tests follow it.
- **The `setStreamNotifier` setters on the four post-construction services are a stop-gap.** A future PR can collapse them into proper constructor args once the rest of those services' DI is cleaned up; the setter is preserved here to keep this PR scoped to the chokepoint.

**Live-exposure note.** Behavior on the wire is byte-equivalent in the LiveKit branch and in `server/index.js`'s inline emits: the same `'stream-ended'` event with the same payload shape goes out, just through one funnel instead of 17. The `excludeSocket` branch preserves the `socket.broadcast.emit` semantic for the takeover path bit-for-bit. The single payload *addition* is the WebRTCViewBotRotation site — it previously emitted *without* a `reason` field, and the PR adds `reason: 'webrtc_viewbot_stopped'`. Old clients that ignore `reason` see no change; the client-side discriminator at `useStreamState.ts:318` previously fell into the catch-all "normal stream end" branch for that emit and still does (the new reason isn't in any of the `takeover` / `random_rotation_*` / `url_stream_*` / `webrtc_disconnect` matchers), so the visible UI effect is unchanged.

**MediaSoup-branch suppression (post-review fix).** During code review the reviewer flagged a subtle behaviour change in an earlier draft: the original MediaSoup branch in `server/index.js` (pre-PR) did NOT call `viewBotURLService.setSocketIO(io)` — only the LiveKit branch did. With `this.io` undefined, the two URL-stream emits at `ViewBotURLService.js:1236, 1448` were suppressed by the `if (this.io)` guard in MediaSoup-mode production. An earlier draft of this PR called `setStreamNotifier(streamNotifier)` on the MediaSoup branch, which would have silently activated those two previously-dormant emits. The fix is to deliberately omit the setter on the MediaSoup branch (commented inline at `server/index.js:5227`); the new `if (this.streamNotifier)` guard mirrors the original `if (this.io)` suppression. Wire behaviour is preserved.

## Follow-ups (NOT in this PR)

1. **PR 3.2** — same pattern for `viewer-count-update` (13 sites).
2. **PR 3.3** — same pattern for the buff/inventory cluster (`streamer-buffs-update` 9 sites, `inventory-updated` 9 sites, `buff-error` 10 sites — the buff and inventory ones live partly in `BuffDebuffService` and partly in inline route handlers at `server/routes/items.js` and `server/routes/buffs.js`, and that mix is the structural issue).
3. **Counter on `stream-ended`** — once `stream-ended` is chokepointed, threading `streamService.streamGeneration` into the payload is a one-line addition inside `StreamNotifier.streamEnded()`. Pair with client-side drop-by-counter on the matching `useStreamState.ts:318` listener.
4. **Collapse `setStreamNotifier` setters into constructor args** for the four services that still use the post-construction pattern. Once the surrounding orchestration in `server/index.js` is moved into the bootstrap factory (Phase 4 work), the construction order can be reorganized so the notifier is available at ctor time.
