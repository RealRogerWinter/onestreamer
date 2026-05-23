# Security policy

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Email security reports to **security@onestreamer.live** (or contact the repository maintainer directly via the email listed on their GitHub profile if that mailbox isn't yet set up).

Include:

- A description of the vulnerability
- Steps to reproduce
- Affected versions / commit SHA
- Impact assessment (what an attacker can do)
- Any suggested mitigation if you have one

We aim to acknowledge security reports within **3 business days** and provide an initial assessment within **7 days**.

## Supported versions

OneStreamer is single-tenant and uses rolling deployment from `main`. There are no maintained release branches.

- **The latest commit on `main`** is the supported version. Fixes are applied there and deployed to production.
- Pinned tagged releases (`v0.x.y`) exist as historical markers but are not separately maintained — upgrade to current `main` to get fixes.

## Scope

In scope for security reports:

- Authentication bypass (signup, login, OAuth, JWT handling)
- Authorization issues (unauthorized access to admin / moderator capabilities, cross-user data access)
- Server-side credential or secret exposure
- Stored or reflected XSS in the React client
- Server-side request forgery (SSRF) via user-controlled URLs (e.g. soundboard URL, URL-stream ingest)
- Injection issues (SQL, command, path traversal)
- WebRTC / MediaSoup-layer exploits that allow stream interception or cross-stream data leakage
- Denial-of-service vulnerabilities that go beyond what Cloudflare / standard rate-limiting can absorb
- Significant privacy issues (exposure of user emails, password hashes, or stream content)

Out of scope:

- Standard cloud-provider risks for the operator's chosen host
- Issues that require attacker control over the operator's `.env` file or host
- Bugs in `whisper.cpp`, MediaSoup, LiveKit, Strapi, Ollama, or other upstream dependencies — report those upstream
- Self-XSS or social-engineering scenarios
- Missing security headers that aren't critical (we set the standard ones — see [`/docs/security/threat-model.md`](docs/security/threat-model.md))

## Known issues

The threat model ([`/docs/security/threat-model.md`](docs/security/threat-model.md)) documents known gaps as they're recognized — including, currently:

- **TURN HMAC secret currently shipped to clients** in the bundled JS. Architectural fix proposed (server-side credential signing) — see the threat-model "Known gaps" section.
- **Default fallback values for `JWT_SECRET` / `SESSION_SECRET`** in source code. Operators must override in production; the fallbacks are footguns.
- **Default `LIVEKIT_API_KEY=devkey`** in the LiveKit installation. Dormant infrastructure, but rotation is still recommended.

The secret-rotation runbook ([`/docs/operations/runbooks/secret-rotation.md`](docs/operations/runbooks/secret-rotation.md)) covers the fix for each.

## Disclosure

We follow **coordinated disclosure**:

- We will not publicly disclose the vulnerability or your report until a fix is deployed.
- We will credit you in the fix's commit message and changelog entry unless you prefer otherwise.
- We ask that you give us reasonable time to remediate before any public disclosure on your end (typically 90 days, negotiable based on severity).

## Auth + crypto choices

For reference (full detail in [`/docs/security/auth-flows.md`](docs/security/auth-flows.md)):

- Passwords: `bcrypt`
- Tokens: JWT (24h access, 7d refresh)
- Email verification + password reset: 24-hour single-use crypto-random tokens
- Account deletion confirmation: 24-hour token, 15-day grace period before hard purge
- CAPTCHA: Cloudflare Turnstile on signup, login, password reset, bug reports, first anonymous chat message
- TLS: Let's Encrypt via certbot; HSTS enabled

## Thank you

Security researchers who help keep OneStreamer safe are doing real work for real users. We appreciate it.
