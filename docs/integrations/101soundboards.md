# 101soundboards.com

_Last verified: 2026-05-23 against commit 4a1d325._

External soundboard API integration. Lets users play any sound from [101soundboards.com](https://www.101soundboards.com) in the live stream — heard by all viewers.

## What the user sees

1. Buy or otherwise acquire the **101 Soundboards** item (📣) — utility-type, 50-point base price, 30-second cooldown.
2. Use the item from the inventory; a URL-input modal opens.
3. Paste a sound URL from 101soundboards.com (e.g. `https://www.101soundboards.com/sounds/188391-potato`).
4. The sound is queued. Multiple users' sounds play sequentially with a 2-second gap. Each sound is capped at 60 seconds.
5. Chat receives a system message announcing the play.

## How it works

Backend ([`server/services/SoundFxService.js`](../../server/services/SoundFxService.js)) talks to the 101soundboards REST API:

- Fetch sound metadata: `GET https://www.101soundboards.com/api/v1/sounds/{soundId}`
- Search: `GET https://www.101soundboards.com/api/v1/sounds?q={searchTerm}`

The service exposes three routes ([`server/routes/soundfx.js`](../../server/routes/soundfx.js)):

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/soundfx/item/soundboard` | Trigger the soundboard item (user-facing) |
| `GET` | `/api/soundfx/soundboard/queue` | Inspect the queue |
| `DELETE` | `/api/soundfx/soundboard/queue` | Clear the queue (admin only) |

Audio playback runs client-side via [`SoundFxPlayer.tsx`](../../client/src/components/soundfx/SoundFxPlayer.tsx) (`play101Soundboard()`), with the duration cap enforced both server- and client-side for safety. URL parsing and validation happens in [`SoundboardInputModal.tsx`](../../client/src/components/soundfx/SoundboardInputModal.tsx).

## Item configuration (as stored in `items` table)

```json
{
  "name": "101soundboards",
  "display_name": "101 Soundboards",
  "emoji": "📣",
  "cooldown_seconds": 30,
  "base_price": 50,
  "effect_data": {
    "type": "soundboard",
    "provider": "101soundboards",
    "requiresUrl": true,
    "maxDuration": 60
  }
}
```

## Operational notes

- 101soundboards may rate-limit; the service queues with a 2-second inter-sound gap to stay polite.
- The architecture supports additional soundboard providers (each as its own item with provider-specific URL parsing). No additional providers are wired today.
- Browser playback uses CORS-mode audio fetches; some sounds may fail if 101soundboards changes CORS policy.

## See also

- [`docs/features/soundboard-and-tts.md`](../features/soundboard-and-tts.md) — the user-facing feature doc
- [`docs/integrations/cloudflare-turnstile.md`](cloudflare-turnstile.md) — chat actions that gate soundboard usage may require Turnstile
