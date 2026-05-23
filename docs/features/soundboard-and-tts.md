# Soundboard and text-to-speech

_Last verified: 2026-05-23 against commit 4a1d325._

Two utility-item flavors that let viewers play audio in the live stream — heard by all viewers, not just the user triggering it. Both use the same server-side audio queue.

## 101soundboards items

Item: **101 Soundboards** (📣). 50-point base price, 30-second cooldown.

### User flow

1. Buy the 101soundboards item from the shop.
2. Use it from inventory. A URL-input modal opens.
3. Paste a sound URL from [101soundboards.com](https://www.101soundboards.com) (e.g. `https://www.101soundboards.com/sounds/188391-potato`).
4. The sound is queued; plays after any sound already in the queue (2-second gap between sounds). Capped at 60 seconds per sound.
5. Chat receives a system message announcing the play.

All viewers hear the sound. The streamer doesn't need to do anything.

See [`/docs/integrations/101soundboards.md`](../integrations/101soundboards.md) for the integration internals (API endpoints, queue mechanics, item config).

## TTS items

Item: **TTS** (varies by item name; multiple TTS items can exist with different voices / costs). Triggers server-side text-to-speech using a configurable voice.

### User flow

1. Use a TTS item from inventory. A text-input modal opens.
2. Enter the message you want spoken (with reasonable length limits).
3. Pick a voice (if multiple are available).
4. Submit. The text is sent to the server, synthesized, played in-stream.
5. Chat receives a system message showing the text + the user who triggered it.

### Chat command shortcut

```
!tts <message>
```

…in chat triggers TTS without going through the inventory UI. Costs the same as using the item directly. See [`voting-and-claims.md`](voting-and-claims.md) for the full chat command list.

### Voice selection

Available voices are listed via:

```bash
curl https://onestreamer.live/api/soundfx/voices | jq
```

Configurable server-side in [`SoundFxService`](../../server/services/SoundFxService.js).

### Browser quirks

Safari's autoplay policy can interfere with the audio playback for some viewers. [`SafariTTSNotice.tsx`](../../client/src/components/soundfx/SafariTTSNotice.tsx) shows a one-time warning explaining the click-to-enable workaround.

## The shared audio queue

Both 101soundboards and TTS items push into the same server-side queue managed by [`SoundFxService`](../../server/services/SoundFxService.js):

- 2-second gap between consecutive playbacks
- 60-second max per item (long sounds get truncated)
- Admins can clear the queue: `DELETE /api/soundfx/soundboard/queue`
- Queue status visible via `GET /api/soundfx/soundboard/queue`

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/soundfx/voices` | List available TTS voices |
| `POST` | `/api/soundfx/tts` | Queue TTS message: `{ text, voice }` |
| `GET` | `/api/soundfx/tts/queue` | TTS queue status |
| `DELETE` | `/api/soundfx/tts/queue` | Clear TTS queue (admin only) |
| `POST` | `/api/soundfx/item/soundboard` | Trigger soundboard item: `{ url }` |
| `GET` | `/api/soundfx/soundboard/queue` | Soundboard queue status |
| `DELETE` | `/api/soundfx/soundboard/queue` | Clear soundboard queue (admin only) |
| `POST` | `/api/soundfx/upload` | Admin: upload custom audio file (5 MB limit) |

## Socket events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `sound-effect-play` | server → client | Trigger sound playback on viewer |
| `sound-effect-stop` | server → client | Stop a specific sound |
| `sound-effect-stop-all` | server → client | Stop everything |

## Operational notes

- **The audio plays in every viewer's browser**, not on the server. Each client downloads and plays the audio file independently.
- **Volume** is controlled per-viewer via the volume control in the UI ([`SoundVolumeControl.tsx`](../../client/src/components/SoundVolumeControl.tsx)). The stored preference persists in `localStorage` (`soundfx_volume` key).
- **CORS** matters for 101soundboards URLs — if 101soundboards tightens their CORS policy, playback breaks for all viewers. The server-side queue still works; only the client-side audio fetch fails.
- **Length cap** is enforced both server-side (in the queue) and client-side (in `SoundFxPlayer`). Belt-and-suspenders.

## Mobile / iOS

iOS has stricter autoplay rules than desktop browsers. The first audio playback may fail if the user hasn't interacted with the page recently. The Safari notice covers this. Users in iOS-heavy audiences can be coached to enable sound via a one-time tap.

## Code paths

| Concern | File |
|---------|------|
| Server-side queue + provider integration | [`server/services/SoundFxService.js`](../../server/services/SoundFxService.js) |
| HTTP routes | [`server/routes/soundfx.js`](../../server/routes/soundfx.js) |
| Client TTS input | [`client/src/components/soundfx/TTSInputModal.tsx`](../../client/src/components/soundfx/TTSInputModal.tsx) |
| Client soundboard input | [`client/src/components/soundfx/SoundboardInputModal.tsx`](../../client/src/components/soundfx/SoundboardInputModal.tsx) |
| Audio playback | [`client/src/components/soundfx/SoundFxPlayer.tsx`](../../client/src/components/soundfx/SoundFxPlayer.tsx) |
| Volume control | [`client/src/components/SoundVolumeControl.tsx`](../../client/src/components/SoundVolumeControl.tsx) |

## See also

- [`/docs/integrations/101soundboards.md`](../integrations/101soundboards.md) — the integration with the external sound provider
- [`items-and-buffs.md`](items-and-buffs.md) — item types and shop mechanics
- [`voting-and-claims.md`](voting-and-claims.md) — `!tts` chat command
- [`chat-and-moderation.md`](chat-and-moderation.md) — moderation tools for inappropriate TTS use
