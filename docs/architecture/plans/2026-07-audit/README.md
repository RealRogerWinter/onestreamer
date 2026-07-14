# OneStreamer codebase audit & improvement plan — 2026-07

_Deep-dive audit of the entire codebase and architecture, with per-system remediation plans. Produced 2026-07-14._

## What this is

A full-codebase audit (server, chat-service, client, DB, infra) that maps every major subsystem, finds real defects, and lays out a prioritized, phased plan to fix them. It was run as a multi-agent sweep: **15 subsystem auditors** each did an evidence-based deep read and reported findings, then **every finding was independently re-checked by an adversarial verifier** whose job was to refute it. The flagship area (continuous recording) and all critical items were additionally verified by hand against the live code and database.

**Coverage:** 119 verification agents · **93 findings CONFIRMED**, 4 plausible, **7 refuted** (ruled out by the adversarial pass — listed in the relevant plan docs so they're not re-investigated).

Every finding in these docs carries a `file:line` anchor and was confirmed by an independent read. Fix sketches are included; severity is post-verification.

## The headline: 7 critical findings

| # | Finding | Plan |
|---|---------|------|
| 1 | **Recording disk-leak deadlock** — 37 GB and growing; three cleanup/upload loops gated on a state transition (`status='completed'` / `b2_file_id`) that never happens. Disk-full = full-site outage. | [01](01-recording-and-clips-pipeline.md) |
| 2 | **Same-day recordings silently destroyed** — the second stream of a UTC day is `rm -rf`'d locally while marked "archived". | [01](01-recording-and-clips-pipeline.md) |
| 3 | **`forgot-password` returns the reset token in the HTTP response** — account takeover for any known email. | [02](02-security-and-access-control.md) |
| 4 | **`/api/livekit/token` is unauthenticated and publish-capable** — anyone can hijack/evict the stream or inject media to all viewers. | [02](02-security-and-access-control.md) |
| 5 | **`/gift-item` accepts negative quantity** — mint items for yourself, steal from any user; breaks the economy. | [04](04-database-and-economy-integrity.md) |
| 6 | **Deployed code exists only on this host** — push disabled, `main` diverged 473/487 from origin; one disk failure loses 6 weeks of source. | [03](03-data-durability-and-disaster-recovery.md) |
| 7 | **Backups are documentation-only** — script/cron never installed; newest DB backup is 3 weeks old for a 2.4 GB money database. | [03](03-data-durability-and-disaster-recovery.md) |

Findings 6 and 7 together are the highest *aggregate* risk: everything else in this audit is recoverable; a single disk event on the prod host is not.

## The plan documents

| Plan | Scope | Findings |
|------|-------|----------|
| [01 — Recording & clips pipeline](01-recording-and-clips-pipeline.md) | The flagship redesign: per-run sessions, segment-level retention decoupled from B2, ordered/multipart upload, auto-stop idle egress | 2 crit · 5 high · 5 med |
| [02 — Security & access control](02-security-and-access-control.md) | Auth, LiveKit token, stream-control auth, CORS, path traversal, SSRF, secrets-as-code | 2 crit · 3 high · 5 med · 3 low |
| [03 — Data durability & DR](03-data-durability-and-disaster-recovery.md) | Off-host backups, git-history reconciliation, secret un-tracking | 2 crit · 1 high · 1 med |
| [04 — Database & economy integrity](04-database-and-economy-integrity.md) | Transaction-mutex hole, fresh-boot schema, atomicity of money moves, input validation, schema single-source | 1 crit · 4 high · rest med/low |
| [05 — Streaming & takeover reliability](05-streaming-and-takeover-reliability.md) | Client reconnection/publish/state-machine, takeover↔rotation races, `currentStreamer` single-writer | 5 high · 6 med · 2 low |
| [06 — Chat, moderation & viewbots](06-chat-moderation-and-viewbots.md) | Ban enforcement, XFF trust, chat-API auth, CSAM evidence bug, URL-relay bot-over-human, Kick recovery | 7 high · rest med/low |
| [07 — AI, lifecycle & platform hygiene](07-ai-transcription-and-platform-hygiene.md) | LLM/whisper timeouts + load model, shutdown/startup correctness, `global.*` coupling, CI/docs/deps drift | 1 high · rest med/low |

## Cross-system roadmap

Priorities are **P0** (stop-the-bleeding / disaster or active-exploit risk — do this week), **P1** (correctness & integrity — weeks), **P2** (reliability, resilience, architecture — ongoing). The value of this ordering: P0 items are small, independently shippable, and remove the ways this system can lose data or be taken over *today*, without waiting for the larger redesigns.

### P0 — this week (small, surgical, high-stakes)

1. **Get a second copy of everything** — off-host `git bundle --all` + install the backup cron the doc already contains + off-host copy. ([03](03-data-durability-and-disaster-recovery.md) D1.a/D2.a)
2. **Un-track & rotate secrets** — `git rm --cached` the LiveKit config files, gitignore them + `*.bak-*`, rotate the exposed keys. ([02](02-security-and-access-control.md) S4 / [03](03-data-durability-and-disaster-recovery.md) D3)
3. **Recording disk backstop** — age-bound the pending-upload gate + a hard disk-budget delete + one-time reclaim of the May/June dirs. ([01](01-recording-and-clips-pipeline.md) P0.1–P0.3)
4. **Close the account-takeover** — stop returning the reset token; generic response. ([02](02-security-and-access-control.md) S1)
5. **Auth the LiveKit token endpoint** + least-privilege default grants. ([02](02-security-and-access-control.md) S2)
6. **Validate economy inputs + close the self-award** — reject non-positive `quantity`/amounts (kills the gift-item mint), *and* authorize/cap `POST /api/internal/award-points` (any authed user can self-credit — validation alone does **not** close it). ([04](04-database-and-economy-integrity.md) E1, E1b)
7. **Enforce stream-control auth (the low-risk direction only)** — set `INTERNAL_API_SECRET` on both processes, confirm the inbound header flows, *then* set `ENFORCE_STREAM_CONTROL_AUTH=true` (V1, chat→main — the secret is already sent). The main→chat direction (CH3) is **not** P0 — it needs a ~10-callsite retrofit first (moved to P1). ([02](02-security-and-access-control.md) S3, [06](06-chat-moderation-and-viewbots.md) V1)
8. **Fix CORS allow-all** + the NaN rotation-poison validation + the CSAM `eventId` one-liner + defuse the node_modules symlinks (`git rm --cached`). ([02](02-security-and-access-control.md) S10, [05](05-streaming-and-takeover-reliability.md) T1, [06](06-chat-moderation-and-viewbots.md) M2, [03](03-data-durability-and-disaster-recovery.md) D4.a)
9. **Recording auto-stop-on-empty (P0.5)** — the actual bleed-stopper for the multi-GB day-buckets; the disk backstops (item 3) can't bound an *active* runaway egress. ([01](01-recording-and-clips-pipeline.md) P0.5/R7)

### P1 — correctness & integrity (weeks)

- **Recording lifecycle** — per-run session IDs; reach a terminal upload state; auto-stop idle egress. ([01](01-recording-and-clips-pipeline.md) P1)
- **Transaction integrity** — close the `withTransaction` mutex hole (foundational), then wrap transfer/sell/gift atomically; decrement-before-effect. ([04](04-database-and-economy-integrity.md) DB2, E2–E5)
- **Fresh-boot schema & single-source DDL** — clone/DR actually works. ([04](04-database-and-economy-integrity.md) DB1, DB3)
- **Client reliability** — real reconnection, publish-failure surfacing, replaceTrack fix, ConnectionMonitor. ([05](05-streaming-and-takeover-reliability.md) C1–C4)
- **Takeover↔rotation race** + time-tracking session end. ([05](05-streaming-and-takeover-reliability.md) T2, T3)
- **Moderation enforcement** — chat-ban enforced, XFF trust (socket-handshake, not `trust proxy`), VisionFrame evidence, URL-relay auto-block, unban-by-stable-id. ([06](06-chat-moderation-and-viewbots.md) CH1/CH2, M1–M5)
- **Chat-service HTTP-API auth (CH3 retrofit)** — attach `X-Internal-Secret` to ~10 main→chat outbound call sites, *then* enforce on all mutating routes (incl. `/api/remove-timeout`). Moved here from P0 — it's net-new code, not a middleware add. ([06](06-chat-moderation-and-viewbots.md) CH3)
- **Kick recovery + bot-over-human guard.** ([06](06-chat-moderation-and-viewbots.md) V2, V3)
- **Shutdown no longer massacres the egress recorder (B4)** — scope the kill to descendants incl. the Chrome pkills; land with the shutdown watchdog (B2), same file. Fires on *every* restart today. ([07](07-ai-transcription-and-platform-hygiene.md) B4, B2)
- **CI edits** — drop `--ignore-scripts`, add chat-service job (independent of push-restore; only "green on deployed HEAD" awaits D1). ([07](07-ai-transcription-and-platform-hygiene.md) O1)
- **AI reliability** — LLM/whisper timeouts, chat-event dedup, VisionBot cross-stream guard, Redis-backed cooldowns (via `setRedisClient`), fatal-startup exit. ([07](07-ai-transcription-and-platform-hygiene.md) A2–A4, A6, B1, B3)

### P2 — reliability, resilience, architecture (ongoing)

- **Recording** — decouple local retention from B2; ordered/multipart upload; fix/delete dead clip paths. ([01](01-recording-and-clips-pipeline.md) P2)
- **Streaming roots** — client connection state machine; `currentStreamer` single-writer with explicit `streamerKind`. ([05](05-streaming-and-takeover-reliability.md) C5, T6)
- **Lifecycle** — `global.*` → services bag; timer handles (shutdown watchdog B2 + descendant-scoped kill B4 moved up to P1). ([07](07-ai-transcription-and-platform-hygiene.md) B5, B6)
- **DB hardening** — boot ready-promise, migration fail-loud, `UNIQUE(user_id)`, ledger atomicity, single driver decision (+ ADR-0014 update). ([04](04-database-and-economy-integrity.md) DB4–DB7)
- **Viewbots/relay** — SIGKILL liveness, ingress-janitor race, health watchdog. ([06](06-chat-moderation-and-viewbots.md) V4–V6)
- **AI load model** — single transcription-window producer; continuous-mode decision; Groq-key single source. ([07](07-ai-transcription-and-platform-hygiene.md) A1, A5, A7)
- **SSRF egress filtering**, rate limits, password policy, docs/deps cleanup. ([02](02-security-and-access-control.md) S7/S11, [07](07-ai-transcription-and-platform-hygiene.md) O2)

## Sequencing & dependencies (the non-obvious ones)

- **B2 must stay off until [01](01-recording-and-clips-pipeline.md) P1.1 (per-run session IDs) lands.** Enabling B2 today triggers the "rm -rf the live bucket" data-loss (R4). Per-run dirs are a hard prerequisite for turning archival on.
- **The `withTransaction` mutex hole ([04](04-database-and-economy-integrity.md) DB2) is foundational — and it is a real refactor of the whole economy write layer, not a wrap.** The one "already atomic" path (`purchaseItem`) actually *depends* on the shared-connection hole (its `_tx` is unused), so both fix options break it unless every economy write is re-plumbed through a tx handle first (a signature change across `AccountService`→`PointsManager`→`AccountStatsRepository`). The **driver decision must precede DB2** (the two drivers have different transaction semantics), and **DB1 fresh-boot schema must precede the DB2 regression tests**.
- **Stream-control / chat-API auth flips depend on `INTERNAL_API_SECRET` being sent on both processes** — set the secret and verify the outbound header *before* flipping enforcement, or moderation callbacks break.
- **The `currentStreamer` single-writer ([05](05-streaming-and-takeover-reliability.md) T6) underpins the viewbot bot-over-human guard ([06](06-chat-moderation-and-viewbots.md) V3)** — V3 can ship a narrower guard first, but its clean form waits on T6.
- **CI restore ([07](07-ai-transcription-and-platform-hygiene.md) O1) waits on push-restore ([03](03-data-durability-and-disaster-recovery.md) D1)** — "CI red OK" has been the norm precisely because CI is broken and invisible; fixing it only matters once it gates the deployed history.

## How these plans were pressure-tested

The plans were themselves run through an adversarial red-team — **14 reviews** (two lenses per doc: fix-correctness and prioritization/sequencing), each spot-checking claims against the real code. It returned **4 blockers, 21 majors, 38 minors**, all folded back in. The corrections that changed the plan (not just wording):

- **S2** (LiveKit token) reframed from "require auth / reject anonymous" to "server-only downgrade to subscribe-only" — the original would have blacked out every anonymous viewer (the client sends no JWT today).
- **DB2** (transaction hole) re-scoped from "close the mutex first" to a full economy-write-layer refactor — `purchaseItem` *depends* on the hole, so the naive fix breaks the one atomic path.
- **CH3** (chat-API auth) moved P0→P1 — the main→chat secret is *not* sent today (a ~10-callsite retrofit), opposite direction from S3.
- **B4** (shutdown kill) raised medium→high, P2→P1 — it fires on *every* restart and must also cover the Chrome kills, not just ffmpeg.
- **P1.1** (per-run recording dirs) gained a load-bearing requirement — the `_parseSessionDir` regex must change in lockstep or the leak returns *and* all clips break.
- New P0 items surfaced: the `award-points` self-mint (validation doesn't close it) and recording **auto-stop-on-empty** (the real active-runaway bound).

Each plan also carries a **"Risks & red-team notes"** section, and all preserve the **7 adversarially-refuted findings** as "considered and ruled out" so they aren't re-opened.

## Scope notes

- This audit targets **defects and architectural traps**, not feature work or dependency upgrades (Dependabot owns the latter, per `CLAUDE.md`).
- Where a fix is a structural change that contradicts an ADR (e.g. the recording session model, the DB driver), the plan says so and calls for a new/updated ADR rather than a silent change.
- Findings are current as of 2026-07-14 against local `main`. The live-DB numbers (82/84 sessions stuck, 37 GB) are point-in-time and will grow until [01](01-recording-and-clips-pipeline.md) P0 lands.
