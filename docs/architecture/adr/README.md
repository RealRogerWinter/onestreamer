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
