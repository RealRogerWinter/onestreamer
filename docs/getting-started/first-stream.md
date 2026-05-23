# Your first stream

_Last verified: 2026-05-23 against commit 4a1d325._

A 15-minute walkthrough from "I just got it running locally" to "I'm watching my own stream from a second browser." This confirms the entire happy path is wired correctly.

## Prerequisites

You have OneStreamer running locally per [`local-dev.md`](local-dev.md):

- `https://localhost:3443` loads the React UI in a browser
- `https://localhost:8443/health` returns JSON
- `https://localhost:8444/health` returns JSON
- You've accepted the self-signed cert at all three origins

If any of those fail, fix that first — the walkthrough below assumes a working baseline.

## 1. Create an account

Two paths. Pick one.

### Email + password (recommended for first run)

1. Click **Sign Up** in the header.
2. Enter an email, a username, and a password (≥ 8 chars).
3. The Cloudflare Turnstile widget should auto-pass — you're using the test site key `1x00000000000000000000AA` per the [local dev setup](local-dev.md).
4. Click Sign Up. You should be auto-logged-in.
5. **Check your console** (not actual email — in local dev with no SMTP configured, the verification email is logged to the server stdout): look at `pm2 logs onestreamer-server` or your `npm run dev` output for a line like `📧 Verification email for <you@example.com>: https://localhost:3443/verify-email/<token>`.
6. Visit that link. The account is now email-verified.

### Google OAuth (skip for first run unless you've configured Google credentials)

Requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set in `.env` and a Google OAuth client with `https://localhost:3443/auth/success` whitelisted. If you haven't set those up, use email+password instead.

## 2. Take over the stream

If nobody else is streaming locally (likely — you just started everything):

1. Click **Start Streaming** in the bottom toolbar.
2. Your browser prompts for camera + microphone permission. Click **Allow**.
3. Server-side, you'll see a chain of socket events in `pm2 logs onestreamer-server`:
   - `request-to-stream` → server checks cooldowns (clean in dev) → `streaming-approved`
   - `mediasoup:get-rtp-capabilities` → `mediasoup:create-send-transport` → `mediasoup:connect-transport` → `mediasoup:produce` (twice — once for audio, once for video)
   - `stream-ready` then `stream-started` broadcast to all viewers
4. Your camera preview should appear in the main video area.
5. Above the preview: an audio-level meter ([`AudioLevelMeter.tsx`](../../client/src/components/AudioLevelMeter.tsx)). Speak — the bar should move.

If the preview stays black: open DevTools → Console. Look for `getUserMedia` errors or MediaSoup transport failures. The [`stream-stuck.md`](../operations/runbooks/stream-stuck.md) runbook covers most of the common causes.

## 3. Watch your own stream from a second browser

The whole point of the platform is "another user can see what I'm broadcasting." Verify that locally:

1. Open a **second browser** (different profile, or use an incognito window — *not* a second tab in the same profile, because Socket.IO will use the same socket).
2. Navigate to `https://localhost:3443`. Accept the cert.
3. You should see your own stream in the second browser. Audio-video sync will feel slightly off (~300 ms) — that's the known A/V sync issue, see the warning banner in [`/docs/architecture/streaming-stack.md`](../architecture/streaming-stack.md).
4. The viewer count in the streamer browser should now read **1**.
5. Wave your hand in front of the camera — both browsers should see it move (~300–500 ms apart due to encoding + network buffer).

## 4. Send a chat message

In the second (viewer) browser:

1. Click the chat panel (right side on desktop, bottom on mobile).
2. Type a message and press Enter. If you're not logged in in the second browser, Turnstile may pop up — auto-passes with the test key.
3. The message appears in both browsers' chat panels almost instantly.

Logged-in users keep their username/color across sessions. Anonymous users get an animal username (`Tiger4231` style) that's randomized per session.

## 5. Earn points + buy an item

While streaming, you're earning points at **10/minute**. Watch the points counter in the header tick up. After a minute or two:

1. Click the **Shop** button in the inventory panel.
2. The shop is empty by default in a fresh dev DB. As an admin (which you are, if you're the first user — typically the first account auto-elevates; if not, run `sqlite3 server/data/onestreamer.db "UPDATE users SET is_admin = 1 WHERE id = 1;"` and restart the server).
3. Open the admin panel (click the admin icon in the header) → **Items & Shop** tab.
4. Click **Create item**. Fill in something like: name `test-confetti`, display name `Test Confetti`, emoji 🎊, type `utility`, base price 5, cooldown 30 s. Save.
5. Go back to the Shop. Buy your item.
6. Open the Inventory. Click **Use** on your test confetti.

Depending on what `effect_data` you configured, you should see something on the stream — at minimum, a system message in chat saying you used the item.

## 6. Take a clip (if recording is on)

If [`ContinuousRecordingService`](../../server/services/ContinuousRecordingService.js) is enabled (default in dev), the stream is being recorded.

1. After streaming for ~30 seconds, the rolling buffer is long enough for clip extraction.
2. Probe: `curl -sk https://localhost:8443/api/clips/status` → should return `available: true, isRecording: true`.
3. In the React UI, find the **Create clip** button in the player controls.
4. Pick a duration (30–120 s), enter title, click Create.
5. After processing (a few seconds), the clip appears in `clips/videos/` on disk.
6. The Clips Gallery (link in the chat header) lists it.

## 7. Stop the stream

Click **Stop Broadcasting** in the streamer toolbar. The second browser should see `stream-ended` and the video disappear. The global cooldown begins (1 second in dev; 30 in production).

## What just happened

You've exercised most of the core stack:

- **Auth** — JWT-based session + Turnstile + email verification
- **WebRTC streaming** — full MediaSoup signaling handshake + producer/consumer media path
- **Chat** — separate socket to the chat-service, message broadcast, animal-username assignment
- **Points + items** — earning, spending, shop CRUD via admin panel, item usage
- **Recording + clips** — continuous recording, segment buffer, extraction
- **Cooldowns** — global cooldown enforcement on takeover

The pieces you *haven't* touched yet from this walkthrough: takeover handshake (open a third browser, sign up, try **Start Streaming** while you're already streaming in another tab), visual effects, AI chatbots, transcription, the multiplayer game, viewbot rotation, voting commands. Each of those is documented separately under [`/docs/features/`](../features/).

## When something doesn't work

- **Stream preview stays black** → [`stream-stuck.md`](../operations/runbooks/stream-stuck.md)
- **Recording isn't producing segments** → [`recording-upload-failed.md`](../operations/runbooks/recording-upload-failed.md) (covers both upload and capture)
- **Chat shows "disconnected"** → check `pm2 logs onestreamer-chat` (or `npm run chat` output); confirm port 8444 is listening
- **Turnstile blocks signup** → confirm you set `1x00000000000000000000AA` as the site key and `1x0000000000000000000000000000000AA` as the secret key in `.env`
- **MediaSoup transport errors** → confirm UDP 50000–50199 aren't blocked by your OS firewall

## What to do next

- [`/docs/architecture/overview.md`](../architecture/overview.md) — understand the system before changing things
- [`/docs/contributing/`](../contributing/) — coding conventions, branching, PR template
- [`/docs/features/`](../features/) — pick a feature to deep-dive
