# Local development

_Last verified: 2026-05-23 against commit 4a1d325._

Set up OneStreamer on a clean machine. The result is three Node.js services running locally, a SQLite DB, and a React dev server you can hit in a browser.

## What's actually running

| Process | Default port | Source | Purpose |
|---------|-------------:|--------|---------|
| Main server | `8080` (HTTP) / `8443` (HTTPS) | [`server/index.js`](../../server/index.js) | API, auth, streaming signaling, items, recording orchestration |
| Chat microservice | `8081` (HTTP) / `8444` (HTTPS) | [`chat-service/index.js`](../../chat-service/index.js) | Real-time chat, voting, claim codes |
| React client | `3000` (HTTP) / `3443` (HTTPS) | [`client/`](../../client/) | The browser app (CRA dev server) |

Optional companions:
- **Ollama** on `:11434` for AI chatbots (see [`/docs/integrations/ollama-and-groq.md`](../integrations/ollama-and-groq.md))
- **MediaSoup UDP range** `50000–50199` for WebRTC media transport
- **LiveKit** on `:7882` — only needed if you're working on the dormant LiveKit code paths

## Prerequisites

- Node.js **18+** and npm
- A modern Chrome/Firefox/Safari for browser testing
- `ffmpeg` (`apt install ffmpeg` / `brew install ffmpeg`) — required for VisualFX, recording, transcription
- `gstreamer1.0-tools` + plugins (Linux: `apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad,ugly}`) — required for the Plain RTP viewbot pipeline
- Build tools for `whisper.cpp`: `gcc`, `make`, `cmake` (skip if you don't need transcription)
- (Optional) Ollama: download from [ollama.ai](https://ollama.ai), then `ollama pull mistral`

## Install

```bash
git clone https://github.com/onestreamer/onestreamer.git
cd onestreamer

# Three Node packages — install all
npm install                          # root (main server deps)
cd client && npm install && cd ..
cd chat-service && npm install && cd ..

# Or use the bundled convenience script
npm run install-all
```

## Environment

Three `.env` files, one per Node package. Each `.env.example` is the template.

```bash
cp .env.example .env
cp server/.env.example server/.env
# chat-service inherits CLIENT_URL / MAIN_SERVER_URL via the convenience scripts;
# its own .env is optional and minimal.
```

At minimum, set these in `/.env` (root):

```bash
# Server URL exposed to clients
CLIENT_URL=https://localhost:3443

# JWT signing — generate a real random value, do NOT use the .env.example default
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")

# Cloudflare Turnstile — use the always-passes test keys for local dev
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
# (Set REACT_APP_TURNSTILE_SITE_KEY=1x00000000000000000000AA in client/.env)
```

For any external service you want to actually exercise (Google OAuth, Twitch, Backblaze B2, SendGrid, Cloudflare Turnstile real keys), see [`environment-variables.md`](environment-variables.md) for the full table.

## TLS certificates (for HTTPS dev)

WebRTC requires HTTPS for `getUserMedia` to work. Generate self-signed certs once:

```bash
mkdir -p certificates && cd certificates
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=Local/L=Local/O=OneStreamer/CN=localhost"
# Make duplicates for the React dev server (it reads different filenames)
cp cert.pem react-cert.pem
cp key.pem react-key.pem
cd ..
```

In your browser, you'll need to accept the self-signed certificate at `https://localhost:3443` (the React dev server), `https://localhost:8443` (main API), and `https://localhost:8444` (chat). The simplest pattern: visit each origin once before testing.

## Database

SQLite, file lives at `server/data/onestreamer.db`. The schema is created on first boot; migrations are in `server/migrations/` and run manually if needed:

```bash
node server/migrations/setup-transcription-tables.js
node server/migrations/setup-clips-tables.js
# ... etc — each migration is a self-contained script
```

## Run

```bash
# All three processes concurrently
npm run dev
```

This runs:
- `nodemon server/index.js` (auto-restart on changes)
- `cd client && npm start` (CRA dev server with hot reload)
- `cd chat-service && npm run dev` (chat with nodemon)

Other run shapes:

```bash
npm run dev-no-chat       # main + client; skip chat
npm run dev-with-chat     # same as `dev`
npm run server            # main only
npm run client            # client only
npm run chat              # chat only
```

For production-shaped local runs, use PM2 with the existing ecosystem config:

```bash
pm2 start ecosystem.config.js
pm2 logs            # tail all three
pm2 stop all
```

## Verify

1. Open `https://localhost:3443`. The OneStreamer UI should load.
2. Click **Sign Up** (Cloudflare test keys mean the CAPTCHA auto-passes). Create a user.
3. Click **Start Streaming** → allow camera/mic.
4. Open a second browser (different profile or incognito) at `https://localhost:3443`. You should see your stream playing.
5. Chat in the second window — message should appear in the first.

Probe endpoints:

```bash
curl -sk https://localhost:8443/health     # main server
curl -sk https://localhost:8444/health     # chat service
curl -sk https://localhost:8443/api/clips/status   # clips subsystem
```

## Common issues

| Symptom | Fix |
|---------|-----|
| `EADDRINUSE` on 8080 / 8443 | Kill the previous Node: `lsof -ti:8443 | xargs kill -9`. Or change `PORT` / `HTTPS_PORT` in `.env`. |
| Camera permission denied silently | Ensure you're on `https://` not `http://`. Re-accept the cert. |
| Chat shows "disconnected" | Chat-service not running — `cd chat-service && npm run dev` separately. |
| `whisper.cpp/main` not found | Run `node setup-whisper.js` (compiles + downloads models). Or skip if you don't need transcription — set `enableTranscription: false`. |
| Turnstile widget blocks signup | Use the test site key (`1x00000000000000000000AA`) in `client/.env`, restart the client. |
| MediaSoup binds fail | UDP `50000–50199` may be in use by another app. Adjust `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` in `.env`. |

## What to do next

- [`first-stream.md`](first-stream.md) — full end-to-end walkthrough (signup → take over → broadcast → watch)
- [`environment-variables.md`](environment-variables.md) — the complete env-var reference
- [`/docs/architecture/overview.md`](../architecture/overview.md) — read this if you want to understand the system before changing things
- [`/docs/contributing/`](../contributing/) — branching, commits, tests, the PR template
