# Socket.IO event reference

_Last verified: 2026-06-01 against `main` (post-ADR-0024 cleanup)._

Flat-table reference of every Socket.IO event OneStreamer uses. For grouped-by-feature narrative and the rationale for the two-socket design, see [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md).

> [!NOTE]
> WebRTC transport negotiation is **not** on this socket — the LiveKit client SDK handles ICE/SDP over its own connection ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). The former `mediasoup:*` and `stream-offer`/`stream-answer`/`ice-candidate` events were removed with MediaSoup.

Two sockets per browser:

- **Main socket** (`:8443`, namespace `/`) — streaming, items, points, buffs, effects, game, admin
- **Chat socket** (`:8444`, namespace `/chat/socket.io/`) — messages, votes, claim codes, moderation events

Direction key: **C→S** = client emits, **S→C** = server emits.

---

## Main socket events

### Connection / auth / lifecycle

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `connect` | S→C | Built-in connect |
| `connect_error` | S→C | Built-in connect failure |
| `disconnect` | S→C | Built-in disconnect with reason |
| `identify` | C→S | Client identification ping |
| `banned` | S→C | User IP- or account-banned; disconnects after delivery |
| `unbanned` | S→C | Admin-driven unban |
| `admin-notification` | S→C | `{ message, type }` |

### Streaming + takeover

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `join-as-viewer` | C→S | Register as viewer |
| `request-to-stream` | C→S | Ask to start streaming |
| `request-stream` | C→S | Legacy alias |
| `streaming-approved` | S→C | Approval to broadcast |
| `streaming-approved-ack` | S→C | Ack of approval |
| `stream-denied` | S→C | Request denied (cooldown / banned / other) |
| `takeover-denied` | S→C | Takeover specifically denied |
| `takeover-error` | S→C | Error during takeover handshake |
| `stop-streaming` | C→S | Streamer voluntarily stops |
| `stop-stream` | C→S | Legacy alias |
| `stream-status` | S→C | Current state snapshot |
| `stream-ready` | S→C | Stream is set up; viewer consumers can subscribe |
| `stream-started` | S→C | Broadcast: stream just began |
| `stream-switching` | S→C | Takeover in progress |
| `stream-switched` | S→C | Takeover complete |
| `stream-ended` | S→C | Stream ended |
| `stream-reconnected` | S→C | Recovered after transient drop |
| `stream-restored` | S→C | Restored from saved state |
| `stream-disconnected-by-admin` | S→C | Admin force-disconnect |
| `new-streamer` | S→C | New user took over |
| `viewer-count-update` | S→C | Live viewer count |
| `kill-switch-activated` | S→C | Emergency stop |

### WebRTC media setup

No events. Media transport (ICE/SDP/DTLS) is negotiated by the LiveKit client SDK against the LiveKit server, off this socket. The client joins the LiveKit room when it receives `stream-ready` / `streaming-approved` above. See [`/docs/architecture/streaming-stack.md`](../architecture/streaming-stack.md).

### Buffs / items / points / cooldowns

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `buff-applied` | S→C | Public: buff applied to streamer |
| `buff-applied-success` | S→C | Per-user: your buff was applied |
| `buff-error` | S→C | Per-user: error |
| `buff-expired` | S→C | Buff timer expired |
| `my-buffs-update` | S→C | Per-user: your active buffs |
| `user-buff-update` | S→C | Per-user: buff change touching this user |
| `streamer-buffs-update` | S→C | Public: streamer's active buffs |
| `item-used` | S→C | Public: item was used |
| `points-updated` | S→C | Per-user: balance changed (with reason) |
| `cooldown-status-update` | S→C | Takeover cooldown changed |
| `global-cooldown` | S→C | Global cooldown changed |
| `time-stats-update` | S→C | Per-user: stream/view/chat-message stats |

### Visual effects (server-side stream manipulation)

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `apply-visual-effect` | C→S | Trigger effect |
| `remove-visual-effect` | C→S | Cancel effect |
| `get-visual-effects` | C→S | Request effect catalog + active list |
| `get-visual-fx-stats` | C→S | Request runtime stats |
| `visual-effect-applied` | S→C | Broadcast: effect active |
| `visual-effect-removed` | S→C | Broadcast: effect ended |
| `visual-effects-cleared` | S→C | All effects cleared |
| `visual-effects-list` | S→C | Reply to `get-visual-effects` |
| `visual-effects-state` | S→C | Full state snapshot |
| `visual-effect-sync` | S→C | Periodic sync (for late joiners) |
| `visual-effects-sync-pulse` | S→C | Sync heartbeat |
| `request-effect-sync` | C→S | Late-joiner state request |

