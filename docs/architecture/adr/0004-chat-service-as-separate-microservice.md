# ADR-0004: Chat as a separate microservice

_Status: accepted_
_Date: 2026-05-23_

## Context

OneStreamer chat is a high-traffic, always-on subsystem. Every connected user keeps a chat socket open; messages flow constantly; the chat-service also hosts voting (skip / swap / extend / lock / unlock) and the random-claim-code reward system. Voting state is in-memory and unique to chat-service.

Putting chat inside the main server has the appeal of simplicity (one process, one set of dependencies, no inter-service plumbing). It also has drawbacks: a chat-related crash takes streaming down with it; restarting the main server to deploy a chat fix interrupts every active stream; chat memory usage competes with MediaSoup workers.

## Decision

**Chat runs as its own Node process on port 8444**, with its own Socket.IO instance, its own JWT validation (sharing `JWT_SECRET` with the main server), and its own persistence model (in-memory message buffer + `moderation_data.json` on disk). The main server (port 8443) handles everything else.

Cross-service operations happen via HTTP callbacks: chat-service POSTs to the main server's `/api/internal/*` endpoints to award points, trigger rotations, fire TTS, etc.

## Consequences

**Positive.**
- **Chat restart doesn't drop streams.** The most important property — chat can be deployed independently.
- **Per-process resource caps.** PM2 enforces 1 GB on chat, 2 GB on the main server — runaway chat memory can't starve MediaSoup.
- **Independent scaling option.** Today neither service is horizontally scaled, but if scale ever becomes a constraint, chat is the cheapest service to replicate first.
- **Cleaner code boundaries.** Chat-service is one file (~4,700 lines) with a focused responsibility; the main server doesn't have to know how vote tallies work.

**Negative.**
- **Two processes to operate.** PM2 manages both, but operators need to remember to check both `pm2 logs`.
- **Shared JWT secret.** Both services must use the same `JWT_SECRET`. Rotation must be coordinated.
- **Cross-service HTTP latency.** A chat vote winning a stream skip requires an HTTP round-trip from chat-service → main server. Acceptable for the use case (votes are not latency-critical) but adds a failure mode (main server unreachable from chat-service).
- **Duplicate dependencies.** Both processes pull in `socket.io`, `jsonwebtoken`, `express`, etc. Disk + RAM cost is small but real.
- **Moderation state is in-memory + JSON file.** No DB persistence for chat messages; a chat-service restart loses the last hour of messages. Acceptable today (recordings preserve chat alongside stream timeline via [`SessionChatCaptureService`](../../../server/services/SessionChatCaptureService.js)) but worth knowing.

## Alternatives considered

- **Monolithic — chat inside the main server.** Rejected: a chat crash would drop every active stream.
- **Worker thread / cluster of the main process.** Considered but added complexity (shared MediaSoup state coordination) without the deployment-isolation benefit.
- **External chat platform (Matrix, Rocket.Chat, Discord webhook).** Rejected: too much loss of control over the voting / claim-code / animal-username experience that's core to OneStreamer's identity.

## References

- [`/docs/features/chat-and-moderation.md`](../../features/chat-and-moderation.md)
- [`/docs/features/voting-and-claims.md`](../../features/voting-and-claims.md)
- [`/docs/architecture/realtime-events.md`](../realtime-events.md) — the chat-socket events
- [`chat-service/index.js`](../../../chat-service/index.js)
