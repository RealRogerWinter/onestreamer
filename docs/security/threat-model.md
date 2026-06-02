# Threat model

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer is a single-tenant, self-hosted, public-facing live-streaming platform. This page lays out what it's designed to defend against, what's deliberately out of scope, and the trust boundaries that shape every other design decision.

## Assets

| Asset | Why it matters |
|-------|----------------|
| **User accounts + credentials** | Compromise = identity theft, ban evasion, point-balance theft |
| **Active streams** | Real-time media from users with reasonable privacy expectations |
| **Recorded streams + clips** | Persistent media; can be re-shared, downloaded |
| **User-uploaded media** (avatars, custom emojis) | Could host inappropriate content; XSS vector via SVG |
| **Chat history** | Recent ~3,000 messages in memory; potential moderation evidence |
| **Points balance** | Internal-economy currency; theft = financial-shaped grievance |
| **Server credentials** (SendGrid, B2, Google OAuth, etc.) | Compromise = email-sending, bucket-pilfering, OAuth-app takeover |
| **TURN HMAC secret** | Currently shipped to every browser ([`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md)); deserves architectural fix |
| **Admin/moderator privileges** | Can disconnect streams, ban users, edit shop, manage chatbots |

## Adversaries

| Adversary | Capabilities | Motivation |
|-----------|--------------|------------|
| **Anonymous viewer** | Connect over public internet; submit chat messages after Turnstile; open sockets | Trolling, ban evasion, low-effort exploration |
| **Authenticated user** | All of above + earn/spend points, use items, request stream, gamble | Same plus economy exploitation, item misuse |
| **Compromised authenticated user** | All of above with another user's identity | Reputation attacks, item theft, ban-evading via the original account |
| **Malicious streamer** | All of above + control over the live broadcast | Stream inappropriate content; deliberately drop quality via VisualFX; abuse TTS for unwanted speech |
| **Insider with admin access** | All admin endpoints | Account modification, ban management, recording deletion |
| **External attacker** | No platform credentials | DDoS, OAuth/Turnstile abuse, scraping, fuzzing |
| **Service-provider compromise** | Read access to credentials / data at SendGrid / B2 / Google / Cloudflare / etc. | Out of OneStreamer's control; mitigated by least-privilege keys |

## Defenses (current state)

### Authentication
- **JWT** signed with `JWT_SECRET` (24-hour TTL) + refresh tokens (7 days). See [`auth-flows.md`](auth-flows.md).
- **bcrypt password hashing** in [`AccountService`](../../server/services/AccountService.js).
- **Google OAuth** via [`passport-google-oauth20`](https://www.passportjs.org/packages/passport-google-oauth20/).
- **Email verification** required for some actions (account deletion specifically requires verified email).

### Authorization
- **Role-based**: `is_admin`, `is_moderator` flags on `users` row, checked in [`server/middleware/auth.js`](../../server/middleware/auth.js).
- **Resource-based**: users can edit their own profile, delete their own clips, etc. — checked per-route.
- **Legacy `ADMIN_KEY`** for older admin endpoints (being phased out).

### Bot / abuse protection
- **Cloudflare Turnstile** on signup, login, password reset, bug reports, first anonymous chat message.
- **Rate limiting**: 5 seconds between chat messages, duplicate-message detection over 30s.
- **Profanity filter** ([`ProfanityFilterService`](../../server/services/ProfanityFilterService.js)) with normalization for character substitution.
- **IP bans** ([`IPBanService`](../../server/services/IPBanService.js)) — block at socket-connect time.
- **Account bans** — separate from IP bans; survive VPN switches.

### Transport
- **HTTPS everywhere** — Let's Encrypt certs on nginx; HSTS header `max-age=31536000; includeSubDomains`.
- **WSS for sockets** (Socket.IO over the HTTPS connection).
- **LiveKit uses DTLS-SRTP** for WebRTC media (it is the sole WebRTC backend — [ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). The RTMP ingress that the URL relay and viewbots push to, and the egress that recording reads from, are localhost-only (`127.0.0.1:1935` / loopback).

### Headers
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

### Account-deletion controls
- Type-to-confirm UI ("DELETE MY ACCOUNT") prevents fat-finger deletes.
- 24-hour token + 15-day grace period before hard purge.
- IP + user-agent captured at every deletion-related event.

## Known gaps

| Gap | Risk | Mitigation status |
|-----|------|-------------------|
| **TURN HMAC secret shipped to client** | Anyone can mint TURN credentials against coturn | Documented in [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md); architectural fix proposed (server-side credential signing) but not implemented |
| **Default `JWT_SECRET` / `SESSION_SECRET` fallbacks in code** | If prod doesn't override, anyone with source access can forge admin tokens | Documented; rotation procedure in the runbook |
| **Default `LIVEKIT_API_KEY=devkey`** | Anyone can mint LiveKit room tokens — and LiveKit carries **all** live media ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)) | High blast radius if shipped: a forged token can join/publish to any room. Production **must** override; documented in [`secret-rotation.md`](../operations/runbooks/secret-rotation.md) |
| **No CSRF protection** for cookie-authed routes | Acceptable since auth is JWT-Bearer in headers, not cookies | Verify any future cookie-auth additions add CSRF |
| **No DDoS protection at the application layer** | Single host; vulnerable to large floods | Mitigated by Cloudflare in front of nginx (Turnstile site implies Cloudflare account already exists; verify Cloudflare proxy is enabled on the DNS records) |
| **No automated dependency scanning today** | Vulnerable to known CVEs in dependencies until manually updated | Step 10 of the docs overhaul adds Dependabot |
| **No structured audit log of admin actions** beyond emoji-prefixed log lines | Forensic value is limited to whatever's in `pm2 logs` | Acceptable for current scale |

## Out of scope

These are things OneStreamer is **not** trying to defend against, by design:

- **State-actor adversaries with infinite resources.** Outside the threat model.
- **Compromise of the host OS.** Standard host-hardening practices (SSH key auth, firewall, automatic security updates) apply but are not OneStreamer's responsibility.
- **Loss of the host.** Disaster recovery procedures exist ([`/docs/operations/backup-restore.md`](../operations/backup-restore.md)) but there's no high-availability story.
- **Streamer content moderation at scale.** OneStreamer ships moderation tooling for admins; the platform isn't trying to AI-moderate streamer content.
- **Geographic restrictions / GDPR compliance / content licensing.** Self-hoster's responsibility based on their jurisdiction.

## Reporting vulnerabilities

See [`/SECURITY.md`](../../SECURITY.md) for the disclosure policy.

## See also

- [`auth-flows.md`](auth-flows.md) — auth sequence diagrams
- [`moderation-policy.md`](moderation-policy.md) — abuse-handling policy
- [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md) — credential rotation
- [`/docs/getting-started/environment-variables.md`](../getting-started/environment-variables.md) — the "Default secrets that are footguns" section
