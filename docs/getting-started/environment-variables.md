# Environment variables

_Last verified: 2026-05-23 against commit 4a1d325._

The single source of truth for every environment variable OneStreamer reads. Defaults shown are what the code falls back to if the var is unset — **production should explicitly set every variable that has a default like `change-in-production` or `localhost`**.

There are three `.env` files in active use:

| File | Read by | Purpose |
|------|---------|---------|
| `/.env` | Main server + (some) chat-service vars | Most application config |
| `/server/.env` | Main server (overrides `/.env` for server-specific keys) | Auth secrets, third-party credentials |
| `/client/.env` | React build (CRA) | `REACT_APP_*` vars baked into the bundle at build time |

Plus the corresponding `.env.example` files in each location, which are tracked in git and serve as templates.

> [!IMPORTANT]
> **Generate every secret-shaped value at install time.** Do not use the literal defaults shown below — many of them appear in source code as fail-open fallbacks specifically so developers can boot a dev environment without a `.env`. Production should fail-fast if any required secret is unset. See [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).

---

## Required for production

These are not optional — without them, the corresponding feature is broken or insecure:

| Variable | Used by | Required for | Notes |
|----------|---------|--------------|-------|
| `JWT_SECRET` | Main + Chat | Auth (all token-gated routes) | Generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`. **Must match across main and chat services.** |
| `SESSION_SECRET` | Main | Express session middleware | Same generation pattern. |
| `TURNSTILE_SECRET_KEY` | Main | Signup, login, password reset, bug reports | From the Cloudflare Turnstile dashboard. |
| `REACT_APP_TURNSTILE_SITE_KEY` | Client | Renders the Turnstile widget in forms | Public; embedded in the React build. |
| `JSON ADMIN_KEY` | Main (legacy admin endpoints) | The `x-admin-key`-authed routes | Generate a random string; rotate if exposed. |

---

## Network + server

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Main server HTTP port |
| `HTTPS_PORT` | `8443` | Main server HTTPS port |
| `USE_HTTPS` | `false` | Toggle HTTPS on the main server |
| `CHAT_PORT` | `8081` | Chat-service HTTP port |
| `CHAT_HTTPS_PORT` | `8444` | Chat-service HTTPS port |
| `SERVER_HOST` | (empty) | Hostname for certificate / external URL construction |
| `CLIENT_URL` | `http://localhost:3000` | Where OAuth callbacks redirect to; the React app's public URL |
| `CHAT_SERVICE_URL` | `https://127.0.0.1:8444` | Main server's URL for HTTP callbacks to chat |
| `MAIN_SERVER_URL` | `https://127.0.0.1:8443` | Chat-service's URL for HTTP callbacks to main server |
| `VIEWBOT_SERVER_URL` | (same as main) | Viewbots' internal connection URL |
| `NODE_ENV` | (empty) | `production` or `development` |

---

## TLS certificates

| Variable | Used by | Purpose |
|----------|---------|---------|
| `SSL_CRT_FILE` | React dev server | Path to TLS cert (CRA dev server) |
| `SSL_KEY_FILE` | React dev server | Path to TLS key |

Production typically uses Let's Encrypt-issued certs in `/etc/letsencrypt/live/<domain>/`. See [`deployment.md`](../operations/deployment.md). WebRTC media DTLS is handled by the LiveKit server (configured in `livekit-config.yaml`), not by OneStreamer env vars.

---

## WebRTC backend

