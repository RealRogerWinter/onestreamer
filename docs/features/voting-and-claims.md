# Voting and claim codes

_Last verified: 2026-05-23 against commit 4a1d325._

The chat-service ([`chat-service/index.js`](../../chat-service/index.js), ~4,700 lines) is more than a message relay. It hosts two interactive subsystems that drive stream rotation and reward distribution: **voting** and **claim codes**. Both run inside the chat process and call back to the main server via HTTP for any side effects on streams or points.

## Voting

Viewers can collectively change what's playing — skip the current stream, swap to a different URL, extend or shrink the rotation window, lock or unlock auto-rotation. Each vote is a per-command tally against a threshold, with a window and a cooldown.

### Commands

| Command | Effect | Threshold | Window | Cooldown after |
|---------|--------|----------:|-------:|----------------|
| `!next` / `!skip` | Rotate to the next random stream | 75% of current viewers | 2 minutes | 2 min on fail; 5 min on success |
| `!swap <url>` | Swap the current stream to a specific URL | 75% | 2 minutes | (same as `!next`) |
| `!extend` | Add time to the current rotation slot | 33% | 2 minutes | (per-vote) |
| `!reduce` | Subtract time from the current rotation slot | 33% | 2 minutes | (per-vote) |
| `!lock` | Lock auto-rotation (current stream stays) | 100% | 2 minutes | — |
| `!unlock` | Allow auto-rotation to resume | 50% | 2 minutes | — |

### Single-viewer mode

If only one viewer is connected when a vote command is issued, the action executes **immediately** rather than going through the threshold check (with a 60-second cooldown to prevent spam). The lonely-streamer experience matters too.

### How it hits the main server

The chat-service holds the vote tally in memory. When a vote passes (or single-viewer mode fires), it makes an authenticated HTTP call back to the main server:

| Vote | Main-server endpoint |
|------|----------------------|
| `!next` / `!skip` | `POST /api/random-stream/rotate` |
| `!swap` | `POST /api/random-stream/swap` |
| `!extend` | `POST /api/random-stream/extend` |
| `!reduce` | `POST /api/random-stream/reduce` |
| `!lock` / `!unlock` | `POST /api/random-stream/lock` / `/unlock` |

The Bearer token is the same JWT the requesting user is authenticated with — votes are tied to real authenticated users when possible, falling back to anonymous for unauth visitors. `MAIN_SERVER_URL` (default `https://onestreamer.live:8443`) controls where these calls go.

### Result broadcast

When a vote resolves, the chat-service emits `stream-info-update` to all chat clients with the outcome and the source label (e.g. "skip succeeded — 80% voted yes"). The main server, in parallel, emits its own rotation events (`random-rotation-status`, `rotation-timing`, etc.) on the main socket.

## Claim codes

A periodic incentive system that drops random reward codes into chat. Anyone watching can grab a reward by typing `!claim <CODE>` before the code expires.

### Lifecycle

1. A random claim code is generated at a random interval between **20 and 60 minutes** after the previous one. The exact codes and their reward sizes are picked from a server-side pool.
2. The chat-service announces the code in chat as a system message.
3. Viewers have **60 seconds** to type `!claim <CODE>` to redeem.
4. The first user to claim each code wins. Some codes may allow multiple winners — see the chat-service implementation for details.
5. On a successful claim, the chat-service calls back to the main server's `POST /api/internal/award-points` to credit the user's `points_balance` and emits a system message congratulating the winner.

This serves as a low-friction engagement loop ("stay tuned, free points appear randomly") without requiring the streamer to do anything.

## Other chat-driven commands

Beyond voting and claims, the chat-service implements a handful of point-moving commands that talk to the main server:

| Command | Purpose | Main-server endpoint |
|---------|---------|----------------------|
| `!gamble <amount>` | Risk N points on a coin flip | `POST /api/internal/gamble` |
| `!slots <amount>` | Play a slot-style game | `POST /api/internal/slots` |
| `!roll` | Free dice roll (cosmetic / leaderboard) | (chat-service only) |
| `!flip` | Free coin flip | (chat-service only) |
| `!tts <message>` | Trigger text-to-speech in-stream | `POST /api/soundfx/tts` |
| `!ban`, `!unban`, `!timeout`, `!remove-timeout`, `!clear-chat` | Moderation (admin/mod only) | (chat-service only) |

Internal endpoints (`/api/internal/*`) are gated by a shared secret + the user's JWT — chat-service is treated as a trusted client.

## Persistence model

The chat-service deliberately has **no shared database** with the main server. It maintains:

- **In-memory** message buffer (last 3,000 messages, ~1 hour at moderate traffic; lost on restart).
- **In-memory** vote tallies (lost on restart — votes in flight when the service restarts are abandoned).
- **In-memory** claim-code state (lost on restart).
- **`chat-service/moderation_data.json`** on disk for bans and timeouts (the only persistent state).

This keeps the chat-service cheap to restart and means crashes here don't cascade into the main streaming pipeline. The trade-off: a chat-service restart at the wrong moment can drop an in-flight vote or close a claim window early.

## Operational notes

- **Restart-safe ops**: schedule chat-service restarts when no vote is in flight if possible. If you must restart, broadcast a system message first via `POST /api/system-message`.
- **Single-viewer thresholds** make small streams feel responsive but can be surprising in moderation contexts — if you're testing alone you'll see commands fire immediately.
- **Vote outcomes always log to stderr** (`pm2 logs onestreamer-chat`) — grep for `VOTE:` for forensics.
- **Code drops** are at random intervals 20–60 min apart; if no codes appear for an hour, check that the claim subsystem is initialized in `chat-service/index.js`.

## Code paths

| Concern | File |
|---------|------|
| All voting, claims, commands | [`chat-service/index.js`](../../chat-service/index.js) |
| Rotation endpoints | [`server/routes/random-stream.js`](../../server/routes/random-stream.js) |
| Points endpoints called back | Inside the main `server/index.js` (`/api/internal/*` routes) |
| TTS callback | [`server/routes/soundfx.js`](../../server/routes/soundfx.js) |

## See also

- [`chat-and-moderation.md`](chat-and-moderation.md) — base chat features and moderation tooling
- [`external-sources-twitch-kick.md`](external-sources-twitch-kick.md) — how rotation picks the next stream
- [`points-and-economy.md`](points-and-economy.md) — what claim/gamble winners are crediting
- [ADR-0004](../architecture/adr/0004-chat-service-as-separate-microservice.md) — why chat is its own process
