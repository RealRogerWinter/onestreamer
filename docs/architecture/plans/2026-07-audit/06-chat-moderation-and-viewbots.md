# Plan 06 — Chat service, moderation & viewbots

_Part of the [2026-07 codebase audit](README.md). Owner area: `chat-service/*`, `server/services/ModerationService.js` + `ModerationStage*.js` + `moderation/*`, `server/services/IPBanService.js`, `server/routes/moderation*.js`, `server/services/ViewBotURLService.js` + `urlstream/*` + `viewbotLivekit/*`, `server/services/URLStreamHealthService.js`._

> Status: **P0 merged (PR #25 — M2 vision-frame eventId/CSAM-evidence fix landed there); P1 moderation-enforcement tranche landed: CH1 (ban enforced at connect, fail-open kept), CH2/M1 (last-XFF-hop IP parse in both processes + vote dedup by authenticated user id), CH3 (internal-secret gate on the whole chat HTTP API incl. `/api/remove-timeout` and both reads, via `server/utils/chatServiceClient.js` on all 13 outbound sites, staged behind `ENFORCE_CHAT_INTERNAL_AUTH`), M3 (live-relay identity resolution + fail-honest `admin_review` downgrade), M4 (`/ban-chat` propagates to the chat-service store + `isChatBanned` on the internal status route; `banned_usernames` kept as audit trail), M5 (`moderation_events.resolved_user_id` persisted at ban time; reverse by stable id, 409 on unresolvable). Still open here: CH4–CH7, M6–M7, V1–V6.** Original audit status: proposed — three loosely-related subsystems grouped because they share one theme: **enforcement gaps** — controls that appear to work (bans, votes, auto-moderation, the "never bot over a human" invariant) but silently don't.

## Cross-cutting theme: write-only controls

Repeatedly, a moderation/safety action succeeds at the UI but is never enforced downstream: two ban stores that never reconcile, an auto-block that never populates its inputs, a "real streamer" gate checked once then bypassed on every reconnect. The fix pattern is consistent — make the enforcement point read the same state the action wrote, and fail closed on the security-critical gates.

## Confirmed findings

### Chat microservice

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| CH1 | high | Account-level ban from the main server is fetched then **discarded** — banned accounts keep chatting (only `isAdmin`/`isModerator` consumed at connect) | `chat-service/core/socketHandlers.js:319` |
| CH2 | high | Client-controlled `X-Forwarded-For` trusted (leftmost hop) for identity, IP-ban, and **vote dedup** → one person passes any vote and inflates the threshold denominator | `chat-service/core/socketHandlers.js:105` |
| CH3 | high | HTTP moderation/broadcast API (`/api/ban`, `/unban`, `/timeout`, `/system-message`) has **no auth** despite `INTERNAL_API_SECRET` being configured | `chat-service/api/routes.js:124` |
| CH4 | medium | Claim event can get permanently stuck `active`, silently killing all future `/claim` events until restart | `chat-service/commands/commandParser.js:654` |
| CH5 | medium | Anonymous bans are voided by a chat-service restart (identity regenerates) | `chat-service/core/socketHandlers.js:363` |
| CH6 | low | Per-user throttle Maps never pruned on disconnect → unbounded memory growth over process lifetime | `chat-service/core/socketHandlers.js:203` |
| CH7 | low | Vote threshold frozen at start; viewers leaving can make a vote mathematically unable to pass, then imposes the failed-vote cooldown | `chat-service/votes/voteService.js:154` |

### Moderation pipeline

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| M1 | high | IP-ban bypass via client-controlled `X-Forwarded-For` (leftmost hop) — same class as CH2, server side | `services/IPBanService.js:187` |
| M2 | high | `handleVisionFrame` reads the wrong insert-result key → `eventId` always null in prod: **CSAM/banned image evidence is purged instead of promoted** to the permanent folder; arbiter fed `id:null` | `services/ModerationService.js:396` |
| M3 | high | URL-relay AI auto-block never fires: external-identity fields never populated on transcript chunks → offending relay rotated away but not blocklisted, re-selectable immediately; recorded as `auto_skip` (didn't happen) | `services/ModerationService.js:725` |
| M4 | high | Anonymous chat ban (`banned_usernames`) and `users.chat_banned` are **write-only** — never enforced in the message path | `routes/moderation.js:69` |
| M5 | medium | Ban reversal silently fails: `streamer_id` is an ephemeral socket id resolved live → user stays banned after an admin "unban" | `routes/moderation-ai.js:106` |
| M6 | medium | `IPBanService` fails **open**: a DB error on an uncached IP returns not-banned (banned IPs admitted during SQLITE_BUSY) | `services/IPBanService.js:82` |
| M7 | medium | MovieBot output gate fails **open** when Stage 2 is degraded → borderline bot replies emitted under the platform identity during a Groq outage | `services/ModerationService.js:990` |

### Viewbots & URL relay

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| V1 | high | Stream-control + URL-ingestion API effectively unauthenticated (`ENFORCE_STREAM_CONTROL_AUTH` never enabled) — hijack output, DELETE streams, spawn ffmpeg/streamlink at will | `middleware/streamControlAuth.js:32` |
| V2 | high | Kick 403 token-refresh restart is **guaranteed to crash**: `streamInfo` written with wrong field names → entire Kick recovery feature is dead, leaks one ingress per attempt | `services/urlstream/StreamReconnector.js:269` |
| V3 | high | URL relay can bot over a real human: gate is check-once (TOCTOU), reconnect/notify paths re-register unconditionally, takeover never stops manual relays | `services/urlstream/StreamReconnector.js:126` |
| V4 | medium | SIGKILL escalation in `stopProcesses` is dead code (`process.killed` true after SIGTERM *send*, not exit) → zombie ffmpeg/streamlink accumulate on rotation | `services/urlstream/FFmpegPipeline.js:252` |
| V5 | medium | `IngressJanitor`'s viewbot filter can delete the NEW url-stream's ingress (exclusion only applied to the url-stream filter) → "stream dies seconds after starting" crash-loop | `services/urlstream/IngressJanitor.js:70` |
| V6 | medium | Stale-stream watchdog effectively disabled: health entries from ffmpeg progress lack `streamStartTime`, so the grace period never ends; Kick relays have ~zero health monitoring | `services/URLStreamHealthService.js:184` |

**Refuted** (do not action): "`stopURLStream` never clears `currentStreamer`, leaving a phantom `url-stream-*` streamer that blocks viewbot creation" — investigated and refuted.

## Remediation plan

### P0 (hours)

- **CH3 — two steps, and step 1 is real work (NOT "hours").** The stated pre-req was wrong: the main server does **not** currently send `X-Internal-Secret` on its outbound calls to the chat-service mutating endpoints, and [Plan 02](02-security-and-access-control.md) S3 covers the *opposite* direction (chat-service→main). So enabling enforcement as-is would break admin ban/unban/timeout **and** every takeover/rotation/TTS/soundboard/StreamBot system-message. **Step 1 (net-new code):** add `X-Internal-Secret` to *all* main-server outbound callers of the chat-service mutating endpoints — `admin-moderation.js:86`+, `ChatNotifier.js:58`, `SoundFxService.js:187`, `takeover.js:316`, `RandomStreamRotationService.js:271`, `PeriodicMessageScheduler.js` (~10 call sites, most building axios config inline with no shared helper — worth a shared helper). **Step 2:** add the enforcement middleware on **all** mutating routes — including `/api/remove-timeout` (`routes.js:244`), which the finding's route list omitted — and make an explicit decision on the unauthenticated **read** endpoints `/api/moderation` (leaks the ban list) and `/api/chat-history` (leaks history): gate them or document why they stay open. This is **not P0-hours**; it's a P1 retrofit.
- **V1** — Set `ENFORCE_STREAM_CONTROL_AUTH=true` (shared action with [Plan 02](02-security-and-access-control.md) S3 and [Plan 05](05-streaming-and-takeover-reliability.md) T1).
- **M2** — One-line fix with outsized stakes: read `insertResult.id` (the real adapter contract) so image-moderation `eventId` is populated and banned-frame evidence is **promoted, not purged**. Fix the test mock to the real shape. This touches CSAM handling — do it first among the moderation items and cross-check `docs/operations/runbooks/csam-incident.md`.

### P1 — make enforcement real (days)

- **CH1** — Capture `userStatus.isBanned` at connect and, if true, `emit('banned')` + `socket.disconnect(true)` exactly like the local ban branch.
- **CH2 / M1** — Both are **Socket.IO handshake** reads (`socketHandlers.js:105`, `IPBanService.js:187`), so Express `trust proxy` does **not** apply — parse the **last** comma-separated XFF hop (nginx-appended) directly on the handshake header, with the precondition that the chat-service/main ports are not directly reachable bypassing nginx (else even the last hop is attacker-controlled). Additionally dedup votes by authenticated user id where available. Same fix in both processes (see [Plan 02](02-security-and-access-control.md) S5 for the server-side sibling readers).
- **M4** — Enforce `chat_banned`/`banned_usernames` in the chat-service message path (or have `/ban-chat` call the chat-service `/api/ban`), and load persisted bans on boot. Reconcile the two ban stores into one enforced store.
- **M3** — Populate `externalPlatform/externalLogin` onto transcript chunks (derivable from the active url-stream) or resolve them in `ModerationService` before `arbitrate`; have `_actUrlRelay` downgrade to `admin_review` when it can't actually block.
- **M5** — Persist the resolved `user_id` on the `moderation_events` row at ban time and unban by that stable id; treat a failed socket→user resolution as an error, not a silent no-op.
- **V2** — Write the shape the pipeline reads: `streamInfo = { success:true, streamUrl, pipeMode:false, isHLS:true, platform:'kick', tool:'direct' }`. Restores all Kick token recovery.
- **V3** — Re-run the real-streamer check inside `_registerAsCurrentStreamer` (refuse + self-stop if a human holds `StreamService`); make the takeover handler stop any active URL relay (`stopAllURLStreams()`) the way it pauses rotation. Depends on the `isRealStreamer()` single-writer from [Plan 05](05-streaming-and-takeover-reliability.md) T6.

### P2 — fail-closed posture, leaks & health (days–weeks)

- **M6** — Make `IPBanService` fail **closed** (or retry) on DB error for the security gate; make both branches consistent.
- **M7** — When Stage 2 is degraded and Stage 1 hit anything, drop/hold the bot reply rather than allowing it.
- **CH4** — On award failure, `clearActiveClaim()` (or re-arm expiry) instead of just nulling `claimedBy`; have the expiry timer clear unconditionally once elapsed.
- **CH5** — Persist `ipToUser` (or ban anonymous users by a stable IP/subnet identifier) so anonymous bans survive restarts.
- **CH6** — Prune throttle-map entries on disconnect (when no other socket shares the username) or sweep stale entries.
- **CH7** — Recompute `requiredVotes` against the live viewer count when tallying (clamped to current participants).
- **V4** — Track liveness via the `exit` event (a `resolved` flag) instead of `process.killed`; `if (!resolved) process.kill('SIGKILL')`.
- **V5** — Apply the `excludeUrlId` guard to the viewbot-ingress filter too (or stop prefixing url-stream ingress names with `viewbot-`).
- **V6** — Set `streamStartTime` in the ffmpeg-progress creation branch (prefer stamping once at stream start); for direct-HLS sources do a lightweight playlist HEAD/GET instead of assuming live.

## Risks & red-team notes

- **V1 and CH3 are opposite directions with opposite readiness — do not bundle them.** V1 (streamControlAuth, chat-service→main) reads a secret the chat-service **already sends**, so its flip is genuinely low-risk (once the env var is set on both). CH3 (main→chat-service) requires a secret the main server does **not** yet attach to its outbound calls — that's net-new code across ~10 call sites, an outstanding *build* dependency, not just an env var. "Secret present on both processes" is necessary but **not sufficient** for CH3.
- **M2 changes evidence-retention behavior around CSAM** — validate against the CSAM runbook and confirm the `banned/` promotion path actually persists before relying on it for legal/appeal review. This is the one place "ship fast" must yield to "verify correctness."
- **V3 depends on T6** (single `currentStreamer` writer). Until T6 lands, implement V3's re-check against the best current source and accept it's a narrower guard; don't let V3 block on the larger refactor.
- **CH2/M1 XFF fix is topology-specific** — the last-hop rule assumes exactly one trusted proxy (nginx). If a CDN is added in front, revisit. Prefer `trust proxy` hop-count config over hand-parsing.
- Respect the refuted `stopURLStream` finding — don't add phantom-streamer-clearing code the verifier showed is unnecessary.

## Success criteria

- An account-banned user cannot connect to chat; an anonymous-banned user stays banned across a chat-service restart.
- The chat-service HTTP API rejects requests without the internal secret.
- A single client cannot pass a vote alone via XFF spoofing; IP bans hold against XFF spoofing.
- Image-moderation events get a real `eventId`; banned frames land in the permanent folder (test asserts promotion).
- A Kick relay recovers from a 403 token expiry without crashing or leaking an ingress.
- A URL relay refuses to start/register over a live human streamer; takeover stops active relays.
