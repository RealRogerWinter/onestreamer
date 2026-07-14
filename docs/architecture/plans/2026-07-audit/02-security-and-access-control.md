# Plan 02 — Security & access control

_Part of the [2026-07 codebase audit](README.md). Owner area: `server/routes/auth/*`, `server/routes/media.js`, `server/middleware/*`, `server/services/IPBanService.js`, `server/utils/ssrfGuard.js`, `server/index.js` (CORS), plus the chat-service HTTP API (see [Plan 06](06-chat-moderation-and-viewbots.md))._

> Status: **proposed**. Several of these are **internet-facing and pre-auth** in the current deployment posture. The P0 items below should be treated as an incident, not a backlog.

## The deployment posture that makes this urgent

Two defaults turn "authenticated-only" bugs into anonymous ones:

- `ENFORCE_STREAM_CONTROL_AUTH` is **unset** in the deployed `.env`, so `streamControlAuth` (`middleware/streamControlAuth.js:32`) calls `next()` for everyone — the URL-ingestion and stream-control API is anonymous.
- Socket.IO CORS (`index.js:151`) is `callback(null, true)` for **all** origins with `credentials:true` ("Allow all for now to debug ViewBots").

So the URL-relay, rotation-control, and socket surfaces are reachable by any internet visitor, and several findings compound accordingly.

## Confirmed findings

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| S1 | **critical** | `POST /forgot-password` returns the raw reset token in the HTTP response → account takeover for any known email; also 404-vs-200 enumeration oracle | `routes/auth/password.js:16` |
| S2 | **critical** | `GET /api/livekit/token` is unauthenticated and mints a **publish-capable** token for an attacker-chosen `identity` into the shared room → stream hijack / streamer eviction / media injection to all viewers | `routes/media.js:120` |
| S3 | high | URL-ingestion + stream-control routes anonymously reachable (enforcement flag unset); anyone can ingest arbitrary URLs, force-rotate, `/stop-all`, spawn ffmpeg/streamlink, rewrite adaptive encoding | `middleware/streamControlAuth.js:32` |
| S4 | high | Live LiveKit `api_key`/`api_secret` sit in the working tree of **git-tracked** `egress-config.yaml`/`ingress-config.yaml` (committed version had placeholders) → leak on any `git commit -a` | `egress-config.yaml:3` |
| S5 | high | IP-ban bypass via client-controlled `X-Forwarded-For` (takes the **leftmost** hop) — spoof any unbanned IP | `services/IPBanService.js:187` |
| S6 | medium | Path traversal / arbitrary file read in admin recording serving: `path.join(sessionDir, req.query.file)` and `/segment/:id/:filename`, no confinement | `routes/admin-recordings/recordings.js:202` |
| S7 | medium | Residual SSRF: `ssrfGuard` validates DNS once, but streamlink/yt-dlp/ffmpeg re-resolve and follow redirects (TOCTOU rebind + redirect bypass) | `utils/ssrfGuard.js:41` |
| S8 | medium | `authenticateToken` deleted/pending-deletion checks are dead code — `getSafeById` omits `account_status`, so purged users pass auth for their JWT's life | `middleware/auth.js:31` |
| S9 | medium | `authenticateToken` fails **open**: a DB error in the status/ban check is swallowed and the request proceeds | `middleware/auth.js:44` |
| S10 | low | Socket.IO CORS allows every origin with `credentials:true` → cross-site WebSocket hijacking with the victim's cookie | `index.js:151` |
| S11 | low | `reset-password` has no Turnstile, no rate limit, no server-side password policy | `routes/auth/password.js:29` |
| S12 | low | `emojis` upload transcode uses `exec()` with shell interpolation of paths (latent RCE if a path ever becomes user-influenced) | `routes/emojis.js:187` |
| S13 | low | OAuth completion reads camelCase off a snake_case row → disables the already-linked fast-path, zeroes role flags in the response (under-reports; not escalation) | `services/AuthService.js:437` |

**Refuted by the adversarial pass** (do not action): "`permanentlyDeleteAccount` deletes its own audit log non-transactionally" — the audit row is written to a table that survives the purge.

## Remediation plan

### P0 — treat as an incident (hours)

- **S1** — Never return the reset token. Send it only via email; respond `200` with a generic "if that email exists, a reset link was sent" regardless of match (closes the enumeration oracle in the same change).
- **S2 — server-only, downgrade-don't-reject (this is the P0 part).** The critical hole is anonymous **publish**, and it is closable with **zero client changes**: invert `generateToken`'s default to `canPublish:false` (`LiveKitService.js:461`; both callers pass explicit grants, verified, so no regression), and in `media.js` grant `canPublish:true` **only** when the requester is the validated active streamer (`StreamService.getCurrentStreamer()`); otherwise everyone — including anonymous viewers — still gets a **subscribe-only** token. **Do NOT "require auth / reject anonymous callers" as a P0:** `LiveKitClient.getLiveKitToken()` fetches this endpoint with **no Authorization header** for *both* viewers and streamers, and anonymous viewing is a core product feature — rejecting anonymous callers would black out every viewer and even logged-in users. Also give `createWebRtcTransport` (`LiveKitService.js:189`) the same role-gated decision — it hands `canPublish:true` unconditionally and the default-inversion doesn't touch it. _(The "require a JWT / bind identity to session" hardening is a real fix but it is **client-coupled** — the client must start sending its JWT — and must preserve anonymous subscribe; it belongs in P1, not P0.)_
- **S3 — three ordered steps; step 2 is the risky one.** Setting `ENFORCE_STREAM_CONTROL_AUTH=true` **is** the enforcement trigger (`streamControlAuth.js:32`), so it carries the full lockout risk — not the later code default-flip. (1) Set `INTERNAL_API_SECRET` identically on **both** processes and confirm via the permissive-mode "ALLOWED" log that inbound requests now actually carry `X-Internal-Secret` (flag still off — zero risk). (2) **Only after** confirming the header flows, set `ENFORCE_STREAM_CONTROL_AUTH=true` (the enforcing step). (3) Flip the code default to fail-closed. Note this covers the chat-service→main direction (which already sends the secret); the main→chat-service direction is a **separate, unmet** dependency — see [Plan 06](06-chat-moderation-and-viewbots.md) CH3.
- **S4** — `git rm --cached egress-config.yaml ingress-config.yaml`, add them (and `*.bak-*`/`*rotate*`) to `.gitignore`, ship `*.example.yaml` siblings, **rotate the exposed LiveKit keys**, and move the `.bak-*-rotate` secret backups out of the repo tree. (Cross-referenced in [Plan 03](03-data-durability-and-disaster-recovery.md).)
- **S10** — Restore rejection in the CORS `else` branch behind the existing allowlist; keep `!origin` (server-side) connections allowed; gate any allow-all behind an explicit debug env flag.

