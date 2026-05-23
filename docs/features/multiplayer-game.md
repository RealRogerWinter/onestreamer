# Multiplayer game

_Last verified: 2026-05-23 against commit 4a1d325._

A 2D multiplayer game overlay that runs *in addition to* the live stream. Viewers can join the game world, move around with WASD/arrows, pick up items, fight spawning enemies, and respawn after dying — all while watching the stream play behind the game canvas.

## What it looks like

- A semi-transparent canvas overlay sits on top of (or alongside, depending on layout) the stream video
- Game state (player positions, enemies, items, world bounds) renders client-side at 60 fps via `requestAnimationFrame`
- Each connected player sees the same game world synchronized in real time
- HUD shows player health, count of online players, inventory

## Activation

The game is **admin-toggleable**. When off, the game overlay is invisible and consumes no resources. When on:

- Stream state includes `isGameMode: true` (broadcast via `stream-status`)
- The overlay becomes visible for all viewers
- Players who want to participate can join (movement requires opt-in; watching from the sidelines is also fine)

```bash
# Admin starts the game globally
# (via the admin panel Game Control tab, or directly via socket)
socket.emit('admin:start-game')

# Admin stops the game
socket.emit('admin:stop-game')

# Check current state
socket.emit('admin:game-status')
```

## Game features

### Players

- WASD or arrow-key movement
- Health bar; takes damage from enemies and traps
- Respawn after death (configurable delay)
- Inventory (separate from the platform-wide item inventory)

### Enemies

- Spawn periodically into the world
- Simple AI (chase nearby players)
- Killable by players (specifics depend on the in-game item set)

### Items

- Spawn on the map at intervals
- Pick up by walking over
- Use with key bindings (in-game inventory, not the platform shop)

### World

- Tile-based map with buildings, spawn points, world bounds
- Camera follows the player
- Map and tileset are configured server-side and broadcast to all clients

## Why it exists

It's an engagement layer that doesn't interfere with the streaming experience. Viewers can choose to interact (play the game) or stay passive (watch the stream). It's also a self-contained subsystem — totally separable from streaming, chat, items, points, etc. — which made it a clean place to experiment.

The game is not part of the points/items economy (you don't earn streaming points by killing enemies, and the in-game inventory is per-session). It's intentionally a sandbox.

## Architecture

Self-contained subsystem under [`server/services/game/`](../../server/services/) plus client components under [`client/src/components/game/`](../../client/src/components/).

```
server/services/game/
├── GameService.js           main orchestrator
├── GameLoopManager.js       tick loop
├── PlayerManager.js         player state, movement
├── EnemyManager.js          enemy spawning, AI
├── WorldManager.js          map, tiles, spawn points
├── CollisionManager.js      collision detection
├── GameBroadcaster.js       socket broadcasts per tick
├── GameStreamService.js     stream game video to viewers
└── index.js                 exports
```

The server runs the authoritative game state on a tick loop, broadcasts deltas to all connected players via Socket.IO. Client renders predictively (with reconciliation when server state arrives).

## Socket events

### Client → server

| Event | Purpose |
|-------|---------|
| `game:join` | Join the game world |
| `game:leave` | Leave the world |
| `game:input` | Movement input (direction + sequence number) |
| `game:interact` | Interact with a target |
| `game:use-item` | Use an in-game inventory item |
| `admin:start-game` | Admin: start the game globally |
| `admin:stop-game` | Admin: stop the game |
| `admin:game-status` | Admin: query state |

### Server → client

| Event | Purpose |
|-------|---------|
| `game:started` | Game mode activated |
| `game:ended` | Game mode deactivated |
| `game:joined` | Per-user: you've joined |
| `game:full-state` | Full state snapshot (sent on join) |
| `game:state-update` | Per-tick deltas |
| `game:player-joined` / `game:player-left` | New / departing player |
| `game:player-state` | Reconciliation snapshot |
| `game:player-damaged` / `game:player-respawned` | Combat events |
| `game:item-spawned` / `game:item-pickup` / `game:item-removed` | Item events |
| `game:enemy-spawned` / `game:enemy-killed` | Enemy events |
| `game:error` | Per-user error |

## Client components

| Component | Purpose |
|-----------|---------|
| [`GameOverlay.tsx`](../../client/src/components/game/) | Container — invisible until `isActive` |
| [`GameCanvas.tsx`](../../client/src/components/game/) | Canvas2D renderer |
| [`GameControls.tsx`](../../client/src/components/game/) | Keyboard input handling |
| [`GameHUD.tsx`](../../client/src/components/game/) | Health bar, player count, inventory |
| [`GameControlPanel.tsx`](../../client/src/components/game/) | Admin start/stop UI |

State management via [`useGameState`](../../client/src/components/game/) hook.

## Performance

- Server tick rate is moderate (not 60 Hz — likely 10–20 Hz; deltas drive client interpolation)
- Client renders at 60 fps via `requestAnimationFrame`
- Each connected player adds linear cost on the server (state size + broadcast bandwidth scales with player count)
- Realistic concurrent-player ceiling on a single host: tens, not hundreds

## Operational notes

- **Game state is in-memory only.** A server restart resets the world; no game-state persistence today.
- **Game admin tab in the admin panel** ([`/docs/features/admin-panel.md`](admin-panel.md)) provides global controls.
- **Game is independent of streaming.** You can start the game with no active stream (it'll just be the canvas overlay over a black/test-pattern background).
- **No coupling to the points economy.** Earning streaming points still works while game mode is on, but the game doesn't award or consume points.

## Troubleshooting

| Symptom | First check |
|---------|-------------|
| Game starts but no one can join | Check `pm2 logs onestreamer-server | grep -i game` for `GameService` errors |
| Player teleports / jitters | Network latency or socket buffer issue — check `game:state-update` event frequency |
| All players see different states | Reconciliation bug; force-rejoin via `game:leave` + `game:join` |
| Server CPU spikes when game runs | Too many players for the tick loop — reduce tick rate or cap concurrent players |
| Game won't stop | Verify `admin:stop-game` is reaching the server (check pm2 logs) |

## Code paths

| Concern | File |
|---------|------|
| Game orchestrator | [`server/services/game/GameService.js`](../../server/services/game/) |
| Player state | [`server/services/game/PlayerManager.js`](../../server/services/game/) |
| Game broadcasts | [`server/services/game/GameBroadcaster.js`](../../server/services/game/) |
| Client canvas | [`client/src/components/game/GameCanvas.tsx`](../../client/src/components/game/) |

## See also

- [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) — the `game:*` socket events in the full event catalog
- [`admin-panel.md`](admin-panel.md) — Game Control tab
- [`streaming-and-takeover.md`](streaming-and-takeover.md) — the streaming experience that runs alongside the game
