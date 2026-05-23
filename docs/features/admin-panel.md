# Admin panel

_Last verified: 2026-05-23 against commit 4a1d325._

The admin panel is the centralized management UI for OneStreamer. The current implementation is **AdminPanelV3** ([`client/src/components/admin/AdminPanelV3.tsx`](../../client/src/components/admin/AdminPanelV3.tsx)) — a React overlay with 18 functional tabs. It supersedes a set of legacy HTML admin pages (`/admin-dashboard.html`, `/transcription-admin.html`, etc.) that were the original implementation; those pages may still exist in the server's public dir but the React panel is the canonical interface today.

## Access

- **Authenticated user with `is_admin = 1` or `is_moderator = 1`** in the `users` table.
- Click the admin / settings icon in the header → "Admin Panel".
- The panel mounts as an overlay on top of the regular UI; close with the × or ESC.

Role gating is per-tab — mods see a reduced subset; full admins see everything.

Bearer-token auth on every backend call (the panel uses the user's JWT). The legacy admin endpoints additionally accepted an `x-admin-key` header (env var `ADMIN_KEY`); that path still works for some routes but is being phased out in favor of JWT + role check.

## The 18 tabs

### 1. Dashboard

Real-time platform overview.

- Active streamer (ID, type, viewer count, start time, duration)
- Server health (CPU / memory / uptime / Node version)
- Connection counts (total sockets, by type)
- Quick actions: force-end the current stream

### 2. Game Control

Start/stop the in-stream multiplayer game globally. See [`multiplayer-game.md`](multiplayer-game.md).

- `admin:start-game` / `admin:stop-game` / `admin:game-status` socket events
- Per-game settings (world size, tick rate)
- Live player count when active

### 3. User Management

CRUD on user accounts.

- Search by username/email
- View stats: total stream time, watch time, points balance, registration date
- Promote / demote moderator / admin (`POST /api/admin/users/:userId/promote-admin` etc.)
- Ban / unban (account-level — separate from chat ban + IP ban)
- Request account deletion on behalf of a user (admin-initiated path)

### 4. Connections

Monitor all active WebSocket connections.

- Per-socket detail: socket ID, type (streamer/viewer/admin), IP, user-agent, room membership, connected-at time
- Force-disconnect any connection
- Live filtering by type or rooms
- Useful when you need to disconnect someone *without* a stream-level ban

### 5. ViewBots

Manage the viewbot fleet (see [`/docs/architecture/viewbot-fleet.md`](../architecture/viewbot-fleet.md)).

- Toggle between Plain RTP and WebRTC modes
- Create / start / stop / destroy individual bots
- Start / stop the rotation
- Assign video files or URLs to bots

### 6. URL Stream Relay

Set up viewbots that ingest external URLs (Twitch, Kick, YouTube live, custom RTMP). See [`/docs/features/external-sources-twitch-kick.md`](external-sources-twitch-kick.md). Includes preset management (save common stream sources for one-click activation).

### 7. Items & Shop

CRUD on shop catalog and item definitions.

- Create new items (name, emoji, price, rarity, cooldown, type, effect_data JSON)
- Edit existing items
- Categorize items
- Set stock limits (or unlimited)
- Bulk operations

UI: [`ItemManagement.tsx`](../../client/src/components/admin/ItemManagement.tsx) (~1k LOC)

### 8. Chat Bots

Manage AI chat participants (see [`ai-chatbots.md`](ai-chatbots.md)).

- Create / edit / delete bots
- Configure per-bot prompt, model, temperature, response interval
- Enable/disable individually or all at once
- Test bot responses
- View per-bot message history
- Pick LLM model (Ollama / Groq) for the global system

UI: [`ChatBotManagement.tsx`](../../client/src/components/admin/ChatBotManagement.tsx) (~1.8k LOC — the largest admin tab)

### 9. StreamBot

Configure the periodic-announcement bot.

- Manage the message rotation (add / edit / reorder)
- Frequency (every N minutes or N messages)
- Enable/disable
- Test a message before scheduling
- Reorder via drag and drop

### 10. Recordings

Browse and manage past stream recordings. See [`recording-and-clips.md`](recording-and-clips.md).

- List by streamer / date / status
- Download, rename, delete
- Trigger manual cleanup
- View system status (active recordings, disk usage, compression queue depth)

### 11. Recording Review

Playback past recordings and extract clips. See [`recording-and-clips.md`](recording-and-clips.md).

- Browse streamers → sessions → recordings
- Playback with seek, speed (0.5×–2×), and live synced chat replay
- Extract clip from a selected time range
- Edit clip metadata before publishing

UI: [`AdminRecordingReview.tsx`](../../client/src/components/admin/AdminRecordingReview.tsx) (~1.1k LOC)

### 12. Transcriptions

Manage real-time transcription (see [`transcription.md`](transcription.md)).

- Enable / disable globally
- Pick Whisper model (`tiny` / `base` / `small` / `medium` / `large`)
- Pick language (or `auto`)
- See active sessions
- Browse past transcriptions (search by text, filter by date / status)
- View full transcripts; copy / download as text
- Bulk-delete transcriptions older than N days

UI: [`TranscriptionManagement.tsx`](../../client/src/components/admin/TranscriptionManagement.tsx) (~750 LOC)

Live-control endpoints:

| Method | Path |
|--------|------|
| `POST` | `/admin/transcription/start` |
| `POST` | `/admin/transcription/stop/:sessionId` |
| `GET` | `/admin/transcription/status` |
| `POST` | `/admin/transcription/config` |

### 13. Emoji Manager

Upload, name, preview, and delete custom emojis available in chat. Includes a Safari compatibility pass (some PNG fallbacks for emoji glyphs that don't render in Safari — see [`/docs/archive/browser/SAFARI_EMOJI_FIX.md`](../archive/browser/SAFARI_EMOJI_FIX.md)).

### 14. Chat Moderation

Chat-level tools (the corresponding chat-service backend lives in `chat-service/`).

- Search recent messages by user
- Mute / kick / ban by username
- Broadcast moderator system messages
- View per-user chat history
- Clear the chat buffer

See [`chat-and-moderation.md`](chat-and-moderation.md) for the full feature set.

### 15. IP Ban Management

Manage the `ip_bans` SQLite table directly.

- List currently-banned IPs (with reason, who banned, when, expires)
- Manually ban an IP (with optional expiry for temp bans)
- Unban
- View connection history per IP

### 16. Streaming Logs

The audit trail of stream connect/disconnect events.

- Filter by user / IP / time range
- Quick-action: "ban this IP from the log entry"
- Stats endpoint (`/api/admin/streaming-logs/stats`) summarises by day/streamer

### 17. Tutorial Editor

WYSIWYG (or markdown) editor for the help / about / tutorial / terms / privacy content shown in the Tutorial modal. Changes persist via `POST /api/tutorial`. UI: [`TutorialEditor.tsx`](../../client/src/components/admin/TutorialEditor.tsx) (~870 LOC).

### 18. Bug Reports

View and triage user-submitted bug reports (collected via [`BugReportModal.tsx`](../../client/src/components/BugReportModal.tsx)).

- Status: open / in-progress / resolved / closed
- Filter, search, add comments
- Change status

## Account deletion (cross-cutting feature)

Account deletion ships through user-initiated flows, not the admin panel directly — but admins can monitor and intervene. The full lifecycle:

1. **Request** — user clicks Delete Account in Profile Settings → Danger Zone. Email must be verified; user types `DELETE MY ACCOUNT` to confirm. `POST /auth/request-deletion` issues a 24-hour token and emails it.
2. **Confirm** — user clicks the link in the email. `POST /auth/confirm-deletion` marks the account `pending_deletion` and schedules a hard-delete 15 days out. User is logged out immediately.
3. **Grace period (15 days)** — user can `POST /auth/restore-account` to come back; all features are disabled except restoration.
4. **Permanent delete** — [`AccountDeletionScheduler.js`](../../server/services/AccountDeletionScheduler.js) runs on a 1-hour interval. After 15 days post-confirmation, [`AccountService.permanentlyDeleteAccount()`](../../server/services/AccountService.js) wipes 8 tables (`user_sessions`, `user_stats`, `ip_to_user_transfers`, `user_inventory`, `item_usage_history`, `user_points_log`, `account_deletion_logs`, plus the `users` row is anonymized for audit). Irreversible.

### Database

Schema additions on `users`:

```sql
deletion_requested_at    DATETIME
deletion_confirmed_at    DATETIME
deletion_scheduled_for   DATETIME
deletion_token           TEXT
deletion_token_expires   DATETIME
account_status           TEXT          -- 'active' | 'pending_deletion' | 'deleted'
```

Plus the audit-trail table:

```sql
account_deletion_logs (
  id, user_id, action, ip_address, user_agent, created_at, metadata
)
```

### Admin visibility

```bash
# Pending deletions (read-only check)
sqlite3 /root/onestreamer/server/data/onestreamer.db \
  "SELECT id, username, deletion_requested_at, deletion_scheduled_for \
   FROM users WHERE account_status = 'pending_deletion';"

# Audit log
sqlite3 /root/onestreamer/server/data/onestreamer.db \
  "SELECT * FROM account_deletion_logs ORDER BY created_at DESC LIMIT 10;"

# Scheduler logs
pm2 logs onestreamer-server | grep "DELETION SCHEDULER"
```

### Security properties

- **Verified email required** — prevents account-takeover-driven deletion.
- **24-hour token** with cryptographic randomness (`crypto.randomBytes`).
- **Type-to-confirm** UI prevents fat-finger deletes.
- **15-day grace period** is long enough to catch "I deleted my account in anger last night" remorse.
- **IP and user-agent** captured at every step for forensics.

## Legacy admin endpoints

Some endpoints from the original HTML-panel era still exist alongside the JWT-authenticated routes. They use `x-admin-key` header auth (env var `ADMIN_KEY`):

| Endpoint | Note |
|----------|------|
| `GET /admin/dashboard` | Original full-system status |
| `POST /admin/test-stream/start` | Synthetic test stream (SMPTE bars, color gradient, etc.) |
| `POST /admin/test-stream/stop` | |
| `GET /admin/test-stream/status` | |
| `POST /admin/test-stream/config` | |
| `GET /admin/test-stream/frame` | Live frame snapshot |
| `POST /admin/clear-stream` | Force-end the active stream |
| `POST /admin/force-disconnect` | Disconnect a specific socket |
| `GET /admin/connections` | List sockets |

The React `AdminPanelV3` reuses some of these under the hood; others are not wired up in the React UI but remain callable for scripting / manual recovery. Consider these deprecated for new admin features — add to JWT-auth routes under `/api/admin/`.

## Keyboard shortcuts (legacy panel)

If you're using the HTML admin pages directly:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` / `Cmd+Shift+A` | Open admin panel |
| `ESC` | Close admin panel |
| `Ctrl+Shift+C` | Quick to Connections tab |
| `Ctrl+Shift+T` | Quick to Test Stream tab |

These shortcuts are not wired in `AdminPanelV3` by default — open the panel via the header icon instead.

## Test stream

The Test Stream tab (legacy) generates synthetic video without anyone actually streaming. Useful for testing viewer-side behavior, layouts, takeover flow, etc.

- **Content types**: SMPTE color bars, random noise, color gradient, scrolling text, digital clock
- **Resolutions**: 1920×1080, 1280×720, 854×480, 640×360
- **Frame rate**: 10–60 fps adjustable
- **Lives in `TestStreamService.js`** server-side

Endpoints:

```bash
curl -H "x-admin-key: $ADMIN_KEY" \
  https://onestreamer.live/admin/test-stream/status
```

## Operational notes

- **All admin actions log to stderr** with the `🔨 MODERATION:` or `🗑️ DELETION SCHEDULER:` style prefix. Grep `pm2 logs onestreamer-server` for forensics.
- **No automatic session expiry** on the legacy `x-admin-key` auth. Manual logout / token rotation.
- **`ADMIN_KEY` env var** must be rotated like any secret if exposed — see [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).
- **CORS for admin endpoints** is locked to the OneStreamer origin; admin tools running on a different origin will fail without explicit allowlisting.

## See also

- [`/docs/security/threat-model.md`](../security/threat-model.md) — admin role privileges and what trust they carry
- [`/docs/security/auth-flows.md`](../security/auth-flows.md) — how the JWT auth that gates admin actions works
- [`chat-and-moderation.md`](chat-and-moderation.md) — chat-side moderation tooling
- [`recording-and-clips.md`](recording-and-clips.md) — the recording review tab in depth
- [`/docs/operations/runbooks/`](../operations/runbooks/) — what to do when admin actions don't fix the underlying problem