LiveKit is the sole WebRTC backend ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). The old `WEBRTC_BACKEND` / `USE_WEBRTC_ADAPTER` selector and every `MEDIASOUP_*` / `DTLS_*` variable were removed with MediaSoup — the backend is pinned to `livekit` in code ([`server/config/webrtc.config.js`](../../server/config/webrtc.config.js)) and there is no UDP `50000–50199` RTP range anymore. The RTC/ICE media ports are owned by the LiveKit server and configured in `livekit-config.yaml`, not by OneStreamer env vars — see the [LiveKit](#livekit-required) section below and [`/docs/integrations/livekit.md`](../integrations/livekit.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANNOUNCED_IP` | `<SERVER_IP>` (prod) | Public IP the TURN/ICE layer advertises ([`server/routes/turn.js`](../../server/routes/turn.js)). |

---

## TURN server (coturn)

| Variable | Used by | Purpose |
|----------|---------|---------|
| `TURN_DOMAIN` | Main + Client | TURN server hostname (e.g. `turn.onestreamer.live`) |
| `TURN_SECRET` | Main + Client | HMAC secret for time-limited TURN credentials |
| `TURN_USERNAME` | Main | Static TURN username (only if not using HMAC) |
| `TURN_CREDENTIAL` | Main | Static TURN credential (only if not using HMAC) |

> [!IMPORTANT]
> The TURN HMAC secret is currently hardcoded as a fallback in multiple source files (including client-side, where it ends up in the shipped React bundle visible to every browser visitor). This is a Tier-0 exposure — see [`secret-rotation.md`](../operations/runbooks/secret-rotation.md). The architecturally correct pattern is server-signed time-limited credentials per session.

---

## LiveKit (required) {#livekit-required}

LiveKit is the sole WebRTC backend ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)) — these back **every** live media path (streamer↔viewer, URL-relay ingress, recording egress, transcription). `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` are **required in production**; without valid credentials nobody can broadcast or watch.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LIVEKIT_HOST` | `http://127.0.0.1:7882` | LiveKit API URL |
| `LIVEKIT_API_KEY` | (unset) | API key — **required**; must match the key in `livekit-config.yaml` |
| `LIVEKIT_API_SECRET` | (unset) | API secret — **required**; must match the secret in `livekit-config.yaml` |
| `LIVEKIT_WS_URL` | `ws://localhost:7882` | WebSocket URL for client SDK |
| `LIVEKIT_ROOM_NAME` | `onestreamer-main` | Default room name |
| `LIVEKIT_MAX_PARTICIPANTS` | `1000` | Room cap |
| `LIVEKIT_EMPTY_TIMEOUT` | `300` | Room auto-close timeout (seconds) |
| `LIVEKIT_TURN_ENABLED` | `false` | Enable TURN inside LiveKit |
| `LIVEKIT_USE_FFMPEG_FALLBACK` | `false` | Fall back to ffmpeg if LiveKit ingress fails |

The dev defaults `devkey` / `secret` are well-known LiveKit values that the dev config ships with; the production server is reachable at `livekit.onestreamer.live`. **Set real credentials in production** and keep them in sync between `.env` and `livekit-config.yaml` (mismatched keys fail every connect with `unauthorized` — see [`livekit-disconnect.md`](../operations/runbooks/livekit-disconnect.md)).

---

## Backblaze B2 (recording + clip storage)

| Variable | Purpose |
|----------|---------|
| `B2_APPLICATION_KEY_ID` | B2 account key ID |
| `B2_APPLICATION_KEY` | B2 account secret |
| `B2_BUCKET_ID` | B2 bucket UUID |
| `B2_BUCKET_NAME` | B2 bucket name (also used in S3 endpoint construction) |
| `B2_ENDPOINT` | B2 S3-compatible endpoint URL (e.g. `s3.us-east-005.backblazeb2.com`) |
| `B2_STREAMING_ENABLED` | `true` to stream video directly from B2 signed URLs; `false` to serve from local disk only |

All required for recording/clip features. See [`/docs/integrations/backblaze-b2.md`](../integrations/backblaze-b2.md).

> **Keep all `B2_*` variables UNSET until an operator deliberately enables archival.** The upload-correctness blockers (audit R5/R6/R11) are fixed ([ADR-0034](../architecture/adr/0034-b2-upload-ordering-multipart-timeouts.md)), but enablement is a separate operational decision: local retention is still coupled to upload state until Plan 01 P2.1 lands, and first enablement will churn the legacy backlog through `upload_failed` (expected). With the vars unset the whole archival subsystem is dormant.

