# Points and economy

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer has an internal economy: users earn **points** for participating, then spend them on inventory items that interact with the live stream (buffs, sound effects, visual effects, etc.). Points are persistent per account.

## How points are earned

| Activity | Rate |
|----------|-----:|
| Streaming | **10 points / minute** |
| Viewing a live stream | **2 points / minute** |
| Sending a chat message | **5 points / message** |

(Multipliers live in [`server/services/TimeTrackingService.js`](../../server/services/TimeTrackingService.js).)

### When the balance moves

Both streaming time and viewing time are accumulated in 25-second ticks. [`TimeTrackingService.sendRealTimeUpdate()`](../../server/services/TimeTrackingService.js) fires every 25 seconds during an active session and increments the user's totals via [`AccountService`](../../server/services/AccountService.js). Chat-message awards are applied immediately on send. End-of-session flushes any remainder.

After every increment, the user's `points_balance` is updated atomically in SQLite. A `time-stats-update` socket event broadcasts the new balance to the user's connected clients; the React client updates the header badge.

## How points are stored

Points live in a dedicated, authoritative column on `user_stats`:

```sql
user_stats.points_balance INTEGER DEFAULT 0
```

The balance is the source of truth. **It is not computed on-read from stream/view/chat history**, as it once was — that approach was replaced because rebalancing scenarios (admin grants, refunds, gambling, gifting) need a real ledger. The legacy `user_stats.points` column may still exist for historical reasons but is not authoritative.

> [!NOTE]
> If you find code that calculates points from `(total_stream_time/60)*10 + (total_view_time/60)*2 + (chat_message_count*5)`, that is leftover from the pre-refactor system. Update it to read `points_balance` directly. The historical refactor docs live in [`/docs/archive/points/`](../archive/points/).

## How points are spent

Three paths:

1. **Shop purchases** via `POST /api/shop/purchase/:itemId` ([`server/routes/items.js`](../../server/routes/items.js)). The shop is managed in the admin panel; items have base prices and (optionally) stock limits.
2. **Gambling and slots** in the chat-service (`!gamble`, `!slots`, `!roll`, `!flip` chat commands; see [`/docs/features/voting-and-claims.md`](voting-and-claims.md)). The chat-service posts back to the main server's `/api/internal/gamble` / `/api/internal/slots` endpoints to credit or debit the balance.
3. **Gifting and transfers** between users via internal endpoints; also driven by chat commands.

## Rate limits and cooldowns

- Item-use cooldowns are per-item, configured on the item itself (`cooldown_seconds`).
- Global and individual takeover cooldowns interact with the **guard/weapon item subsystem** — see [`/docs/features/items-and-buffs.md`](items-and-buffs.md).

## Code paths

| Concern | File |
|---------|------|
| Point awards (time-based + chat-based) | [`server/services/TimeTrackingService.js`](../../server/services/TimeTrackingService.js) |
| Balance reads/writes | [`server/services/AccountService.js`](../../server/services/AccountService.js) |
| Shop catalog and purchase logic | [`server/services/ShopService.js`](../../server/services/ShopService.js) |
| Inventory mutation | [`server/services/InventoryService.js`](../../server/services/InventoryService.js) |
| Chat-driven gambling | [`chat-service/index.js`](../../chat-service/index.js) (`!gamble`, `!slots`, `!roll`, `!flip`) |
| Admin grants | Admin panel → User Management (see [`/docs/features/admin-panel.md`](admin-panel.md)) |

## See also

- [`docs/features/items-and-buffs.md`](items-and-buffs.md) — what users buy with their points
- [`docs/features/voting-and-claims.md`](voting-and-claims.md) — chat commands that move points
- [`docs/architecture/data-model.md`](../architecture/data-model.md) — `user_stats` schema and its history
