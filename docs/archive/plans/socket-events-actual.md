> [!NOTE]
> **COMPLETED / SUPERSEDED — historical.** Moved to the archive on 2026-06-01. This was a point-in-time *mechanical* socket-surface snapshot taken "at the start of Phase 0" to drive the Phase 3 state-unification refactor. That refactor has since landed (the `stream-ended`/`stream-status` fan-out was collapsed into the `StreamNotifier` chokepoint — see [ADR-0009](../../architecture/adr/0009-stream-notifier-chokepoint.md)), and most files/line-numbers cited below (`ViewBotHandler.js`, `MediaSoupHandler.js`, `ViewBotClientService.js`, `ViewBotSocketClient.js`, `SimpleViewBotSocket.js`, `WebRTCViewBotRotation.js`, `ViewBotRotationService.js`, the high `server/index.js` line numbers) no longer exist after the MediaSoup retirement ([ADR-0024](../../architecture/adr/0024-retire-mediasoup-livekit-only.md)) and the `index.js` decomposition. For the current event surface use [`/docs/architecture/realtime-events.md`](../../architecture/realtime-events.md) and [`/docs/api/socket-events.md`](../../api/socket-events.md); the refresh commands at the bottom still regenerate counts against the live tree.

# Socket events: mechanical surface

_Last verified: 2026-05-26 against `main` at the start of Phase 0._

Companion to [`/docs/architecture/realtime-events.md`](realtime-events.md). That page is the **feature-grouped catalog** (what each event is for, when to use it); this page is the **mechanical site-level surface** (which file:line emits or listens to what, where state is fragmented across multiple emitters).

The point of the page is to make Phase 3 (state unification + typed socket facade) mechanical. When `stream-ended` is emitted from 16 different sites, "unify the source of truth" needs a precise hit-list — that's what's below.

Server-side only. Client-side socket usage lives in `client/src/services/SocketManager.ts` and the four hooks (`useStreamState`, `useChatSocket`, `useVisualFxProcessor`, App.tsx); a follow-up artifact can mirror this for the client when Phase 3 lands.

## Counts (server-side)

| | Count |
|---|---|
| Unique emitted event names | 125 |
| Total `socket.on(...)` listener registrations | 99 |
| Total `socket.off(...)` cleanup calls | 22 |
| Files that ever call `socket.off` | **3** (`ViewBotSocketClient.js`, `ViewBotClientService.js`, `SimpleViewBotSocket.js`) |

The cleanup-call asymmetry is real and is one of the underlying drivers for the App.tsx listener-leak finding on the client side. On the server, listeners attached inside `io.on('connection', ...)` are GC'd when the socket disconnects — but re-init paths and the per-stream ViewBot lifecycle compound listeners on long-lived sockets if not cleared.

## Phase 3 hotspots: events emitted from many sites

The fragmentation here is the structural issue Phase 3 is named to fix. Each event below has a single conceptual meaning but multiple, independently maintained emit sites — exactly the shape that produces cross-channel ordering bugs.

### `stream-ended` (16 emit sites across 9 files)

```
server/sockets/ViewBotHandler.js:385         io.emit  reason: 'stop_stream_request'
server/sockets/StreamHandler.js:792          io.emit  reason: 'user_stopped_streaming'
server/index.js:2006                         io.emit  reason: 'viewbot_stopped'
server/index.js:2043                         io.emit  reason: 'viewbot_legacy_stopped'
server/index.js:2070                         io.emit  reason: 'test_stream_stopped'
server/index.js:2778                         io.emit  reason: 'admin_clear'
server/index.js:3144                         io.emit  reason: 'admin_disconnect'
server/index.js:3215                         io.emit  reason: 'streamer_banned'
server/index.js:5102                         io.emit  reason: 'streamer_disconnected'
server/services/RandomStreamRotationService.js:873   this.io.emit
server/services/RandomStreamRotationService.js:962   this.io.emit
server/services/WebRTCViewBotRotation.js:206         this.io.emit
server/services/ViewBotURLService.js:1236            this.io.emit
server/services/ViewBotURLService.js:1448            this.io.emit
server/services/LiveKitService.js:653                io.emit
server/services/ViewBotRotationService.js:286        global.io.emit
```

This is the canonical example: nine different files independently decide "the stream is over" and emit. The payload's `reason` field varies. A `StreamNotifier` service (PR 4.5 in the plan) collapses these into a single `streamNotifier.streamEnded({ reason })` callsite + one emit.

### `stream-status` (5 emit sites)

```
server/sockets/StreamHandler.js:104              socket.emit  (initial state to one socket)
server/sockets/StreamHandler.js:518              io.emit      (broadcast on transition)
server/sockets/StreamHandler.js:628              socket.emit  (per-socket re-broadcast)
server/services/game/GameStreamService.js:52     this.io.emit
server/services/game/GameStreamService.js:93     this.io.emit
```

Multiple emitters with no monotonic counter — the foundation of the client-side `takeoverTargetRef` 10-second lock band-aid (see refactor plan Phase 2.7). Phase 3 adds a `streamGeneration` counter so the client can drop stale updates.

### `viewer-count-update` (13 sites), `buff-error` (10), `streamer-buffs-update` (9), `inventory-updated` (9)

Similar fragmentation profile to `stream-ended`. The buff/inventory ones in particular have emit sites in both `BuffDebuffService` and inline route handlers (`server/routes/items.js`, `server/routes/buffs.js`). Phase 3 candidate for `BuffService.update()` → single emit chokepoint.

## Listener concentration (server-side)

Where listeners are registered:

| File | `socket.on(...)` registrations |
|------|-------------------------------|
| `services/ViewBotClientService.js` | 14 |
| `sockets/ViewBotHandler.js` | 12 |
| `sockets/MediaSoupHandler.js` | 8 |
| `sockets/GameHandler.js` | 8 |
| `services/ViewBotSocketClient.js` | 8 |
| `services/SimpleViewBotSocket.js` | 7 |
| `services/ChatBotService.js` | 7 |
| `sockets/StreamHandler.js` | 6 |
| `server/index.js` | 6 |
| `sockets/EffectHandler.js` | 4 |

The `sockets/` directory holds the extracted handlers (PR-H series); `services/` holds older inline registrations. Phase 4 (decompose `server/index.js`) sweeps the remaining 6 inline listeners in `index.js` into the appropriate `sockets/` handler file.

## Refresh

```bash
# Counts
grep -rn "socket\.on(['\"]" server/ --include='*.js' | grep -v node_modules | wc -l
grep -rEho "(io|socket)\.emit\(['\"]([^'\"]+)['\"]" server/ --include='*.js' | sed -E "s/.*emit\(['\"]([^'\"]+)['\"].*/\1/" | sort -u | wc -l

# Most-fragmented emitted events
grep -rEho "(io|socket)\.(emit|to\([^)]+\)\.emit)\(['\"]([^'\"]+)['\"]" server/ --include='*.js' \
  | sed -E "s/.*emit\(['\"]([^'\"]+)['\"].*/\1/" | sort | uniq -c | sort -rn | head -20

# All emit sites for a specific event
grep -rn -E "(io|socket)\.(emit|to\([^)]+\)\.emit)\(['\"]stream-ended['\"]" server/ --include='*.js'
```

When this file drifts, it drifts toward "more emit sites per event" — that's a Phase 3 signal.
