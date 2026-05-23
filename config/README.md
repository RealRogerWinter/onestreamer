# `config/` — sanitized per-deploy config templates

Each `*.example.*` file here is a reference template for a per-deploy config that lives outside version control. Copy + edit + save to wherever the consuming tool reads it from (typically the repo root or a system path), then exclude the real file from git.

| File | Real path expected | Consumed by |
|------|--------------------|-------------|
| `livekit-config.example.yaml` | `./livekit-config.yaml` (root, gitignored) | LiveKit server (`livekit-server -config`) — dormant per [ADR-0002](../docs/architecture/adr/0002-mediasoup-primary-livekit-dormant.md) |
| `livekit-ssl.example.yaml` | `./livekit-ssl.yaml` (root, gitignored) | LiveKit server's TLS-only profile — dormant |
| `viewbot-rotation-config.example.json` | `./viewbot-rotation-config.json` (root, gitignored) | `server/services/ViewBotClientService.js` |
| `youtube-cookies.example.txt` | `./youtube-cookies.txt` (root, gitignored) — or wherever `YOUTUBE_COOKIES_PATH` env points (see #22) | `server/services/URLStreamExtractorService.js` for YouTube ingress |

## Convention

- All files in this directory are tracked.
- All per-deploy "real" counterparts live outside this directory (typically repo root) and are gitignored.
- Sanitization: every literal that varies per deploy (domain, IP, API key, cert path) must be a `YOUR_X` placeholder, never a real value.
- Adding a new example: place it as `<name>.example.<ext>` here and add the matching ignore rule + an entry to the table above.

This convention was introduced in PR-T as part of the open-source preparation sequence. Earlier PRs (PR-B, PR-C, PR-S) created the example files at the repo root; PR-T moved them all here for first-clone clarity.
