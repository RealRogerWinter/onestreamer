# Kick

_Last verified: 2026-05-23 against commit 4a1d325._

Random-stream-rotation discovery for [Kick](https://kick.com) — the Twitch competitor. Unlike Twitch, Kick doesn't offer a public API for server-side stream discovery (the public Kick API is heavily bot-detected). OneStreamer scrapes the public live-category pages via a **Python helper** using [`curl_cffi`](https://github.com/lwthiker/curl_cffi) to bypass the bot detection.

## What it gives the platform

- Random live Kick streams for the rotation system to play, alongside Twitch
- Same filter rules as Twitch (viewer range, blocked categories, recent-cache)

## How it works

[`KickRandomService`](../../server/services/KickRandomService.js) spawns a Python subprocess:

```bash
python3 server/services/kick-api-helper.py live-streams --max-results 50
```

The Python script:

1. Uses `curl_cffi` to issue requests that look like a real browser (matching TLS fingerprints, headers, etc.) — needed because Kick's anti-bot filtering rejects naïve `requests`/`httpx` traffic.
2. Fetches Kick's live category pages.
3. Parses the HTML to extract live streamers and their metadata.
4. Returns JSON to stdout for the Node service to consume.

OneStreamer then applies the same filtering rules (viewer-range, blocked categories, recent-cache) and picks a channel for the viewbot fleet to ingest.

## Setup

### Python environment

```bash
# System Python 3.8+ required
python3 --version

# Install curl_cffi
pip3 install curl_cffi

# Confirm
python3 -c "import curl_cffi; print(curl_cffi.__version__)"
```

If `curl_cffi` isn't installed, every Kick rotation attempt fails with `ModuleNotFoundError`. This is a hard dependency that **isn't tracked in `package.json`** because it's Python — it must be installed system-wide or in a venv that the Node process can reach.

### Test the helper manually

```bash
cd /root/onestreamer
python3 server/services/kick-api-helper.py live-streams --max-results 5
# Expect JSON output with 5 stream entries
```

If this returns an empty list or an error, Kick may have changed its page structure or strengthened bot detection. The helper script needs updating.

## No env vars needed

Kick doesn't require API credentials. The scrape works against publicly-accessible pages. (Bot detection is per-request, not per-account.)

## Code paths

| Concern | File |
|---------|------|
| Node service | [`server/services/KickRandomService.js`](../../server/services/KickRandomService.js) |
| Python helper | [`server/services/kick-api-helper.py`](../../server/services/kick-api-helper.py) |
| Rotation orchestrator | [`server/services/RandomStreamRotationService.js`](../../server/services/RandomStreamRotationService.js) |
| Stream URL extraction (Kick HLS playlist resolution) | [`server/services/URLStreamExtractorService.js`](../../server/services/URLStreamExtractorService.js) |
| API endpoints | [`server/routes/random-stream.js`](../../server/routes/random-stream.js) |

## Operational notes

- **Bot detection is an arms race.** Kick may strengthen detection at any time. The Python helper has worked since it was written, but a future Kick update could break it without warning. Have a fallback plan (disable Kick rotation, use Twitch-only).
- **No rate limits to formally respect**, but be considerate — the helper polls every rotation interval, not continuously. Don't tighten the interval below ~30 seconds.
- **The Python subprocess adds latency** — each Kick rotation spawns a fresh Python interpreter (slow). If this becomes a bottleneck, consider running the helper as a long-lived daemon and using IPC.
- **`curl_cffi` updates may break the fingerprint mimicry.** Pin the version if you want stability, or update when Kick changes its detection.

## Triggering rotation manually

Same endpoints as Twitch — see [`twitch.md`](twitch.md). The rotation orchestrator interleaves Twitch and Kick sources automatically.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `ModuleNotFoundError: No module named 'curl_cffi'` | `pip3 install curl_cffi` |
| Empty stream list | Run the helper manually with verbose flags. Kick may have restructured pages, or detection caught the request. |
| `403 Forbidden` from Kick | Bot detection tripped. May resolve itself; may require updating `curl_cffi` or the helper's fingerprint. |
| Slow rotation (seconds per pick) | Expected with Python subprocess spawn cost. If consistently >10 s, look at network latency to Kick. |
| Rotation never selects Kick streams | Confirm `KickRandomService` is wired in `RandomStreamRotationService` and the source-mix weight is set. |

## See also

- [`twitch.md`](twitch.md) — the API-based equivalent
- [`/docs/features/external-sources-twitch-kick.md`](../features/external-sources-twitch-kick.md) — feature-level docs
- [`/docs/architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md) — where the Kick streams end up
- [curl_cffi on GitHub](https://github.com/lwthiker/curl_cffi)
