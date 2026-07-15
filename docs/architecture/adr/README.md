# Architecture Decision Records

ADRs are short, append-only documents that capture **why** a non-trivial architectural decision was made. They are how this project keeps the "why" alive after the people who were in the meeting have moved on.

## When to write one

- A non-trivial design decision (choose-between-libraries, choose-between-approaches, accept-a-known-tradeoff).
- A decision that future-you will second-guess if it is not written down.
- A decision that **reverses or supersedes** a prior ADR. In that case, write a new ADR that supersedes the old one — **never edit the old one**.

## When NOT to write one

- Implementation details (`"we used a Map instead of an Object"`).
- Bug fixes — those become runbook entries if the symptom recurs.
- Style or convention choices — those go in [`../../contributing/coding-conventions.md`](../../contributing/coding-conventions.md).

## Template

Copy this when creating a new ADR. Number it `NNNN-kebab-title.md` (zero-padded, four digits).

~~~markdown
# ADR-NNNN: <Title>

_Status: proposed | accepted | superseded by ADR-XXXX | deprecated_
_Date: YYYY-MM-DD_

## Context
What forced this decision? What constraints, deadlines, or stakeholder asks shaped it?

## Decision
The choice we made. One paragraph.

## Consequences
What this enables, what it costs, what becomes harder. Be honest.

## Alternatives considered
What else we looked at and why we did not pick it.
~~~

## Register

| # | Title | Status |
|---|-------|--------|
| 0001 | [Record architecture decisions](0001-record-architecture-decisions.md) | accepted |
| 0002 | [MediaSoup is primary, LiveKit is dormant](0002-mediasoup-primary-livekit-dormant.md) | superseded by 0008 |
| 0003 | [LiveKit dual-stack rollback (Sept 2025)](0003-livekit-dual-stack-rollback.md) | accepted |
| 0004 | [Chat as a separate microservice](0004-chat-service-as-separate-microservice.md) | accepted |
| 0005 | [Backblaze B2 over direct AWS S3](0005-b2-over-direct-s3.md) | accepted |
| 0006 | [whisper.cpp over cloud STT](0006-whisper-cpp-over-cloud-stt.md) | accepted |
| 0007 | [Staged removal of dormant LiveKit infrastructure](0007-livekit-cleanup-staging.md) | superseded by 0008 |
| 0008 | [Revive LiveKit for URL streams, recording, and transcription](0008-revive-livekit-for-url-streams-and-recording.md) | accepted |
| 0009 | [Single `stream-ended` emission chokepoint (`StreamNotifier`)](0009-stream-notifier-chokepoint.md) | accepted |
| 0010 | [URL-relay whitelist mode for family-friendly content](0010-url-relay-whitelist-mode.md) | accepted |
| 0011 | [LifecycleManager for deferred one-shot work](0011-lifecycle-manager.md) | accepted |
| 0012 | [Partial decomposition of `startServer()`](0012-startserver-decomposition-partial.md) | accepted |
| 0013 | [AI moderation pipeline for streamer audio](0013-ai-moderation-pipeline.md) | accepted |
| 0013a | [Atomic SQL for mutable per-row counters](0013a-atomic-sql-for-mutable-counters.md) | accepted |
| 0014 | [better-sqlite3 adapter behind an env flag](0014-better-sqlite3-adapter.md) | accepted |
| 0015 | [Transaction shape for multi-statement DB operations](0015-transaction-shape-for-multi-statement.md) | accepted |
| 0016 | [Tick-loop watchdog pattern (observability only)](0016-tick-loop-watchdog-observability-only.md) | accepted |
| 0017 | [MediaSoup/LiveKit branch alignment plan](0017-mediasoup-livekit-alignment-plan.md) | superseded by 0024 |
| 0018 | [VisionBot — multi-modal screenshot commentary](0018-visionbot-screenshot-comments.md) | accepted |
| 0019 | [ViewBotClientService decomposition outcome](0019-viewbot-instance-extraction.md) | accepted |
| 0020 | [Namespaced logging with pino](0020-namespaced-logging-with-pino.md) | accepted |
| 0021 | [Omni image moderation pipeline](0021-omni-image-moderation.md) | accepted |
| 0022 | [Schema migrations layout (light-weight, no framework)](0022-schema-migrations-layout.md) | accepted |
| 0024 | [Retire MediaSoup; LiveKit is the sole WebRTC backend](0024-retire-mediasoup-livekit-only.md) | accepted |
| 0025 | [Docker containers replace PM2 for the Node app](0025-docker-replaces-pm2.md) | accepted |
| 0026 | [CircleCI build → test → approval → deploy pipeline](0026-circleci-pipeline.md) | accepted |
| 0027 | [Discord live announcements](0027-discord-live-announcements.md) | accepted |
| 0028 | [Per-run recording sessions with a terminal upload state](0028-per-run-recording-sessions.md) | accepted |
| 0029 | [Transaction gate + economy tx plumbing](0029-transaction-gate-and-economy-tx-plumbing.md) | accepted |
| 0030 | [database.js (schema.js) is the sole boot DDL source](0030-single-source-schema-ddl.md) | accepted |

### Note on the 0013a slug

ADR-0013 was double-allocated: the AI moderation pipeline and the atomic-SQL
ADR both shipped on main with the same number from parallel branches. The
collision was resolved in PR 7.1 (Phase 7) by renaming the atomic-SQL ADR
to `0013a-atomic-sql-for-mutable-counters.md` — the bare `0013` slug stays
with the more-referenced AI moderation ADR. Future ADRs continue sequentially
from 0015.