### Canvas effects (client-side overlays)

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `canvas-effect-trigger` | S→C | Render effect on every viewer |
| `canvas-effect-complete` | S→C | Effect finished |
| `canvas-effect-cancelled` | S→C | Effect aborted |
| `canvas-effects-clear` | S→C | Wipe all overlays (admin) |
| `canvas-effects-clear-buff-synced` | S→C | Wipe overlays tied to a specific buff |
| `canvas-effects-sync` | S→C | Periodic full snapshot |
| `drawing-path-start` | C→S | Begin drawing stroke |
| `drawing-path-update` | C→S | Stroke segment |
| `drawing-path-complete` | C→S | Stroke complete |
| `drawing-start-broadcast` | S→C | Mirror stroke start |
| `drawing-path-broadcast` | S→C | Mirror stroke segment |
| `drawing-segment-broadcast` | S→C | Alternative drawing broadcast |

### Sound effects

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `sound-effect-play` | both | Trigger sound |
| `sound-effect-stop` | both | Stop a specific sound |
| `sound-effect-stop-all` | both | Stop everything |

### MovieBot

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `moviebot-enabled` | S→C | MovieBot started |
| `moviebot-disabled` | S→C | MovieBot stopped |
| `moviebot-comment` | S→C | New MovieBot message |
| `moviebot-prompt-logged` | S→C | Debug: prompt sent to LLM |

### Transcription

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `transcription-started` | S→C | Session began |
| `transcription-stopped` | S→C | Session ended |
| `transcription-update` | S→C | New chunk |

### Random stream rotation

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `random-rotation-status` | S→C | Current rotation state |
| `random-rotation-force` | S→C | Force-rotate now |
| `rotation-locked` | S→C | Rotation locked |
| `rotation-unlocked` | S→C | Rotation unlocked |
| `rotation-extended` | S→C | Slot extended |
| `rotation-reduced` | S→C | Slot reduced |
| `rotation-timing` | S→C | Time-remaining info |

### Viewbots

Viewbots ingest via LiveKit (RTMP ingress); the old transport-setup/producer handshake was removed with MediaSoup. See [`/docs/architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md).

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `viewbot-stream-approved` | S→C | Bot's stream approved to go live |
| `viewbot-stream-ready` | C→S | Bot signals its stream is ready |

### Game

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `game:started` | both | Game mode activated |
| `game:ended` | both | Game mode deactivated |
| `game:joined` | both | Player joined |
| `game:join` | C→S | Request to join world |
| `game:leave` | C→S | Leave world |
| `game:full-state` | S→C | Full snapshot (sent on join) |
| `game:state-update` | S→C | Per-tick deltas |
| `game:player-joined` | S→C | New player |
| `game:player-left` | S→C | Player left |
| `game:player-state` | S→C | Reconciliation snapshot |
| `game:player-damaged` | S→C | Player took damage |
| `game:player-respawned` | S→C | Player respawned |
| `game:item-spawned` | S→C | Item appeared |
| `game:item-pickup` | S→C | Item picked up |
| `game:item-removed` | S→C | Item removed |
| `game:enemy-spawned` | S→C | Enemy appeared |
| `game:enemy-killed` | S→C | Enemy died |
| `game:error` | S→C | Per-user error |
| `game:input` | C→S | Movement input |
| `game:interact` | C→S | Interact with target |
| `game:use-item` | C→S | Use in-game item |
| `admin:start-game` | C→S | Admin start |
| `admin:stop-game` | C→S | Admin stop |
| `admin:game-status` | C→S | Admin query |

### Test stream + debug

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `request-test-stream` | C→S | Request test pattern |
| `test-stream-available` | S→C | Test stream ready |
| `test-pattern-stream` | S→C | Test pattern data |
| `buffer-status` | S→C | Debug: buffer state |
| `test-event` | S→C | Debug ping |

### Chat (cross-cutting on main socket)

A few chat-adjacent events flow on the main socket because they touch streaming/system state:

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `system-message` | S→C | System-generated chat message ("Bob took over") |
| `send-message` | C→S | (Some integrations route here; chat-service socket is the primary) |
| `join-chat` | S→C | Chat join confirmation |

---

## Chat-service socket events

### Connection / identity

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `connect` / `disconnect` | S→C | Built-in |
| `ping` / `pong` | both | Heartbeat |
| `user-assigned` | S→C | `{ username, color, userId }` on join |
| `user-count-update` | S→C | Live count |
| `update-user-color` | C→S | Change avatar color |
| `color-updated` | S→C | Confirmation |
| `join-chat` | C→S | Optional explicit join |

### Messages

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `send-message` | C→S | Submit chat message |
| `new-message` | S→C | Broadcast: new message (regular, system, bot, vote outcome) |
| `chat-history` | S→C | Last 20 messages on connect |
| `delete-messages` | S→C | Wipe specific messages |
| `chat-cleared` | S→C | Admin wiped buffer |

### Moderation

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `banned` | S→C | Permanent ban; disconnect imminent |
| `timeout` | S→C | Temp mute with remaining seconds |

### Cross-service (chat → main)

| Event | Direction | Purpose |
|-------|:---------:|---------|
| `stream-info-update` | S→C | Vote outcome broadcast (skip / extend / swap / lock / unlock) |

---

## See also

- [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) — grouped narrative + when events fire
- [`rest.md`](rest.md) — HTTP endpoint reference
- [`/docs/features/`](../features/) — what each feature uses these events for
