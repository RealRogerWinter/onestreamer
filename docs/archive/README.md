# Documentation archive

These files were originally `.md` files at the repository root — fix logs, "FINAL" implementation notes, planning documents, and scratch investigations. They are preserved here for **historical context only**.

> **Convention:** files in this tree are **not maintained**. Do not link to them from current docs. Do not "fix" them. If the topic is still relevant, the current state lives in `/docs/<topic>/...` — every archived file has a redirect line at the top pointing there.

## Why preserve them?

Many of these capture decisions, attempts, and rollbacks that happened during rapid iteration. Git history alone preserves them but makes them hard to grep. Archived, they retain forensic value while no longer cluttering the repo root or implying current accuracy.

## Subdirectories

| Path | What's here | Current state lives in |
|------|-------------|------------------------|
| [`livekit/`](livekit/) | Sept-2025 dual-stack attempt + same-day rollback. | [ADR-0003](../architecture/adr/0003-livekit-dual-stack-rollback.md) |
| [`transcription/`](transcription/) | Six "FINAL" variants from Oct 6, 2025 covering the LiveKit-based transcription path. | [`features/transcription.md`](../features/transcription.md) |
| [`viewbot-fixes/`](viewbot-fixes/) | Multiple iterations of viewbot buff and cleanup fixes. | [`features/items-and-buffs.md`](../features/items-and-buffs.md) + [`architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md) |
| [`av-sync/`](av-sync/) | "IMPLEMENTATION_COMPLETE" notes that admit the issue persists. | [`architecture/streaming-stack.md`](../architecture/streaming-stack.md) |
| [`audio/`](audio/) | Audio fix logs subsumed by the streaming feature doc. | [`features/streaming-and-takeover.md`](../features/streaming-and-takeover.md) |
| [`points/`](points/) | Pre- and post-refactor notes. The refactor was executed. | [`features/points-and-economy.md`](../features/points-and-economy.md) |
| [`soundboards/`](soundboards/) | 101soundboards deployment + fix notes. | [`integrations/101soundboards.md`](../integrations/101soundboards.md) |
| [`plans/`](plans/) | Large planning documents (CLIPS_SYSTEM, STREAM_RELIABILITY, MEDIASOUP_ALTERNATIVES, STREAMER_CPU_OPTIMIZATION). | Execution status in `_verification-notes.md` and the relevant `features/` doc. |
| [`browser/`](browser/) | Browser-specific fix notes (Safari emoji rendering). | Folded into [`features/chat-and-moderation.md`](../features/chat-and-moderation.md). |
| [`optimization/`](optimization/) | Socket connection optimization summary. | Folded into [`architecture/realtime-events.md`](../architecture/realtime-events.md). |
| [`rollbacks/`](rollbacks/) | Notes from feature rollbacks. | Relevant ADRs in [`architecture/adr/`](../architecture/adr/). |
| [`investigations/`](investigations/) | Hypothesis-stage investigation notes. | (none — speculative) |
| [`test-notes/`](test-notes/) | Manual test procedures, scratch notes. | (none — superseded by automated tests) |
