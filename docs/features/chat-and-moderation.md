# Chat and moderation

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer's chat is a separate microservice ([`chat-service/`](../../chat-service/)) running on port 8444 with its own Socket.IO instance. This split means a chat restart never interrupts streaming. The React client opens two sockets in parallel: one to the main server (port 8443) for streaming/items/auth, one to the chat-service for messages. See [ADR-0004](../architecture/adr/0004-chat-service-as-separate-microservice.md) for the rationale.

This page covers both **chat features** (what users do) and **moderation tools** (what admins/mods do). Stream-level moderation (disconnecting a live stream, banning an IP from streaming) lives at the bottom.

## Chat features

### Identity

Each connection gets one of two identity types:

- **Authenticated user** — username and color carry across sessions; admin/moderator badges visible to other users.
- **Anonymous visitor** — assigned a random `[Animal][Number]` username (50-animal vocabulary: Lion, Tiger, Bear, etc.) and a random color. Sticky-per-IP within a session for some continuity, but reassigned on reconnect.

### Emojis

Custom emoji set managed in the admin panel (Emoji Manager tab — see [`admin-panel.md`](admin-panel.md)). The picker UI is [`EmojiPicker.tsx`](../../client/src/components/EmojiPicker.tsx).

> Safari historically failed to render some custom emoji glyphs. The fix (see [`docs/archive/browser/SAFARI_EMOJI_FIX.md`](../archive/browser/SAFARI_EMOJI_FIX.md) for the original log) added a Safari-specific PNG fallback path. If new emojis fail to render in Safari, run the AVIF conversion utility and re-upload.

### Rate limits

Enforced server-side in [`chat-service/index.js`](../../chat-service/index.js):

- **Inter-message minimum**: 5 seconds per user.
- **Duplicate detection**: messages that repeat the same content within 30 seconds are rejected.

### Profanity filter

Local-only (no third-party API). The filter is [`server/services/ProfanityFilterService.js`](../../server/services/ProfanityFilterService.js) — a ~600-entry slur list with normalization for character substitution (Cyrillic look-alikes, leetspeak digits → letters, repeated-character collapse, Zalgo strip, separator removal like `n.i.g.g.e.r → nigger`). Whitelisted exceptions configurable in code.

> [!NOTE]
> The chat-service loads the profanity filter at startup but auto-invocation in the message handler isn't currently obvious in code. If a slur reaches chat, confirm that `chat-service/index.js` actually calls `profanityFilter.check()` on inbound messages and not only on a subset of paths.

### Chat history

Server keeps the **last 3,000 messages in memory** (sliding window, ~1 hour at moderate traffic). No DB persistence for chat messages — restarting chat-service drops history. New connections receive the last 20 messages on join.

### Chat commands

The chat-service implements a command vocabulary that hooks back to the main server for actions:

| Command | What it does |
|---------|--------------|
| `!next` / `!skip` | Vote to rotate to the next random stream |
| `!swap <url>` | Vote to swap the current stream to a URL |
| `!extend` | Vote to extend the current stream's rotation window |
| `!reduce` | Vote to shrink the current stream's rotation window |
| `!lock` / `!unlock` | Vote to lock/unlock the rotation |
| `!claim <code>` | Redeem a random reward code (codes appear in chat at 20–60 min intervals, expire after 60 s) |
| `!tts <message>` | Speak text in-stream via TTS |
| `!roll`, `!flip`, `!gamble`, `!slots` | Points-economy mini-games |

Voting thresholds, windows, and cooldowns are documented in [`voting-and-claims.md`](voting-and-claims.md).

## Moderation tools

### Chat-level moderation (mod or admin)

| Action | Effect | Persistence |
|--------|--------|-------------|
| `!ban <username>` | Permanent chat ban | Stored in [`chat-service/moderation_data.json`](../../chat-service/moderation_data.json) on disk |
| `!unban <username>` | Lift permanent ban | Stored on disk |
| `!timeout <username> <seconds> [reason]` | Temporary mute | Stored on disk; auto-expires when checked |
| `!remove-timeout <username>` | Lift active timeout | Stored on disk |
| `!clear-chat` | Delete the in-memory message buffer and broadcast a chat-clear event | In-memory only |

Banned/timed-out users receive a `banned` or `timeout` socket event on connect attempt and are immediately disconnected.