---

## Email (SendGrid SMTP via nodemailer)

| Variable | Example | Purpose |
|----------|---------|---------|
| `SMTP_HOST` | `smtp.sendgrid.net` | SMTP server |
| `SMTP_PORT` | `587` | SMTP port (usually 587 for STARTTLS, 465 for SMTPS) |
| `SMTP_USER` | `apikey` (for SendGrid) | SMTP username |
| `SMTP_PASS` | `SG.xxx...` | SMTP password / SendGrid API key |
| `SMTP_SECURE` | `false` | `true` to use TLS from connect (port 465); `false` to STARTTLS (587) |
| `FROM_EMAIL` | `noreply@onestreamer.live` | Sender address |

If unset, [`EmailService`](../../server/services/EmailService.js) falls back to logging emails to stdout — useful in dev, useless in production.

---

## Authentication providers

### Google OAuth

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | OAuth client ID from console.cloud.google.com |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |

Callback URL is hardcoded to `${CLIENT_URL}/auth/google/callback`. Add that URL to your OAuth client's whitelist.

### Twitch (for random stream rotation)

| Variable | Purpose |
|----------|---------|
| `TWITCH_CLIENT_ID` | App ID from dev.twitch.tv |
| `TWITCH_CLIENT_SECRET` | App secret |

Uses OAuth 2.0 client credentials grant for the Helix API. See [`/docs/integrations/twitch.md`](../integrations/twitch.md).

---

## AI providers

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_HOST` | `http://localhost:11434` | Local Ollama server URL |
| `OLLAMA_MODEL` | `mistral` | Default model name |
| `OLLAMA_TIMEOUT_MS` | `60000` | Hard deadline per Ollama chat call; queued requests older than 2× this are dropped with a fallback response (audit A6) |
| `GROQ_API_KEY` | (empty) | Groq cloud LLM API key. Optional fallback. |
| `WHISPER_TIMEOUT_FLOOR_MS` | `20000` | Minimum whisper.cpp watchdog timeout per transcription run |
| `WHISPER_TIMEOUT_PER_SEC_MS` | `1500` | Watchdog ms per second of input audio: `timeout = max(floor, duration × this)` |
| `WHISPER_MAX_CONCURRENT` | `2` | Max concurrent whisper.cpp child processes; excess runs queue FIFO |
| `GROQ_TIMEOUT_MS` | `30000` | Abort deadline for every Groq API fetch (audit A6) |

Both optional. If neither is reachable, [`ChatBotLLMService`](../../server/services/ChatBotLLMService.js) uses a canned response set.

The Groq key can also be stored at runtime via `POST /admin/groq/config` — the DB row `groq_config.api_key` is the single source of truth for the stored key (the legacy `moviebot_config.groq_api_key` column is migrated into it once and never written again).

---

## Cooldowns + rate limits

| Variable | Default | Purpose |
|----------|---------|---------|
| `GLOBAL_COOLDOWN_SECONDS` | `30` (prod), `1` (dev) | Cooldown after any stream change |
| `INDIVIDUAL_COOLDOWN_SECONDS` | `60` (prod), `1` (dev) | Cooldown after a user is taken over |
| `COOLDOWN_SECONDS` | `30` | (Legacy alias) |

---

## Viewbot configuration

| Variable | Purpose |
|----------|---------|
| `VIEWBOT_COOLDOWN` | Per-bot action cooldown |
| `VIEWBOT_MIN_INTERVAL` | Min rotation interval (ms) |
| `VIEWBOT_MAX_INTERVAL` | Max rotation interval (ms) |
| `VIEWBOT_ROTATION_ENABLED` | Master switch for rotation |

---

