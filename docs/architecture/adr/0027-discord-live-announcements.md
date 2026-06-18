# ADR-0027: Discord live-announcement bot for real streamers

_Status: accepted_
_Date: 2026-06-18_

## Context

We want OneStreamer to post an announcement card in our Discord whenever a
**real human streamer** goes live — and only then. The site carries three kinds
of "live stream" that must NOT trigger an announcement:

- **URL relay streams** — external sources (Twitch/YouTube/Kick) pulled in via
  `streamlink`/`yt-dlp` → FFmpeg → LiveKit ingress, registered through
  `ViewBotURLService` with an `url-stream-` id prefix.
- **Viewbots** — synthetic RTMP-ingress streams (`viewbot-` prefix / negative
  synthetic user ids).
- **AI bots** (MovieBot/VisionBot) — reactive chat agents; they never broadcast
  video and never become the current streamer.

The streamer profile model is thin: the `users` table has `username` but no
avatar, bio, stream title, or category (the explorer pass confirmed these aren't
persisted). So the card is built from what's actually available at go-live:
display name, registered-vs-guest, an optional client-supplied title, and a link
back to the site.

## Decision

A new optional service, `server/services/DiscordBotService.js`, posts an embed
("announcement card") to a configured Discord channel via a discord.js gateway
bot.

**Delivery: a real bot (discord.js), not a webhook.** Chosen so the integration
can grow into interactive features later (slash-commands, reactions). The bot
needs `DISCORD_BOT_TOKEN` + `DISCORD_ANNOUNCE_CHANNEL_ID` and the `Guilds`
intent only (enough to resolve and post to a channel). discord.js v14 runs on
the project's Node 18 (`engines.node: ">=18"`).

**The trigger chokepoint is the real-human branch of the takeover handler.**
`verifyAndEmitStreamReady` (the dead "stream verified live" path) is never
called, and URL relays/viewbots emit through entirely separate code paths, so
there is no single shared "stream started" notifier. The one place where **only
genuine client takeovers** converge is `server/sockets/streamHandler/takeover.js`,
right after `streamService.setStreamer()`, inside the existing `if (!isViewBot)`
block that already posts the in-app StreamBot chat announcement. The Discord
call sits beside it, guarded additionally against `url-stream-`/`viewbot-` socket
id prefixes for defense-in-depth (those ids never reach this socket handler, but
the guard makes the invariant explicit). Both authenticated and anonymous human
takeovers are announced (a guest shows as "Guest").

**Failure isolation + spam control.** Following the codebase's existing optional-
integration conventions:

- _Graceful-disabled_ (like `B2StorageService`): with the env vars unset the
  service is an inert no-op — it never builds a client or opens a socket.
- _Swallow-on-failure_ (like `ChatNotifier`): `announceStreamLive()` never throws
  and returns `null` on any skip/error, so a Discord outage can't disrupt the
  takeover flow that triggered it.
- _Side-effect-free constructor_: the gateway login happens in an explicit
  async `start()` (called once from `startServer()`), so the
  `bootstrap/services` factory — and its unit tests — build the bag without
  opening a network connection. `stop()` destroys the client (added to
  `stoppables` for graceful shutdown).
- _Per-streamer cooldown_ (default 5 min): suppresses a re-announce flood when a
  streamer rapidly stops/re-takes the slot or viewers war over the takeover
  button. The dedupe stamp is recorded only after a post actually succeeds, so a
  transient failure doesn't silence the next legitimate announcement.

## Consequences

- Adds `discord.js` (+ its `@discordjs/*` subtree) as a runtime dependency.
- The card is intentionally minimal (name, registered/guest, optional title,
  watch link) because richer streamer profile data isn't stored. If avatars/bios
  land later, `buildEmbed()` is the single place to enrich.
- A future webhook-only mode or interactive features can build on the same
  service; the trigger and guard stay unchanged.
- Operator setup (bot creation, invite with View Channel + Send Messages + Embed
  Links, channel id) is documented in `server/.env.example`.