### HTTP moderation endpoints (chat-service)

Admin auth (Bearer token) required:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/moderation` | Retrieve current bans + timeouts |
| `POST` | `/api/ban` | Ban a user permanently |
| `POST` | `/api/unban` | Unban a user |
| `POST` | `/api/timeout` | Timeout (mute) a user |
| `POST` | `/api/remove-timeout` | Lift an active timeout |
| `POST` | `/api/system-message` | Inject a system message into chat |
| `GET` | `/api/chat-history` | Fetch the last N messages |

### IP banning (cross-cutting)

IPs banned via [`server/services/IPBanService.js`](../../server/services/IPBanService.js) are blocked at the socket connection layer — they can't open a chat socket *or* a main socket. Bans are stored in the `ip_bans` SQLite table:

```sql
CREATE TABLE ip_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL UNIQUE,
  banned_by_user_id INTEGER,
  banned_by_username TEXT,
  banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  permanent BOOLEAN DEFAULT 1,
  expires_at DATETIME,
  FOREIGN KEY (banned_by_user_id) REFERENCES users(id)
)
```

`IPBanService` keeps an in-memory cache for fast checks, supports IPv4 and IPv6 (stripping `::ffff:` prefixes for consistency), and reads the real client IP from `X-Forwarded-For` / `X-Real-IP` (proxy-aware) before falling back to the socket's remote address.

Admin endpoints (Bearer-token auth, main server):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/banned-ips` | List all active IP bans |
| `POST` | `/api/admin/stream/ban-ip` | Ban an IP and disconnect any active stream from it |
| `POST` | `/api/admin/unban-ip` | Lift an IP ban |
| `POST` | `/api/admin/ban-ip-manual` | Ban an IP without targeting an active stream |

## Stream-level moderation

A separate concern from chat moderation: ending the *currently broadcasting* stream.

| Method | Path | Effect |
|--------|------|--------|
| `POST` | `/api/admin/stream/disconnect` | Immediately terminate the active stream, clean up MediaSoup resources, notify the streamer and all viewers |

Flow:

1. Admin clicks **Disconnect Stream** in the admin panel.
2. Server clears the streamer from [`StreamService`](../../server/services/StreamService.js).
3. MediaSoup producers/transports torn down.
4. The streamer socket receives `stream-disconnected-by-admin` and is force-disconnected.
5. All viewers receive `stream-ended`.

No takeover cooldown is applied — admin disconnects are "clean."

## Where this is wired in the UI

| Surface | File |
|---------|------|
| Chat client | [`client/src/components/Chat.tsx`](../../client/src/components/Chat.tsx) |
| Mobile chat | [`client/src/components/mobile/MobileChat.tsx`](../../client/src/components/mobile/MobileChat.tsx) |
| Popout chat (separate window) | [`client/src/components/PopoutChat.tsx`](../../client/src/components/PopoutChat.tsx) |
| Chat moderation admin UI | [`client/src/components/admin/ChatModeration.tsx`](../../client/src/components/admin/ChatModeration.tsx) |
| Stream moderation admin UI | [`client/src/components/admin/ModerationPanel.tsx`](../../client/src/components/admin/ModerationPanel.tsx) |
| IP ban management | [`client/src/components/admin/IPBanManagement.tsx`](../../client/src/components/admin/IPBanManagement.tsx) |

## Operational notes

- **Logs to grep**: `🔨 MODERATION:`, `🚫 MODERATION:`, `🚫 CONNECTION:`, `🚫 STREAMING:`, `✅ MODERATION:`.
- **Chat history is volatile**: a chat-service restart clears history. Recordings retain stream-time chat via [`SessionChatCaptureService`](../../server/services/SessionChatCaptureService.js); use those for forensics.
- **VPN/proxy bypass**: IP bans don't follow users across VPNs. For repeat offenders, ban by username + IP both, or escalate to account-level ban via the admin panel.

## See also

- [`voting-and-claims.md`](voting-and-claims.md) — chat command details
- [`admin-panel.md`](admin-panel.md) — full admin UI tour, including account-level bans and user management
- [`/docs/security/moderation-policy.md`](../security/moderation-policy.md) — escalation policy and content rules
- [`/docs/operations/runbooks/stream-stuck.md`](../operations/runbooks/stream-stuck.md) — when stream disconnection is the right tool vs. when it isn't
