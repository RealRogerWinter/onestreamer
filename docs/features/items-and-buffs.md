# Items, buffs, and the cooldown game

_Last verified: 2026-05-23 against commit 4a1d325._

Users spend points (see [`points-and-economy.md`](points-and-economy.md)) on **items** that interact with the live stream. Items fall into a small set of types, each with distinct mechanics.

## Item types

| Type | What it does | Examples |
|------|--------------|----------|
| `buff` | Applies a temporary positive effect to the current streamer | Speed boost, point multiplier |
| `debuff` | Applies a temporary negative effect to the current streamer | Slow-mode, blur, inverted controls |
| `utility` | One-shot helper actions | TTS, 101soundboards playback, visual effects |
| `guard` | Defensive — **increases** stream takeover cooldowns to protect the current streamer | Shield, Reinforced Shield, Fortress Wall, Time Freeze |
| `weapon` | Offensive — **decreases** stream takeover cooldowns to help viewers take over | Sword, Battle Axe, Lightning Bolt, Chaos Orb |
| `marker` | Cosmetic / informational | (varies) |

## Common attributes

Every item carries (see [`items` table schema](../architecture/data-model.md)):

- `cooldown_seconds` — minimum delay between uses
- `base_price` — points cost in the shop
- `rarity` — common / uncommon / rare / epic / legendary (drives display styling)
- `max_stack` — inventory stack limit (or unlimited)
- `duration_seconds` — for time-bounded effects
- `effect_data` (JSON) — type-specific configuration (e.g. soundboard URL pattern, visual-fx ID, buff strength)
- `stack_behavior` — how additional copies of an active effect compose (replace / extend / stack)

## The cooldown game (guard vs weapon items)

This is the most strategically rich item subsystem. Stream **takeover** is rate-limited by two cooldowns — a global one (resets after any stream change) and an individual one (per user, after they're taken over). Guard and weapon items move those cooldowns.

### Guard items (defensive — extend cooldowns)

| Item | Emoji | Rarity | Price | Effect |
|------|-------|--------|------:|--------|
| Shield | 🛡️ | Uncommon | 300 | +15 s global cooldown |
| Reinforced Shield | 🛡️⚡ | Rare | 600 | +30 s global cooldown |
| Fortress Wall | 🏰 | Epic | 1200 | +60 s global cooldown |
| Time Freeze | ⏳ | Legendary | 2000 | Freezes all individual cooldowns for 30 s |

### Weapon items (offensive — shrink cooldowns)

| Item | Emoji | Rarity | Price | Effect |
|------|-------|--------|------:|--------|
| Sword | ⚔️ | Common | 250 | −10 s global cooldown |
| Battle Axe | 🪓 | Uncommon | 450 | −20 s global cooldown |
| Lightning Bolt | ⚡ | Epic | 900 | −45 s global cooldown |
| Chaos Orb | 🔮 | Legendary | 1800 | Resets all individual cooldowns + −20 s global cooldown |

### Data flow when a cooldown item is used

```
viewer clicks item → POST /api/inventory/use/:itemId
                  → ItemService.isCooldownModifierItem() detects type
                  → applyCooldownModifierItem() calls TakeoverService
                  → TakeoverService.modifyGlobalCooldown() / resetAllIndividualCooldowns() / freezeIndividualCooldowns()
                  → server emits `cooldown-status-update` to all connected clients
                  → React updates the takeover button and timer
                  → chat-service receives a system message announcing the effect
```

## Inventory mechanics

The user's inventory lives in the `user_inventory` table. The React UI ([`inventory/InventoryPanel.tsx`](../../client/src/components/inventory/InventoryPanel.tsx)) groups items by type tab (All / Buffs / Utilities / Guards / Weapons), with hover tooltips, cooldown countdowns, and a "Use" button that resolves the use target (current streamer for buffs/debuffs, server for utility/cooldown items).

## Code paths

| Concern | File |
|---------|------|
| Item CRUD + categories | [`server/services/ItemService.js`](../../server/services/ItemService.js) |
| Cooldown-item logic | `ItemService.isCooldownModifierItem()`, `applyCooldownModifierItem()` |
| Takeover cooldowns | [`server/services/TakeoverService.js`](../../server/services/TakeoverService.js) (`modifyGlobalCooldown`, `resetAllIndividualCooldowns`, `freezeIndividualCooldowns`, `getGlobalCooldownRemaining`) |
| Buff/debuff lifecycle | [`server/services/BuffDebuffService.js`](../../server/services/BuffDebuffService.js) |
| Inventory mutation | [`server/services/InventoryService.js`](../../server/services/InventoryService.js) |
| Shop catalogue | [`server/services/ShopService.js`](../../server/services/ShopService.js) |
| Item-use endpoint | `POST /api/inventory/use/:itemId` in [`server/routes/items.js`](../../server/routes/items.js) |
| Real-time UI sync | `cooldown-status-update`, `buff-applied`, `buff-expired`, `item-used` socket events |

## See also

- [`points-and-economy.md`](points-and-economy.md) — how users earn the points to spend on items
- [`streaming-and-takeover.md`](streaming-and-takeover.md) — what the global and individual cooldowns actually gate
- [`visualfx-and-canvasfx.md`](visualfx-and-canvasfx.md) — utility items that trigger visual effects
- [`soundboard-and-tts.md`](soundboard-and-tts.md) — utility items that play audio
