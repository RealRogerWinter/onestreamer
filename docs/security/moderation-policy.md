# Moderation policy

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer is a single-tenant platform — the operator sets the moderation policy. This document captures the **technical tooling** moderators have available and the **default rules of thumb** that the existing automated systems enforce. It is *not* a community-policy statement; that belongs in your community's own terms of service or community guidelines.

## What's automatically enforced

### Profanity filter

[`server/services/ProfanityFilterService.js`](../../server/services/ProfanityFilterService.js) runs against chat messages. Implementation details:

- **~600-entry slur and abuse list**, focused on protected-class slurs and severe abuse
- **Normalization** for evasion techniques:
  - Character substitution: `0→o`, `1→i`, `3→e`, etc. (leetspeak)
  - Cyrillic / Greek look-alike characters (`а→a`, `е→e`)
  - Repeated-character collapse (`niiiiiiice` → `niice` → for filter purposes)
  - Zalgo / combining-diacriticals strip
  - Separator removal: `n.i.g.g.e.r` → `nigger`
- **Whitelist** for known-good words that would otherwise false-positive (configurable in code)
- **Returns sanitized text** with matched words replaced

> [!NOTE]
> The chat-service loads the profanity filter at startup, but it's not clear from a static read whether every message handler currently calls `profanityFilter.check()`. If you see a slur reach chat in production, confirm the filter is being called on the inbound message path in [`chat-service/index.js`](../../chat-service/index.js).

### Rate limits

Enforced in chat-service:

- **Inter-message minimum**: 5 seconds per user
- **Duplicate-message detection**: identical content within 30 seconds is rejected
- **First anonymous message** requires Turnstile

### Turnstile gates

Required on: signup, login, password reset, bug-report submission, first anonymous chat message. Adds friction to scripted abuse without inconveniencing legitimate users (background challenges, usually invisible).

### IP-ban check at socket connect

[`IPBanService`](../../server/services/IPBanService.js) maintains an in-memory cache + the `ip_bans` SQLite table. Banned IPs are dropped before any socket handshake completes — they consume no resources beyond the connection attempt.

## What moderators can do

### Chat-level

Available to users with `is_moderator=true` or `is_admin=true`:

| Action | How | Effect |
|--------|-----|--------|
| Timeout user | `!timeout <username> <seconds> [reason]` (chat command) | Mute for the duration; auto-expires |
| Permanent ban | `!ban <username> [reason]` | Persistent in `chat-service/moderation_data.json` |
| Unban | `!unban <username>` | Lift ban |
| Remove timeout | `!remove-timeout <username>` | Lift active timeout |
| Clear chat | `!clear-chat` | Wipe the in-memory message buffer + broadcast `chat-cleared` |

Plus the HTTP equivalents (`/api/ban`, `/api/unban`, etc. on chat-service). See [`/docs/api/rest.md`](../api/rest.md).

### Stream-level

Available to admins:

| Action | How | Effect |
|--------|-----|--------|
| Disconnect active stream | `POST /api/admin/stream/disconnect` (admin panel button) | Force-stop streaming; clean handoff (no cooldown) |
| Ban streamer's IP | `POST /api/admin/stream/ban-ip` | IP-ban + disconnect; ban persists in `ip_bans` |
| Manual IP ban | `POST /api/admin/ban-ip-manual` | Ban an IP that isn't currently streaming |

### Account-level

Available to admins via the User Management tab:

| Action | Effect |
|--------|--------|
| Promote / demote moderator | Sets `is_moderator` flag |
| Promote / demote admin | Sets `is_admin` flag |
| Ban account | Sets `is_banned=true`; user can't sign in regardless of IP |
| Unban account | Clears `is_banned` |
| Initiate deletion | Admin-initiated account deletion (same lifecycle as user-initiated) |

## Escalation guidance

| Level | When | Tool |
|-------|------|------|
| Verbal warning | First minor offense | Reply in chat from a mod account |
| Timeout (5–60 min) | Spamming, mild rudeness | `!timeout` |
| Timeout (24h–7d) | Repeated offenses, deliberate trolling | `!timeout <user> 86400` |
| Permanent chat ban | Severe single offense, repeat banned-and-back behavior | `!ban` |
| IP ban | Repeat ban-evader via new accounts | `/api/admin/stream/ban-ip` or `/api/admin/ban-ip-manual` |
| Account ban | Permanent removal from the platform | User Management tab → Ban |
| Stream disconnect | Inappropriate live content | `/api/admin/stream/disconnect` |

VPN-bouncing repeat offenders eventually requires escalation past IP bans to account-level bans. Many such users have multiple accounts; account bans should be paired with IP bans on observed connections.

## What's not in scope (intentionally)

- **AI-moderated streamer content.** OneStreamer doesn't analyze live video for inappropriate content. The operator's moderators are the safety net.
- **Geographic content blocking.** No geo-IP based filtering.
- **Age verification.** No KYC; minors can sign up. The operator's terms-of-service should set the policy.
- **DMCA takedown system.** No structured workflow; case-by-case admin action.

## Auditing

Moderation actions are logged in [`pm2 logs onestreamer-server`] and [`pm2 logs onestreamer-chat`] with emoji-prefixed lines:

```
🔨 MODERATION: Admin <username> disconnecting stream <streamerId>
🚫 MODERATION: IP <ip> banned by <username> for "<reason>"
🚫 CONNECTION: Banned IP attempted to connect: <ip>
🚫 STREAMING: Banned IP <ip> attempted to stream
✅ MODERATION: IP <ip> unbanned by <username>
🗑️ DELETION SCHEDULER: Account <id> permanently deleted
```

For structured forensics:

```bash
pm2 logs onestreamer-server --lines 10000 --nostream | grep -E "(🔨|🚫|✅) MODERATION:"
pm2 logs onestreamer-chat --lines 10000 --nostream | grep -E "(banned|timeout)"
```

For account-deletion audit specifically, query the `account_deletion_logs` table — see [`/docs/architecture/data-model.md`](../architecture/data-model.md).

## When the filter or rate limit causes a false positive

If a legitimate user is being filtered:

1. Check the message via `grep` against the profanity word list in [`ProfanityFilterService.js`](../../server/services/ProfanityFilterService.js).
2. If a normalization step is matching too aggressively, the word can be added to the whitelist.
3. Restart `onestreamer-server` (the filter loads once at boot).

If rate-limit thresholds need tuning (5s / 30s duplicate), edit the constants at the top of [`chat-service/index.js`](../../chat-service/index.js).

## See also

- [`threat-model.md`](threat-model.md) — what the moderation system defends against
- [`/docs/features/chat-and-moderation.md`](../features/chat-and-moderation.md) — feature-level moderation tour
- [`/docs/features/admin-panel.md`](../features/admin-panel.md) — admin panel tabs
- [`/docs/operations/runbooks/`](../operations/runbooks/) — incident runbooks
