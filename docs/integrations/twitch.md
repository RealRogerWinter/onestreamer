# Twitch

_Last verified: 2026-05-23 against commit 4a1d325._

Used by the random-stream rotation feature to discover Twitch streams and ingest them as viewbot content. Uses Twitch's Helix API via OAuth 2.0 client credentials grant — no Twitch user auth required.

## What it gives the platform

- **Random live Twitch streams** for the rotation system to play (see [`/docs/features/external-sources-twitch-kick.md`](../features/external-sources-twitch-kick.md))
- Filtered by viewer-count range and excluded categories so the rotation doesn't surface mega-streamers or off-topic content
- A recent-cache to avoid repeating the same channel within a short window

## Setup

1. Sign in to [dev.twitch.tv](https://dev.twitch.tv) with any Twitch account.
2. **Your Console** → **Applications** → **Register Your Application**:
   - Name: `OneStreamer`
   - OAuth Redirect URLs: `https://onestreamer.live` (a placeholder; client-credentials grant doesn't actually redirect)
   - Category: `Application Integration`
3. After creating, note the **Client ID**.
4. Click **New Secret** to generate a client secret.
5. Set the env vars per the table below.

## Credentials

| Env var | Purpose |
|---------|---------|
| `TWITCH_CLIENT_ID` | OAuth 2.0 client ID |
| `TWITCH_CLIENT_SECRET` | OAuth 2.0 client secret |

The OneStreamer server uses the **Client Credentials grant** flow (`grant_type=client_credentials`) — it gets a server-to-server access token by posting to `https://id.twitch.tv/oauth2/token`. The token is cached for its TTL (~60 days) and refreshed as needed.

## How it's used

[`TwitchRandomService`](../../server/services/TwitchRandomService.js):

1. On a rotation trigger, fetch random live streams via Helix:
   ```
   GET https://api.twitch.tv/helix/streams?first=100
   Headers: Client-ID + Authorization: Bearer <access-token>
   ```
2. Apply filters:
   - **Viewer range**: 1–5,000 viewers (configurable). Avoids both empty streams and mega-streamers.
   - **Blocked categories**: `ASMR`, `Pools, Hot Tubs, and Beaches`, plus whatever is in the blocklist.
   - **Recent-cache**: skip the last ~50 streamers seen.
3. Pick one at random.
4. Pass the channel info to [`URLStreamExtractorService`](../../server/services/URLStreamExtractorService.js) which derives the playable stream URL.
5. Hand off to the viewbot fleet for ingest. See [`/docs/architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md).

## Code paths

| Concern | File |
|---------|------|
| Twitch API client + filter logic | [`server/services/TwitchRandomService.js`](../../server/services/TwitchRandomService.js) |
| Rotation orchestrator | [`server/services/RandomStreamRotationService.js`](../../server/services/RandomStreamRotationService.js) |
| Stream URL extraction (Twitch HLS playlist resolution) | [`server/services/URLStreamExtractorService.js`](../../server/services/URLStreamExtractorService.js) |
| API endpoints (admin/operator triggers) | [`server/routes/random-stream.js`](../../server/routes/random-stream.js) |

## Operational notes

- **Twitch rate limits** apply per Client-ID. The Helix `streams` endpoint has a generous limit; OneStreamer's rotation isn't aggressive enough to hit it under normal use.
- **Token TTL** is ~60 days. The service refreshes automatically; no operational task.
- **The recent-cache is in-memory only** — restarting the main server resets it, so you may see one or two repeat channels right after a restart.
- **Category IDs are not stable** — the blocked-category list uses category names. If Twitch renames a category, the filter silently stops blocking it.

## Verifying connectivity

```bash
# Manual probe — get an access token
curl -X POST "https://id.twitch.tv/oauth2/token" \
  -d "client_id=$TWITCH_CLIENT_ID&client_secret=$TWITCH_CLIENT_SECRET&grant_type=client_credentials"

# Use the returned token to fetch live streams
curl -H "Client-ID: $TWITCH_CLIENT_ID" \
     -H "Authorization: Bearer <access-token>" \
     "https://api.twitch.tv/helix/streams?first=5"
```

If the first call fails with `400 invalid client`, the credentials are wrong. Rotate per [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md) (Twitch section).

## Triggering rotation manually

```bash
# Start rotation
curl -X POST -H "x-admin-key: $ADMIN_KEY" \
  https://onestreamer.live/api/random-stream/start

# Force-pick a new stream now
curl -X POST -H "x-admin-key: $ADMIN_KEY" \
  https://onestreamer.live/api/random-stream/rotate

# Stop rotation
curl -X POST -H "x-admin-key: $ADMIN_KEY" \
  https://onestreamer.live/api/random-stream/stop
```

These are also wired to chat commands — see [`/docs/features/voting-and-claims.md`](../features/voting-and-claims.md).

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Rotation never advances | `pm2 logs onestreamer-server | grep -i twitch` — likely a credentials issue or rate limit. |
| Rotation lands on an off-topic stream | The category may not be in the blocklist. Add it to `TwitchRandomService`'s filter list and restart. |
| Same streamer repeats often | Recent-cache too small, or running on a host that restarts frequently. |
| `400 invalid client` | `TWITCH_CLIENT_ID` or `TWITCH_CLIENT_SECRET` is wrong. Re-check and rotate if needed. |
| Stream URL extraction fails | Twitch occasionally restructures HLS playlist URLs. Check `URLStreamExtractorService` for any HTML scraping that may have broken. |

## See also

- [`/docs/features/external-sources-twitch-kick.md`](../features/external-sources-twitch-kick.md) — feature-level docs
- [`/docs/architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md) — where the Twitch streams end up
- [`kick.md`](kick.md) — the Kick equivalent (different mechanism)
- [Twitch Helix API docs](https://dev.twitch.tv/docs/api/)
