# Secret rotation

_Last verified: 2026-05-23 against commit 4a1d325._

Procedure for rotating any of the project's credentials. Use when a secret has leaked, a team member with access leaves, an annual hygiene rotation is due, or after a security incident.

## Pre-flight

1. **Confirm the rotation is needed.** Sometimes a key is exposed but not exploitable (e.g. a default value in an example file that prod overrides). Distinguish before paging yourself.
2. **Schedule.** Some rotations have user-visible side effects:
   - **`JWT_SECRET` rotation** logs out every user.
   - **TURN HMAC rotation** breaks active WebRTC sessions that are mid-TURN.
   - **Account-deletion-token signing change** invalidates any pending deletion confirmations.
3. **Inventory.** Run the grep patterns in the [Appendix](#appendix-grep-patterns) below to confirm you know every place the secret lives.
4. **Decide rotation strategy.** Two options:
   - **In-place** — brief downtime / user impact; simplest.
   - **Rolling** (two-key) — accept both old and new for a transition window; more complex but seamless. OneStreamer's code doesn't natively support two-key acceptance for most secrets; you'd need a code change first.

## Per-provider procedures

### SendGrid (transactional email)

1. **Revoke** the old key: SendGrid dashboard → Settings → API Keys → find the OneStreamer key → Delete.
2. **Generate** a new one with `Mail Send` scope (or `Full Access` if you also use the API outside email).
3. **Edit `.env`** (and `server/.env` if it mirrors): `SMTP_PASS=<new-value>`.
4. **Remove `SMTP_PASS` from `config/ecosystem.config.js`** if it was hardcoded there. Source the value from `.env` instead.
5. **Restart**:
   ```bash
   pm2 restart onestreamer-server --update-env
   pm2 env onestreamer-server | grep SMTP_PASS    # confirm new value loaded
   ```
6. **Verify**: trigger a verification email (sign up a test user or use `POST /auth/resend-verification` for an existing one) and confirm delivery.

### Cloudflare Turnstile

1. **Rotate site key**: Cloudflare dashboard → Turnstile → your site → Rotate site key. (You may also choose to rotate the secret independently.)
2. **Update `client/.env`**: `REACT_APP_TURNSTILE_SITE_KEY=<new-site-key>`.
3. **Update `.env`**: `TURNSTILE_SECRET_KEY=<new-secret-key>`.
4. **Rebuild the React client** (the site key is baked at build time):
   ```bash
   cd /root/onestreamer/client && npm run build && cd ..
   ```
5. **Remove hardcoded fallbacks**:
   - `server/middleware/turnstile.js` line ~4 → replace `process.env.TURNSTILE_SECRET_KEY || '0x4AAAA...'` with `process.env.TURNSTILE_SECRET_KEY` and a top-of-module guard that throws if unset.
   - `client/src/config/turnstile.ts` → same pattern with `REACT_APP_TURNSTILE_SITE_KEY` (site key can have a more permissive fallback since it's public).
6. **Restart**: `pm2 restart all --update-env`.
7. **Verify**: try a signup; confirm the widget renders and the form submission succeeds.

### Google OAuth

1. **Reset client secret**: Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 client → Reset Secret.
2. **Update `.env`**: `GOOGLE_CLIENT_SECRET=<new-value>`. `GOOGLE_CLIENT_ID` doesn't change.
3. **Restart**: `pm2 restart onestreamer-server --update-env`.
4. **Verify**: open an incognito browser, click Google sign-in, complete the flow.

### Twitch (random rotation API)

1. **New secret**: dev.twitch.tv → your application → "New Secret".
2. **Update `.env`**: `TWITCH_CLIENT_SECRET=<new-value>`.
3. **Restart**: `pm2 restart onestreamer-server --update-env`.
4. **Verify**:
   ```bash
   curl -X POST -H "x-admin-key: $ADMIN_KEY" \
     https://onestreamer.live/api/random-stream/rotate
   ```
   Should rotate to a new Twitch stream.

### Backblaze B2

1. **Add a new key** (don't revoke the old one yet): B2 dashboard → App Keys → Add New Application Key. Scope to your bucket with `readFiles, writeFiles, deleteFiles, listFiles`.
2. **Update `.env`**: `B2_APPLICATION_KEY_ID=<new-id>`, `B2_APPLICATION_KEY=<new-key>`. (`B2_BUCKET_ID` and `B2_BUCKET_NAME` only change if you changed the bucket.)
3. **Restart**: `pm2 restart onestreamer-server --update-env`.
4. **Verify**: trigger a recording (or wait for one) and watch `pm2 logs onestreamer-server | grep B2` for successful uploads.
5. **Revoke the old key** once you've seen new uploads succeed: B2 dashboard → App Keys → old key → Delete.

### LiveKit

1. **Edit LiveKit config** (`/etc/livekit/config.yaml`) — change the keys section:
   ```yaml
   keys:
     <new-api-key>: <new-api-secret>
   ```
2. **Restart LiveKit**: `sudo systemctl restart livekit`.
3. **Update OneStreamer's `.env`**: `LIVEKIT_API_KEY=<new>`, `LIVEKIT_API_SECRET=<new>`.
4. **Restart OneStreamer**: `pm2 restart onestreamer-server --update-env`.
5. **Verify**: only matters if LiveKit is actively used — see [`livekit-disconnect.md`](livekit-disconnect.md). For the currently-dormant case, just confirm the LiveKit server starts cleanly and that `pm2 env onestreamer-server | grep LIVEKIT_API` shows new values.

### coturn (TURN HMAC)

1. **Edit `/etc/turnserver.conf`**: change the `static-auth-secret` directive to a fresh random hex string (≥ 32 chars).
2. **Restart**: `sudo systemctl restart coturn`.
3. **Update OneStreamer's `.env`**: `TURN_SECRET=<new-value>`.
4. **Restart OneStreamer**: `pm2 restart onestreamer-server --update-env`.
5. **Confirm no hardcoded fallback remains in source.** PR #17 stripped the server-side fallbacks. PR #25 deleted the last leftover (`client/public/turn-test.html`). Verify:
   ```bash
   grep -rln "***REMOVED-TURN-SECRET***" \
     --include='*.js' --include='*.ts' --include='*.tsx' --include='*.html' . | grep -v node_modules
   ```
   Should return empty. If the secret appears anywhere, fix that first.
6. **Rebuild the client** so any old bundle on disk doesn't contain the previous secret:
   ```bash
   cd /root/onestreamer/client && npm run build && cd ..
   grep -lE "(<old-secret-prefix>|<new-secret>)" client/build/static/js/*.js
   ```
   Confirm the new bundle either has nothing or only the new (rotated) value.
7. **Architectural fix landed in PR #18**: the server-signed `GET /api/turn/credentials` endpoint issues short-lived (10-minute TTL) `username`/`credential` pairs; the client passes those into `RTCPeerConnection`'s `iceServers`. The HMAC is no longer shipped to clients. No further work needed here.

### JWT_SECRET (auth tokens)

> [!WARNING]
> **Rotating this logs out every user.** All issued JWTs become invalid immediately. Plan a maintenance window or communicate via chat before doing this.

1. **Generate a new value**:
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```
2. **Update `.env`**: `JWT_SECRET=<new-value>`. Confirm both the main server and the chat-service pick up the *same* new value (they share the secret).
3. **Remove the hardcoded fallback** in code:
   - `server/services/AuthService.js` line ~13
   - `chat-service/index.js` line ~238
   - `server/routes/auth.js` line ~725
   - `server/.env.example` (just the placeholder — keep but mark as "set in production")

   Pattern:
   ```js
   const JWT_SECRET = process.env.JWT_SECRET;
   if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in environment');
   ```
4. **Communicate the imminent logout** in chat:
   ```bash
   curl -X POST -H "x-admin-key: $ADMIN_KEY" \
     https://onestreamer.live/chat-api/system-message \
     -d '{"message":"Heads up — auth maintenance in 60s; you may be logged out and need to sign in again."}'
   ```
5. **Restart**: `pm2 restart all --update-env`.
6. **Verify**: clear browser localStorage, visit the site, sign in fresh.

### SESSION_SECRET

Same procedure as `JWT_SECRET`, in `server/index.js`. Lower blast radius than JWT (Express session is less critical to OneStreamer's auth flow since most of it is JWT-based).

### ADMIN_KEY (legacy admin endpoints)

1. **Generate a new value**: random 32+ characters.
2. **Update `.env`**: `ADMIN_KEY=<new-value>`.
3. **Restart**: `pm2 restart onestreamer-server --update-env`.
4. **Update any tooling** that uses the `x-admin-key` header with the old value (your local scripts, anyone else who had it).
5. **Verify**:
   ```bash
   curl -H "x-admin-key: <new-value>" https://onestreamer.live/admin/dashboard
   ```

## Verification (after any rotation)

```bash
# Confirm the running process actually has the new value
pm2 env onestreamer-server | grep <VAR>
pm2 env onestreamer-chat   | grep <VAR>

# Confirm no committed code still references the old value (replace with the literal old value)
sudo grep -rn "<old-value>" /root/onestreamer --include='*.js' --include='*.ts' --include='*.json' --include='*.md' \
  | grep -v node_modules | grep -v whisper.cpp | grep -v docs/archive

# Confirm the shipped client bundle is clean after rebuild
sudo grep -lE "<old-pattern>" /root/onestreamer/client/build/static/js/*.js
```

Then run a probe through the system:

- For SendGrid → trigger a verification email
- For Turnstile → walk through signup
- For Google OAuth → walk through Google sign-in
- For Twitch → trigger random rotation
- For B2 → wait for a recording segment upload
- For LiveKit → only if actively used (see [`livekit-disconnect.md`](livekit-disconnect.md))
- For TURN → connect from a mobile network and confirm the stream plays
- For JWT/Session → sign in fresh
- For ADMIN_KEY → hit `/admin/dashboard`

## Appendix: grep patterns

```bash
# SendGrid keys
sudo grep -rnE "SG\.[A-Za-z0-9_-]{20,}" /root/onestreamer \
  --include='*.js' --include='*.ts' --include='*.json' --include='*.md'

# JWT/Session default-fallback usage
sudo grep -rn "change-in-production" /root/onestreamer \
  --include='*.js' --include='*.ts'

# TURN HMAC literal (substitute the current/old value before running)
sudo grep -rn "<OLD_TURN_SECRET>" /root/onestreamer

# Turnstile secret literal (substitute the current/old value before running)
sudo grep -rn "<OLD_TURNSTILE_SECRET>" /root/onestreamer

# Any long-hex blob (catches forgotten constants)
sudo grep -rnE "[a-f0-9]{40,}" /root/onestreamer \
  --include='*.js' --include='*.ts' --include='*.json' \
  | grep -v node_modules | grep -v whisper

# Generic patterns (high false-positive rate)
sudo grep -rnE "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{12,}" /root/onestreamer \
  --include='*.js' --include='*.ts'

# Confirm shipped client bundle is clean
sudo grep -lE "(SG\.|87efe1ec|onestreamer-secret-key-change)" /root/onestreamer/client/build/static/js/*.js
```

## See also

- [`/docs/getting-started/environment-variables.md`](../../getting-started/environment-variables.md) — full env-var reference including the "footgun defaults" section
- [`/docs/integrations/`](../../integrations/) — per-provider notes
- [`/docs/security/threat-model.md`](../../security/threat-model.md) — what these secrets defend