### P1 — close the authz gaps (days)

- **S5** — The IP-ban path is entirely **Socket.IO handshake based** (`IPBanService.getIPFromSocket` reads `socket.handshake.headers['x-forwarded-for']` directly), so **Express `trust proxy` does not apply** — it only governs `req.ip` for HTTP. The concrete fix lives in `getIPFromSocket`: take the **last** XFF hop (nginx appends `$remote_addr`) instead of `[0]`, documenting the single-trusted-proxy assumption, and add the precondition that the socket ports must not be directly reachable bypassing nginx. The same leftmost-XFF bug exists in `SessionService.js:26`, `TimeTrackingService.js:320`, and `middleware/turnstile.js:35` — fold them into this fix. The chat-service has the identical socket-handshake bug (see [Plan 06](06-chat-moderation-and-viewbots.md) CH2/M1).
- **S6** — After `path.join`, `path.resolve` and assert the result stays within the session dir (`resolved.startsWith(path.resolve(sessionDir) + path.sep)`); reject basenames containing separators or `..`. Apply to both handlers and to the moderation-ai image handler (defense in depth).
- **S8** — Add `account_status` to the `getSafeById` projection (or a dedicated status query) so the existing deletion/pending checks evaluate real values.
- **S9** — Make the `authenticateToken` status/ban check fail **closed** (reject on exception, don't proceed). Same posture for `IPBanService` (see [Plan 06](06-chat-moderation-and-viewbots.md), M-tier).

### P2 — harden the edges (days–weeks)

- **S7** — Pin the resolved public IP and force the child tools to connect to it (or run them in a network namespace with egress filtering to public ranges only); disable/limit redirect-following; route internal re-validation callers through `assertSafeUrl`. Network-level egress filtering is the durable fix — DNS-rebind + redirect can't be fully closed at the app layer.
- **S11** — Add rate limiting to the auth endpoints and a server-enforced minimum password policy in `AccountService`.
- **S12** — Switch the emoji transcode to `execFile`/`spawn` with an argv array; drop the `2>/dev/null` shell redirect.
- **S13** — Reference the real column names or normalize the row to camelCase in the repository.

## Risks & red-team notes

- **S3: the env-set is the enforcing/risky step, not a safe precursor.** `ENFORCE_STREAM_CONTROL_AUTH=true` immediately gates the routes; if `INTERNAL_API_SECRET` isn't already flowing on the chat-service→main callbacks, that env-set (not the later code flip) 401s every vote/rotation callback. Order: set the secret on both processes → confirm the inbound header via the permissive "ALLOWED" log → *then* set the enforce flag → then flip the default. This is the reverse of "env-set is safe, code-flip is risky."
- **S2 must not reject anonymous callers** — `/api/livekit/token` is the token source for *every* viewer (including anonymous), and the client sends no Authorization header today. The P0 fix is server-only: downgrade non-streamers to subscribe-only, don't deny. "Require a JWT" is a separate P1 that needs a coordinated client change and must preserve anonymous subscribe. Keep a test that both the active streamer can publish *and* an anonymous viewer can subscribe.
- **S5 has a wrong-fix trap**: taking the last XFF entry is only correct with exactly one trusted proxy. Document the hop count; if the topology changes (a second proxy/CDN), the derivation changes. Prefer Express `trust proxy` set to the real hop count over hand-parsing.
- **S4 rotation is mandatory, not optional** — a revert alone leaves the key valid. Coordinate with `docs/operations/runbooks/secret-rotation.md`.

## Success criteria

- `forgot-password` returns no token and a uniform response for existing/non-existing emails; a test asserts the token never appears in the body.
- `/api/livekit/token` never grants `canPublish` to a non-streamer; anonymous callers still receive **subscribe-only** tokens (anonymous viewing keeps working); `generateToken` defaults to no-publish. A test asserts a non-streamer identity gets `canPublish:false` and the active streamer gets `canPublish:true`.
- `ENFORCE_STREAM_CONTROL_AUTH` enforced in prod; anonymous `POST /api/url-stream` returns 401.
- `egress-config.yaml`/`ingress-config.yaml` untracked; LiveKit keys rotated; `git status` clean of secret-bearing files.
- Traversal payloads (`?file=../../../../etc/passwd`) return 404/400; a test covers both recording handlers.
- CORS rejects unknown origins; a test covers the reject branch.
