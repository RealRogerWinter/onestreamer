# Cloudflare Turnstile

_Last verified: 2026-05-23 against commit 4a1d325._

CAPTCHA middleware that gates signup, login, password reset, bug-report submission, and the first chat message from anonymous users. Replaces the older "type the wavy letters" pattern with a frictionless background challenge.

## Where it protects

| Form | File |
|------|------|
| User registration | [`client/src/components/Signup.tsx`](../../client/src/components/Signup.tsx) |
| User login | [`client/src/components/Login.tsx`](../../client/src/components/Login.tsx) |
| Password reset | [`client/src/components/Login.tsx`](../../client/src/components/Login.tsx) (same modal) |
| Bug-report submission | [`client/src/components/BugReportModal.tsx`](../../client/src/components/BugReportModal.tsx) |
| First anonymous chat message | [`client/src/components/Chat.tsx`](../../client/src/components/Chat.tsx) |

Protected server endpoints:
- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/forgot-password`
- `POST /api/bug-reports`

## Configuration

Two keys, both per-site, from the Cloudflare Turnstile dashboard:

| Key | Where | Env var |
|-----|-------|---------|
| **Site key** (public — embedded in HTML by design) | `client/.env` | `REACT_APP_TURNSTILE_SITE_KEY` |
| **Secret key** (server-side; never publish) | `.env` (root) | `TURNSTILE_SECRET_KEY` |

> [!IMPORTANT]
> The current code in [`server/middleware/turnstile.js`](../../server/middleware/turnstile.js) and [`client/src/config/turnstile.ts`](../../client/src/config/turnstile.ts) has hardcoded **fallback values** that should be treated as test-only. Production must set both env vars explicitly. Remove the fallbacks in code to fail-fast rather than silently using the wrong secret. See [`docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).

### Cloudflare test keys (use during local dev, not in prod)

| Behaviour | Site key | Secret key |
|-----------|----------|------------|
| Always passes | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| Always fails | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AB` |
| Always challenges | `3x00000000000000000000FF` | `3x0000000000000000000000000000000FF` |

## Implementation

### Client

[`CloudflareTurnstile.tsx`](../../client/src/components/CloudflareTurnstile.tsx) is a thin React wrapper around Cloudflare's Turnstile widget script. It handles token generation, expiration (~5 minute TTL), theme, and error callbacks. The token is passed to the server alongside the form body in `turnstileToken` (request body) or `cf-turnstile-response` (header).

### Server

[`server/middleware/turnstile.js`](../../server/middleware/turnstile.js) exports:

- `verifyTurnstile(required: boolean)` — middleware factory.
- `requireTurnstile` — `verifyTurnstile(true)` convenience export.
- `optionalTurnstile` — `verifyTurnstile(false)` convenience export.

It verifies the token against `https://challenges.cloudflare.com/turnstile/v0/siteverify`, posts the form-encoded `secret` + `response` + `remoteip`, and maps Cloudflare error codes to user-friendly messages. If Cloudflare's API is unreachable, behavior depends on the `required` flag: fail closed (503) if required, fail open (proceed) if optional.

## Operational notes

- **Token expiry**: tokens are rejected if older than 5 minutes. If a user lingers on the signup form, they'll need to re-challenge.
- **Proxy IP handling**: middleware extracts the first IP from `X-Forwarded-For` for the `remoteip` field.
- **Monitoring**: failed verifications log to stderr; review server logs (`/root/onestreamer/logs/server-error.log`) for spikes.
- **Cloudflare analytics dashboard** at the Turnstile site shows challenge volume, pass rate, and challenge-type breakdown.

## Common errors

| Error | Cause |
|-------|-------|
| "Security verification required" | Token not provided in request |
| "Security token expired" | Token older than 5 minutes |
| "Invalid security token" | Token failed Cloudflare validation (replay, wrong secret) |
| "Security verification service unavailable" | Cloudflare API unreachable |

## See also

- [`docs/security/auth-flows.md`](../security/auth-flows.md) — how Turnstile fits into the auth handshake
- [`docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md) — how to rotate the secret key
