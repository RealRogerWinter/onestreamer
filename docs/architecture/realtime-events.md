# Real-time events

_Last verified: 2026-06-01 against `main` (post-ADR-0024 cleanup)._

> [!NOTE]
> **WebRTC media and its signaling now run entirely inside LiveKit** ([ADR-0024](adr/0024-retire-mediasoup-livekit-only.md)). There is no application-level WebRTC handshake on the OneStreamer socket anymore — the old `mediasoup:*` events and the `stream-offer`/`stream-answer`/`ice-candidate` SDP exchange are gone, because the LiveKit client SDK negotiates ICE/SDP over its own connection. The socket carries application signaling (who's streaming, takeover, items, effects), not transport negotiation.

OneStreamer uses Socket.IO heavily across two services (main server `:8443` and chat-service `:8444`). This page is the **catalog** of every event with direction, purpose, and where it's wired. For wire-format payload details, follow the file links into the code.

The companion reference [`/docs/api/socket-events.md`](../api/socket-events.md) presents the same data as flat reference tables; this page groups events by feature for understanding.

## Two sockets per browser

Every connected browser opens **two** Socket.IO connections:

| Socket | URL | Authentication | What it carries |
|--------|-----|----------------|-----------------|
| **Main** | `wss://.../socket.io/` (`:8443` behind nginx) | JWT in handshake auth | Streaming signaling, items, points, buffs, effects, game, admin |
| **Chat** | `wss://.../chat/socket.io/` (`:8444` behind nginx) | Same JWT (shared `JWT_SECRET`) | Chat messages, votes, claims, moderation events |

They are completely independent processes; an event sent on one is not received on the other. Cross-cutting actions (a vote winning a stream skip; a chat ban affecting socket connections) happen via HTTP callbacks between the services.

Client wiring: [`client/src/services/SocketManager.ts`](../../client/src/services/SocketManager.ts) and [`SocketContext.tsx`](../../client/src/contexts/SocketContext.tsx).

---

## Main server events (port 8443)

### Connection + auth

| Event | Direction | Purpose |
|-------|-----------|---------|
| `connect` | server → client | Built-in; socket connected successfully |
| `connect_error` | server → client | Built-in; connection failed (often `xhr poll error` for transport mismatch) |
| `disconnect` | server → client | Built-in; socket disconnected (reason in payload) |
| `identify` | client → server | Optional client identification ping |
| `banned` | server → client | User is IP-banned or account-banned; disconnects after delivery |
| `unbanned` | server → client | (admin path) |
| `admin-notification` | server → client | Arbitrary admin-pushed user notification (`{ message, type }`) |

### Streaming + takeover

| Event | Direction | Purpose |
|-------|-----------|---------|
| `join-as-viewer` | client → server | Register intent to watch; server replies with `stream-status` |
| `request-to-stream` | client → server | Ask to be the active streamer (request a takeover if one is live) |
| `request-stream` | client → server | Legacy alias of above |
| `streaming-approved` | server → client | "You may start broadcasting" |
| `streaming-approved-ack` | server → client | Server-side acknowledgment of approval |
| `stream-denied` | server → client | Request rejected (reason in payload — cooldown, banned, etc.) |
| `takeover-denied` | server → client | Takeover specifically denied (different from `stream-denied`) |
| `takeover-error` | server → client | Error during takeover handshake |
| `stop-streaming` | client → server | Streamer voluntarily stops |
| `stop-stream` | client → server | Legacy alias |
| `stream-status` | server → client | Current state: streamer, viewer count, type, rotation, game-mode |
| `stream-ready` | server → client | Stream is set up and ready for viewer consumers |
| `stream-started` | server → client | Broadcast: new stream just began |
| `stream-switching` | server → client | Switching to a new streamer (takeover in progress) |
| `stream-switched` | server → client | Switch complete |
| `stream-ended` | server → client | Broadcast: current stream ended (reason + previous/new streamer) |
| `stream-reconnected` | server → client | Stream recovered after a transient drop |
| `stream-restored` | server → client | Variant: stream restored from a saved state |
| `stream-disconnected-by-admin` | server → client | Streamer was force-disconnected; clean handoff to viewers |
| `new-streamer` | server → client | A new user took over (lightweight notification) |
| `viewer-count-update` | server → client | Live viewer count for current stream |
| `kill-switch-activated` | server → client | Emergency stop |

### WebRTC media setup

There are **no application-level WebRTC signaling events** on this socket. Media transport (ICE/SDP/DTLS) is negotiated by the LiveKit client SDK ([`LiveKitClient.ts`](../../client/src/services/LiveKitClient.ts)) directly against the LiveKit server over its own WebSocket — see [`streaming-stack.md`](streaming-stack.md). The OneStreamer socket only carries the *application* signal that a stream is starting/ready (`stream-ready`, `stream-started`, etc. above); the client uses that as the cue to join the LiveKit room.

(The former `mediasoup:get-rtp-capabilities` / `mediasoup:create-send-transport` / `mediasoup:connect-transport` / `mediasoup:produce` / `mediasoup:consume` / `produce-verified` handshake and the `stream-offer`/`stream-answer`/`ice-candidate` SDP exchange were removed with MediaSoup in [ADR-0024](adr/0024-retire-mediasoup-livekit-only.md).)

### Chat (mirrored on main socket for some integrations)

The main server emits a few chat-adjacent events that the React client needs to react to even though the main chat traffic is on the chat-service socket.

| Event | Direction | Purpose |
|-------|-----------|---------|
| `system-message` | server → client | A system-generated chat message (e.g. "Bob took over the stream") |
| `send-message` | client → server | (Some integrations route messages here; chat-service is the primary path) |
| `join-chat` | server → client | (Confirmation after chat handshake) |

### Buffs, items, effects

| Event | Direction | Purpose |
|-------|-----------|---------|
| `buff-applied` | server → client | Broadcast: a buff was applied to the active streamer |
| `buff-applied-success` | server → client | Per-user: your buff item was applied successfully |
| `buff-error` | server → client | Per-user: error applying your buff |
| `buff-expired` | server → client | Buff timer ran out |
| `my-buffs-update` | server → client | Per-user: your active buff list refreshed |
| `user-buff-update` | server → client | Per-user: another buff change touching this user |
| `streamer-buffs-update` | server → client | Public: the streamer's active buff list |
| `item-used` | server → client | Broadcast: an item was used (for system messages / UI feedback) |
| `points-updated` | server → client | Per-user: your point balance changed (reason in payload) |
| `cooldown-status-update` | server → client | Takeover cooldown changed (a guard/weapon item moved it) |
| `global-cooldown` | server → client | The global takeover cooldown changed |
| `time-stats-update` | server → client | Per-user: stream/view/chat-message stats refreshed |

### Visual effects (VisualFX — server-side stream manipulation)

| Event | Direction | Purpose |
|-------|-----------|---------|
| `apply-visual-effect` | client → server | Trigger an effect on the active stream |
| `remove-visual-effect` | client → server | Cancel an active effect |
| `get-visual-effects` | client → server | Request the catalog of available effects + current active list |
| `get-visual-fx-stats` | client → server | Request runtime stats (active count, CPU, queue depth) |
| `visual-effect-applied` | server → client | Broadcast: effect is now active |
| `visual-effect-removed` | server → client | Broadcast: effect removed |
| `visual-effects-cleared` | server → client | Broadcast: all effects cleared (admin) |
| `visual-effects-list` | server → client | Reply to `get-visual-effects` |
| `visual-effects-state` | server → client | Full effect state snapshot |
| `visual-effect-sync` | server → client | Periodic sync of the active effect set (for late joiners) |
| `visual-effects-sync-pulse` | server → client | Heartbeat to confirm sync state |
| `request-effect-sync` | client → server | Late-joiner requests the current effect state |

### Canvas effects (CanvasFX — client-side overlays)

| Event | Direction | Purpose |
|-------|-----------|---------|
| `canvas-effect-trigger` | server → client | Broadcast: a canvas effect was triggered with config (every viewer renders independently) |
| `canvas-effect-complete` | server → client | Effect ran to completion |
| `canvas-effect-cancelled` | server → client | Effect was aborted |
| `canvas-effects-clear` | server → client | Broadcast: wipe all active overlays (admin) |
| `canvas-effects-clear-buff-synced` | server → client | Wipe overlays tied to a specific buff that ended |
| `canvas-effects-sync` | server → client | Periodic full snapshot |
| `drawing-path-start` | client → server | Begin a drawing stroke |
| `drawing-path-update` | client → server | Continue stroke (per-frame point) |
| `drawing-path-complete` | client → server | Finish stroke |
| `drawing-start-broadcast` | server → client | Mirror to all viewers |
| `drawing-path-broadcast` | server → client | Mirror to all viewers |
| `drawing-segment-broadcast` | server → client | Alternative drawing broadcast |

### Sound effects

| Event | Direction | Purpose |
|-------|-----------|---------|
| `sound-effect-play` | both | Trigger a sound on viewers' clients |
| `sound-effect-stop` | both | Stop a specific sound |
| `sound-effect-stop-all` | both | Stop everything |

### MovieBot

| Event | Direction | Purpose |
|-------|-----------|---------|
| `moviebot-enabled` | server → client | MovieBot started for the current stream |
| `moviebot-disabled` | server → client | MovieBot stopped |
| `moviebot-comment` | server → client | New MovieBot comment was posted |
| `moviebot-prompt-logged` | server → client | The prompt sent to the LLM (debug/observability) |

### Transcription

| Event | Direction | Purpose |
|-------|-----------|---------|
| `transcription-started` | server → client | New transcription session began |
| `transcription-stopped` | server → client | Session ended |
| `transcription-update` | server → client | New chunk available (text + timestamp + word count) |

### Random stream rotation

| Event | Direction | Purpose |
|-------|-----------|---------|
| `random-rotation-status` | server → client | Current rotation state |
| `random-rotation-force` | server → client | Force-rotate now |
| `rotation-locked` | server → client | Rotation locked (won't auto-advance) |
| `rotation-unlocked` | server → client | Rotation unlocked |
| `rotation-extended` | server → client | Current slot extended |
| `rotation-reduced` | server → client | Current slot reduced |
| `rotation-timing` | server → client | Time-remaining info |

### Viewbots

Viewbots now ingest via LiveKit (RTMP ingress), so the old P2P/RTP transport-setup handshake (`viewbot-create-*`, `viewbot-webrtc-produce`, `viewbot-producer-*`, `viewbot-mode-changed`) is gone. Only the approval/ready signals remain:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `viewbot-stream-approved` | server → client | Bot's stream was approved to go live (emitted alongside `streaming-approved` in [`takeover.js`](../../server/sockets/streamHandler/takeover.js)) |
| `viewbot-stream-ready` | client → server | Bot signals its stream is ready |

See [`viewbot-fleet.md`](viewbot-fleet.md) for the ingest pipeline.

### Game

| Event | Direction | Purpose |
|-------|-----------|---------|
| `game:started` | both | Game mode activated |
| `game:joined` | both | Player joined the game |
| `game:ended` | both | Game mode deactivated |
| `game:full-state` | server → client | Full game world state (sent on join) |
| `game:state-update` | server → client | Per-tick deltas |
| `game:player-joined` | server → client | New player |
| `game:player-left` | server → client | Player left |
| `game:player-state` | server → client | Player reconciliation snapshot |
| `game:player-damaged` | server → client | Player took damage |
| `game:player-respawned` | server → client | Player respawned |
| `game:item-spawned` | server → client | Item appeared on map |
| `game:item-pickup` | server → client | Item picked up |
| `game:item-removed` | server → client | Item removed |
| `game:enemy-spawned` | server → client | Enemy appeared |
| `game:enemy-killed` | server → client | Enemy died |
| `game:error` | server → client | Per-user error |
| `game:input` | client → server | Movement input |
| `game:interact` | client → server | Interact with target |
| `game:use-item` | client → server | Use inventory item in-game |
| `admin:start-game` | client → server | Admin starts game mode |
| `admin:stop-game` | client → server | Admin stops game mode |
| `admin:game-status` | client → server | Admin queries game state |

### Test stream + debug

| Event | Direction | Purpose |
|-------|-----------|---------|
| `request-test-stream` | client → server | Request a synthetic test stream |
| `test-stream-available` | server → client | Test stream is ready |
| `test-pattern-stream` | server → client | Test pattern data |
| `buffer-status` | server → client | Debug: buffer fill state |
| `test-event` | server → client | Debug ping |

---

## Chat-service events (port 8444)

### Connection + identity

| Event | Direction | Purpose |
|-------|-----------|---------|
| `connect` / `disconnect` | server → client | Built-in |
| `ping` / `pong` | both | Heartbeat / keepalive |
| `user-assigned` | server → client | Assigned username + color + userId on join |
| `user-count-update` | server → client | Live count of connected chat users |
| `update-user-color` | client → server | Authenticated user changes their avatar color |
| `color-updated` | server → client | Confirmation of color change |
| `join-chat` | client → server | Optional explicit join (handshake registers user) |

### Messages

| Event | Direction | Purpose |
|-------|-----------|---------|
| `send-message` | client → server | Submit a chat message |
| `new-message` | server → client | Broadcast: new message (regular, system, bot, vote outcome) |
| `chat-history` | server → client | Last 20 messages, sent on connect |
| `delete-messages` | server → client | Wipe specific messages (e.g. after a ban) |
| `chat-cleared` | server → client | Admin wiped the entire chat buffer |

### Moderation

| Event | Direction | Purpose |
|-------|-----------|---------|
| `banned` | server → client | User is permanently banned; disconnect imminent |
| `timeout` | server → client | User is temporarily muted; payload includes remaining seconds |

### Cross-service (chat → main)

These events the chat-service emits to chat clients reflect actions the main server actually performed via HTTP callbacks:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `stream-info-update` | server → client | Vote outcome broadcast (skip / extend / swap / lock / unlock) with source label |

---

## When events fire — a few worked examples

### Sign-in handshake

1. Browser opens main socket with JWT in `auth.token`.
2. Server validates JWT, attaches user, checks IP ban, emits `stream-status`.
3. Browser opens chat socket with same JWT.
4. Chat-service validates, assigns user (or animal name if no JWT), emits `user-assigned` and `chat-history`.
5. Chat-service emits `user-count-update` to all clients (the count went up).

### Stream takeover

1. Browser emits `request-to-stream` on main socket.
2. Server checks cooldowns; emits `streaming-approved` to requester (or `takeover-denied`).
3. If approved, server emits `stream-switching` to all viewers.
4. The requester's client connects to the **LiveKit room** ([`LiveKitClient.connect`](../../client/src/services/LiveKitClient.ts)) and publishes its camera/mic tracks — all ICE/SDP negotiation happens inside the LiveKit SDK, not on this socket.
5. Server emits `stream-ready` then `stream-started` to all viewers; their clients subscribe to the new publisher's LiveKit tracks.
6. Server emits `new-streamer` to chat-service via HTTP callback; chat-service emits `system-message` to all chat clients.

### Item use

1. Browser POSTs `/api/inventory/use/:itemId` over HTTPS (not a socket event — REST).
2. Server dispatches: buff/debuff to `BuffDebuffService`, utility to the right service.
3. Server emits `item-used` to all main-socket clients (system feedback).
4. If a visual effect: server emits `visual-effect-applied` (VisualFX) or `canvas-effect-trigger` (CanvasFX) to all.
5. If a buff: server emits `buff-applied` to all (so streamer's UI shows the buff icon).
6. Server emits `points-updated` to the using user (their balance decreased).
7. Server emits `cooldown-status-update` for guard/weapon items.

### Chat vote winning a skip

1. User types `!skip` in chat; chat-service emits `new-message` to all chat clients.
2. Chat-service counts the vote against connected user count; when threshold (75%) is met within window (2 min):
3. Chat-service POSTs `/api/random-stream/rotate` to main server.
4. Main server emits `stream-ended` then begins rotation.
5. Chat-service emits `stream-info-update` to chat clients with "skip succeeded — 80% voted yes" source label.

---

## See also

- [`/docs/api/socket-events.md`](../api/socket-events.md) — flat reference tables of all events with payload shapes
- [`overview.md`](overview.md) — system layers and trust boundaries
- [`/docs/features/streaming-and-takeover.md`](../features/streaming-and-takeover.md) — user-facing takeover flow with sequence diagram
- [`/docs/features/voting-and-claims.md`](../features/voting-and-claims.md) — chat vote mechanics