## Redis (optional cache)

| Variable | Purpose |
|----------|---------|
| `REDIS_URL` | Connection string (preferred) |
| `REDIS_HOST` | (Legacy) hostname |
| `REDIS_PORT` | (Legacy) port |
| `REDIS_PASSWORD` | (Legacy) password |

If unset, the [`TakeoverService`](../../server/services/TakeoverService.js) (the main Redis consumer) falls back to an in-memory store. Redis becomes important only if you ever shard to multiple hosts (not currently a supported topology).

---

## Misc / observability

| Variable | Purpose |
|----------|---------|
| `ENABLE_METRICS` | Enable detailed metrics collection |
| `STATS_INTERVAL` | Metrics reporting interval (ms, default `5000`) |
| `ENABLE_WEBRTC_LOGGING` | Verbose WebRTC debug logs |

---

## React build-time variables (`REACT_APP_*`)

Baked into the React production bundle at build time. **These are visible to every browser visitor** — never put a secret in a `REACT_APP_*` var.

| Variable | Default | Purpose |
|----------|---------|---------|
| `REACT_APP_API_URL` | `https://onestreamer.live` | Main server URL |
| `REACT_APP_SERVER_URL` | `https://onestreamer.live` | Socket.IO server URL |
| `REACT_APP_CHAT_SERVER_URL` | `https://onestreamer.live` | Chat-service URL |
| `REACT_APP_TURNSTILE_SITE_KEY` | (hardcoded fallback) | Cloudflare Turnstile site key (public by design) |

---

## CRA quirks

| Variable | Purpose |
|----------|---------|
| `HTTPS` | `true` to serve the React dev server over HTTPS |
| `HOST` | `0.0.0.0` to bind dev server on all interfaces |
| `WDS_SOCKET_HOST` | WebSocket Dev Server host (for hot reload) |
| `WDS_SOCKET_PORT` | WDS port |
| `DANGEROUSLY_DISABLE_HOST_CHECK` | `true` for dev convenience (do not use in prod) |

---

## Required secrets — no source-tree fallbacks

The server fails fast at startup (and chat-service refuses to boot) if any of these is missing. There are no hardcoded defaults in code; set real values in `.env` before running.

| Variable | What it gates | How to generate / source |
|----------|---------------|--------------------------|
| `JWT_SECRET` | Token signing for both main server and chat-service (must match between them). | `openssl rand -base64 48` |
| `SESSION_SECRET` | Express session cookie signing. | `openssl rand -base64 48` |
| `TURNSTILE_SECRET_KEY` | Server-side Cloudflare Turnstile verification. | Cloudflare dashboard → Turnstile → site → Secret Key. |
| `TURN_SECRET` | coturn `static-auth-secret`; main server mints time-limited TURN credentials with it. | Must match `static-auth-secret` in `/etc/turnserver.conf`. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | All live media — LiveKit is the sole WebRTC backend ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)); streamer↔viewer, URL-relay ingress, recording egress, and transcription all need these. Must match the keys in `livekit-config.yaml`. | LiveKit server config. |
| `SMTP_PASS` | SendGrid API key (read as the SMTP password). Required for verification + reset emails. | SendGrid → Settings → API Keys. |

Generate fresh values for every deploy. Rotate any time you suspect leakage. See [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md) for the full rotation procedure.

> **Historical note.** Earlier versions of this repo shipped each of these with a hardcoded fallback in source. Those fallbacks have been removed in code, but they remain in git history through commit `b4cb5d2`. Treat any of those historical values as compromised — even after this commit, anyone who cloned the repo before the cleanup has them.

## See also

- [`local-dev.md`](local-dev.md) — initial dev setup with minimal env vars
- [`/docs/operations/deployment.md`](../operations/deployment.md) — production env-var sourcing
- [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md) — how to rotate any of these
- [`/docs/integrations/`](../integrations/) — per-provider documentation including their env vars
