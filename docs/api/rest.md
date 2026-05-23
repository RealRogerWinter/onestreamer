# REST API reference

_Last verified: 2026-05-23 against commit 4a1d325._

Every HTTP endpoint OneStreamer exposes — main server (`:8443`) and chat-service (`:8444`). Auth column key: 🟢 public, 🔵 user JWT required, 🟣 moderator, 🔴 admin, 🔑 `x-admin-key` legacy header.

For *how* endpoints fit into user-visible flows, see [`/docs/features/`](../features/). For socket events (the other half of OneStreamer's network surface), see [`socket-events.md`](socket-events.md) and the grouped narrative in [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md).

---

## Auth (`/auth/*`)

[`server/routes/auth.js`](../../server/routes/auth.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `POST` | `/auth/signup` | Register a new account (email/password + Turnstile) |
| 🟢 | `POST` | `/auth/login` | Email/password login (with Turnstile) |
| 🔵 | `POST` | `/auth/logout` | Logout |
| 🔵 | `POST` | `/auth/refresh` | Refresh JWT |
| 🟢 | `GET` | `/auth/verify-email/:token` | Email verification; grants starter items |
| 🟢 | `GET` | `/auth/google` | Initiate Google OAuth |
| 🟢 | `GET` | `/auth/google/callback` | Google OAuth callback |
| 🔵 | `GET` | `/auth/user/profile` | Get current user profile |
| 🔵 | `PATCH` | `/auth/user/profile` | Update profile (username, email, etc.) |
| 🔵 | `PATCH` | `/auth/user/avatar` | Upload avatar (5 MB limit) |
| 🟢 | `POST` | `/auth/forgot-password` | Send password-reset email |
| 🟢 | `POST` | `/auth/reset-password` | Reset password using token |
| 🔵 | `POST` | `/auth/request-deletion` | Begin account deletion (sends confirmation email) |
| 🟢 | `POST` | `/auth/confirm-deletion` | Confirm deletion via email token |
| 🔵 | `POST` | `/auth/restore-account` | Restore during 15-day grace period |
| 🔵 | `POST` | `/auth/resend-verification` | Re-send verification email |
| 🔵 | `GET` | `/auth/me` | Cached current-user info |
| 🟢 | `GET` | `/auth/user/:username` | Public user info |
| 🔵 | `POST` | `/auth/change-username` | Change username |

---

## Items & inventory (`/api/items`, `/api/inventory`, `/api/shop`)

[`server/routes/items.js`](../../server/routes/items.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/api/items` | List all items (optional `?category=...`) |
| 🟢 | `GET` | `/api/items/categories/list` | All item categories |
| 🟢 | `GET` | `/api/items/:id` | Get single item |
| 🔴 | `POST` | `/api/items` | Create item |
| 🔴 | `PUT` | `/api/items/:id` | Update item |
| 🔴 | `DELETE` | `/api/items/:id` | Delete item |
| 🔵 | `GET` | `/api/inventory/:userId` | Get user inventory |
| 🔵 | `POST` | `/api/inventory/use/:itemId` | Use item (target depends on item type) |
| 🟢 | `GET` | `/api/shop` | Shop catalog with prices |
| 🔵 | `POST` | `/api/shop/purchase/:itemId` | Purchase item |
| 🟢 | `GET` | `/api/cooldown/status` | Current global cooldown state |

---

## Buffs (`/api/buffs`)

[`server/routes/buffs.js`](../../server/routes/buffs.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔵 | `GET` | `/api/buffs/user/:userId` | User's active buffs |
| 🟢 | `GET` | `/api/buffs/streamer/current` | Current streamer's buffs |
| 🔵 | `POST` | `/api/buffs/apply` | Apply buff to target |
| 🟢 | `GET` | `/api/buffs/status/:userId` | Specific buff status |

---

## Sound effects & TTS (`/api/soundfx`)

[`server/routes/soundfx.js`](../../server/routes/soundfx.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/api/soundfx/voices` | List available TTS voices |
| 🔵 | `POST` | `/api/soundfx/tts` | Queue TTS message |
| 🟢 | `GET` | `/api/soundfx/tts/queue` | TTS queue status |
| 🔴 | `DELETE` | `/api/soundfx/tts/queue` | Clear TTS queue |
| 🔵 | `POST` | `/api/soundfx/item/soundboard` | Trigger 101soundboards item |
| 🟢 | `GET` | `/api/soundfx/soundboard/queue` | Soundboard queue status |
| 🔴 | `DELETE` | `/api/soundfx/soundboard/queue` | Clear soundboard queue |
| 🔴 | `POST` | `/api/soundfx/upload` | Upload custom audio (5 MB) |

---

## Visual effects (`/api/visualfx`)

[`server/routes/visualfx.js`](../../server/routes/visualfx.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/api/visualfx/effects` | List all available effects |
| 🟢 | `GET` | `/api/visualfx/active/:streamId?` | Active effects on a stream |
| 🔵 | `POST` | `/api/visualfx/apply` | Apply effect |
| 🔵 | `DELETE` | `/api/visualfx/remove/:effectId` | Remove specific effect |
| 🔴 | `DELETE` | `/api/visualfx/clear/:streamId` | Clear all effects |
| 🟢 | `GET` | `/api/visualfx/stats/:streamId` | Effect stats |
| 🟢 | `GET` | `/api/visualfx/presets` | List presets |
| 🔵 | `POST` | `/api/visualfx/preset/:presetName` | Apply preset |

---

## Clips (`/api/clips`)

[`server/routes/clips.js`](../../server/routes/clips.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/api/clips/status` | Clipping availability + rate limits |
| 🟢 | `GET` | `/api/clips` | List public clips (paginated, sortable, searchable) |
| 🟢 | `GET` | `/api/clips/:clipId` | Get clip metadata |
| 🟢 | `GET` | `/api/clips/:clipId/chat` | Get chat messages aligned with the clip |
| 🟢 | `GET` | `/api/clips/:clipId/stream` | Stream clip video (Range requests supported) |
| 🔵 | `POST` | `/api/clips` | Create new clip |
| 🔵 | `PUT` | `/api/clips/:clipId` | Update clip metadata |
| 🔵 | `DELETE` | `/api/clips/:clipId` | Delete clip |
| 🔵 | `POST` | `/api/clips/:clipId/publish` | Make a clip public |

---

## Recording review (`/admin/review`)

[`server/routes/admin-recordings.js`](../../server/routes/admin-recordings.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟣 | `GET` | `/admin/review/sessions` | List recording sessions |
| 🟣 | `GET` | `/admin/review/sessions/:sessionId` | Session details |
| 🟣 | `GET` | `/admin/review/sessions/:sessionId/stream` | Stream recording video |
| 🟣 | `GET` | `/admin/review/sessions/:sessionId/chat` | Chat for session |
| 🔴 | `GET` | `/admin/review/sessions/:sessionId/delete` | Soft-delete session |

---

## Chat bots (`/api/chatbots`)

[`server/routes/chatbots.js`](../../server/routes/chatbots.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔴 | `GET` | `/api/chatbots` | List all chatbots |
| 🔴 | `POST` | `/api/chatbots` | Create chatbot |
| 🔴 | `PUT` | `/api/chatbots/:id` | Update chatbot |
| 🔴 | `DELETE` | `/api/chatbots/:id` | Delete chatbot |
| 🔴 | `GET` | `/api/chatbots/config` | Get global LLM system prompt |
| 🔴 | `PUT` | `/api/chatbots/config` | Update global system prompt |
| 🔴 | `GET` | `/api/chatbots/models` | List available LLM models |
| 🔴 | `PUT` | `/api/chatbots/models` | Switch active LLM model |
| 🔴 | `GET` | `/api/chatbots/llm-status` | Probe LLM availability |
| 🔴 | `POST` | `/api/chatbots/all/enable` | Enable all bots |
| 🔴 | `POST` | `/api/chatbots/all/disable` | Disable all bots |

---

## StreamBot (`/api/streambot`)

[`server/routes/streambot.js`](../../server/routes/streambot.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔴 | `GET` | `/api/streambot/settings` | Get StreamBot config |
| 🔴 | `PUT` | `/api/streambot/settings` | Update config |
| 🔴 | `POST` | `/api/streambot/toggle` | Toggle enabled |
| 🔴 | `GET` | `/api/streambot/messages` | List messages |
| 🔴 | `GET` | `/api/streambot/messages/:id` | Get single message |
| 🔴 | `POST` | `/api/streambot/messages` | Create message |
| 🔴 | `PUT` | `/api/streambot/messages/:id` | Update message |
| 🔴 | `DELETE` | `/api/streambot/messages/:id` | Delete message |
| 🔴 | `POST` | `/api/streambot/messages/:id/toggle` | Toggle message enabled |
| 🔴 | `POST` | `/api/streambot/messages/reorder` | Reorder messages |
| 🔴 | `POST` | `/api/streambot/test` | Send a test message |

---

## ViewBot management (`/api/viewbot-manager`)

[`server/routes/viewbot-manager.js`](../../server/routes/viewbot-manager.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔴 | `GET` | `/api/viewbot-manager/status` | Current mode and active bots |
| 🔴 | `POST` | `/api/viewbot-manager/toggle-mode` | Plain RTP ↔ WebRTC toggle |
| 🔴 | `POST` | `/api/viewbot-manager/create` | Create a bot |
| 🔴 | `POST` | `/api/viewbot-manager/start/:botId` | Start a bot |
| 🔴 | `POST` | `/api/viewbot-manager/stop/:botId` | Stop a bot |
| 🔴 | `DELETE` | `/api/viewbot-manager/:botId` | Destroy a bot |
| 🔴 | `POST` | `/api/viewbot-manager/rotation/start` | Start rotation |
| 🔴 | `POST` | `/api/viewbot-manager/rotation/stop` | Stop rotation |

---

## Random stream rotation (`/api/random-stream`)

[`server/routes/random-stream.js`](../../server/routes/random-stream.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/api/random-stream/status` | Current rotation state |
| 🔑 | `POST` | `/api/random-stream/start` | Start rotation |
| 🔑 | `POST` | `/api/random-stream/stop` | Stop rotation |
| 🔑 | `POST` | `/api/random-stream/rotate` | Force rotate now |
| 🔑 | `POST` | `/api/random-stream/extend` | Extend current slot |
| 🔑 | `POST` | `/api/random-stream/reduce` | Shorten current slot |
| 🔑 | `POST` | `/api/random-stream/lock` | Lock rotation |
| 🔑 | `POST` | `/api/random-stream/unlock` | Unlock rotation |
| 🔑 | `POST` | `/api/random-stream/swap` | Swap to a specific URL |
| 🔑 | `POST` | `/api/random-stream/settings` | Update rotation settings |

---

## URL stream ingest (`/api/url-stream`)

[`server/routes/url-stream.js`](../../server/routes/url-stream.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔵 | `POST` | `/api/url-stream` | Start an arbitrary URL stream |
| 🟢 | `GET` | `/api/url-stream/:streamId` | Get stream status |
| 🔵 | `POST` | `/api/url-stream/:streamId/stop` | Stop URL stream |
| 🟢 | `GET` | `/api/url-stream/:streamId/metrics` | Stream metrics |
| 🟢 | `GET` | `/api/url-stream` | List relay streams |
| 🟢 | `GET` | `/api/url-stream/presets` | List preset sources |
| 🟢 | `GET` | `/api/url-stream/tools/status` | Tools health (ffmpeg, gstreamer, etc.) |
| 🟢 | `POST` | `/api/url-stream/validate` | Validate a URL before starting |
| 🔴 | `POST` | `/api/url-stream/stop-all` | Stop everything |
| 🔴 | `POST` | `/api/url-stream/presets` | Save a preset |

---

## Admin (`/api/admin`)

[`server/routes/admin.js`](../../server/routes/admin.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔴 | `GET` | `/api/admin/users` | List users (with `?q=...` search) |
| 🔴 | `POST` | `/api/admin/users/:userId/promote-admin` | Promote to admin |
| 🔴 | `POST` | `/api/admin/users/:userId/demote-admin` | Demote from admin |
| 🔴 | `POST` | `/api/admin/users/:userId/promote-moderator` | Promote to mod |
| 🔴 | `POST` | `/api/admin/users/:userId/demote-moderator` | Demote from mod |
| 🔴 | `POST` | `/api/admin/users/:userId/ban` | Ban account |
| 🔴 | `POST` | `/api/admin/users/:userId/unban` | Unban account |
| 🔴 | `POST` | `/api/admin/users/:userId/delete` | Admin-initiated deletion |
| 🔴 | `GET` | `/api/admin/users/:userId/stats` | User stats |
| 🔴 | `GET` | `/api/admin/version` | Server version info |
| 🔴 | `GET` | `/api/admin/verify` | Confirm admin access |
| 🔴 | `GET` | `/api/admin/banned-ips` | List IP bans |
| 🔴 | `POST` | `/api/admin/unban-ip` | Lift IP ban |
| 🔴 | `POST` | `/api/admin/ban-ip-manual` | Manual IP ban |
| 🔴 | `GET` | `/api/admin/streamer-connections` | Active streamer connections |
| 🔴 | `GET` | `/api/admin/streaming-logs/stats` | Streaming log aggregates |
| 🔴 | `POST` | `/api/admin/streaming-logs/ban-ip` | Ban an IP from the logs view |
| 🔴 | `POST` | `/api/admin/stream/disconnect` | Force-disconnect active stream |
| 🔴 | `POST` | `/api/admin/stream/ban-ip` | Ban a streamer's IP |
| 🔴 | `POST` | `/api/admin/stream/kick` | Kick a user |

---

## Moderation (`/api/moderation`)

[`server/routes/moderation.js`](../../server/routes/moderation.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟣 | `POST` | `/api/moderation/ban-chat` | Ban user from chat |
| 🟣 | `POST` | `/api/moderation/unban-chat` | Unban user from chat |
| 🟣 | `GET` | `/api/moderation/banned-users` | List banned chat users |

---

## Bug reports (`/api/bug-reports`)

[`server/routes/bug-reports.js`](../../server/routes/bug-reports.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `POST` | `/api/bug-reports` | Submit bug report (Turnstile required) |
| 🔴 | `GET` | `/api/bug-reports` | List bug reports |

---

## Audio settings (`/api/audio`)

(Inline in [`server/index.js`](../../server/index.js))

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/api/audio/optimization-settings` | Audio codec config defaults |
| 🟢 | `GET` | `/api/audio/profile/:profile` | Audio constraints for a preset (`raw`, `voice`, `music`, `streaming`) |
| 🔵 | `POST` | `/api/audio/monitor/:sessionId` | Start monitoring audio for a session |
| 🔵 | `POST` | `/api/audio/stats/:sessionId` | Update audio quality stats |
| 🟢 | `GET` | `/api/audio/report/:sessionId` | Audio quality report |

---

## Tutorial (`/api/tutorial`)

(Inline in [`server/index.js`](../../server/index.js))

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/api/tutorial` | Load tutorial/help content |
| 🔴 | `POST` | `/api/tutorial` | Update tutorial content |

---

## Legacy admin (`x-admin-key` header)

(Inline in [`server/index.js`](../../server/index.js); from the original HTML-panel era — being phased out for the JWT-authed `/api/admin/*` paths, but still callable)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔑 | `GET` | `/admin/dashboard` | Full system status |
| 🔑 | `POST` | `/admin/test-stream/start` | Start synthetic test stream |
| 🔑 | `POST` | `/admin/test-stream/stop` | Stop test stream |
| 🔑 | `GET` | `/admin/test-stream/status` | Test stream status |
| 🔑 | `POST` | `/admin/test-stream/config` | Update test config |
| 🔑 | `GET` | `/admin/test-stream/frame` | Current test frame data |
| 🔑 | `POST` | `/admin/clear-stream` | Force-end active stream |
| 🔑 | `POST` | `/admin/force-disconnect` | Disconnect a specific socket |
| 🔑 | `GET` | `/admin/connections` | List all sockets |
| 🔑 | `POST` | `/admin/transcription/start` | Start transcription |
| 🔑 | `POST` | `/admin/transcription/stop/:sessionId` | Stop transcription |
| 🔑 | `GET` | `/admin/transcription/status` | Transcription status |
| 🔑 | `POST` | `/admin/transcription/config` | Update transcription config |
| 🔑 | `POST` | `/admin/recordings/start` | Start recording |
| 🔑 | `POST` | `/admin/recordings/stop/:recordingId` | Stop recording |
| 🔑 | `GET` | `/admin/recordings/status/:recordingId` | Recording status |
| 🔑 | `GET` | `/admin/recordings/list` | List recordings |
| 🔑 | `GET` | `/admin/recordings/download/:recordingId` | Download recording |
| 🔑 | `DELETE` | `/admin/recordings/:recordingId` | Delete recording |
| 🔑 | `GET` | `/admin/recordings/active` | Active recordings |
| 🔑 | `GET` | `/admin/recordings/system-status` | Recording system stats |
| 🔑 | `POST` | `/admin/recordings/cleanup` | Manual cleanup pass |
| 🔑 | `POST` | `/admin/recordings/settings` | Update recording settings |

---

## Operational

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/health` | Main server health |
| 🟢 | `GET` | `/visualfx-debug-simple` | VisualFX debug page |
| 🟢 | `GET` | `/uploads/avatars/:filename` | Avatar files (served by nginx in prod) |
| 🟢 | `GET` | `/uploads/emojis/:filename` | Custom emoji files |
| 🟢 | `GET` | `/blog/:slug` | SSR blog page with OG meta tags |
| 🟢 | `GET` | `/clips/:clipId` | SSR clip share page with OG meta tags |

---

## Chat-service (port 8444)

[`chat-service/index.js`](../../chat-service/index.js)

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🟢 | `GET` | `/health` | Chat-service health |
| 🟣 | `GET` | `/api/moderation` | Retrieve current bans/timeouts |
| 🟣 | `POST` | `/api/ban` | Ban user permanently |
| 🟣 | `POST` | `/api/unban` | Unban user |
| 🟣 | `POST` | `/api/timeout` | Timeout user |
| 🟣 | `POST` | `/api/remove-timeout` | Remove active timeout |
| 🔴 | `POST` | `/api/system-message` | Inject system message into chat |
| 🟢 | `GET` | `/api/chat-history` | Retrieve last N messages |
| 🟢 | `GET` | `/debug/test-token` | Token validation debug |

---

## Internal callbacks (chat-service → main server)

The chat-service calls back to the main server to perform privileged actions (award points, trigger rotation, etc.). These endpoints are reachable from anywhere with a valid JWT but they exist specifically for chat-service's use:

| Auth | Method | Path | Purpose |
|:----:|--------|------|---------|
| 🔵 | `POST` | `/api/internal/award-points` | Credit user points (after winning `!claim`, `!gamble`, etc.) |
| 🔵 | `POST` | `/api/internal/transfer-points` | Transfer points between users |
| 🔵 | `POST` | `/api/internal/gift-item` | Gift an item to a user |
| 🔵 | `POST` | `/api/internal/gamble` | Process `!gamble` command |
| 🔵 | `POST` | `/api/internal/slots` | Process `!slots` command |

## See also

- [`socket-events.md`](socket-events.md) — the Socket.IO event reference
- [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) — events grouped by feature with narrative
- [`/docs/features/`](../features/) — what each endpoint is for, at the user-flow level
- [`/docs/security/auth-flows.md`](../security/auth-flows.md) — what each auth tier means
