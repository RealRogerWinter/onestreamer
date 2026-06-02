# Integrations

One file per external dependency. Each covers: what it does, where it runs, credentials, and the code paths that talk to it.

| File | Integration |
|------|-------------|
| [`livekit.md`](livekit.md) | **The WebRTC backend** — streamer↔viewer, URL-relay ingress, recording egress, transcription capture ([ADR-0024](../architecture/adr/0024-retire-mediasoup-livekit-only.md)). |
| [`mediasoup.md`](mediasoup.md) | Retired predecessor backend (stub — see ADR-0024). |
| [`backblaze-b2.md`](backblaze-b2.md) | Recording + clip cloud storage (S3-compatible API). |
| [`google-oauth.md`](google-oauth.md) | Google sign-in via Passport. |
| [`cloudflare-turnstile.md`](cloudflare-turnstile.md) | CAPTCHA on signup, login, and some chat actions. |
| [`ollama-and-groq.md`](ollama-and-groq.md) | LLM providers for AI chatbots. |
| [`whisper.md`](whisper.md) | Local speech-to-text via `whisper.cpp`. |
| [`101soundboards.md`](101soundboards.md) | Sound effect playback in-stream. |
| [`twitch.md`](twitch.md) | Random stream rotation source. |
| [`kick.md`](kick.md) | Random stream rotation source (web-scrape via Python helper). |
| [`strapi.md`](strapi.md) | Blog CMS (server-side OG-meta injection only — React app is oblivious). |
| [`sendgrid.md`](sendgrid.md) | Outbound email (verification, password reset, deletion confirmation). |
