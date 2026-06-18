// server/services/DiscordBotService.js
//
// Posts a "streamer is live" announcement card to a Discord channel whenever a
// REAL human streamer takes over and goes live. URL relay streams and viewbots
// are NEVER announced — the only caller is the real-human branch of the
// `request-to-stream` takeover handler (server/sockets/streamHandler/takeover.js),
// which fires solely for genuine client sockets (viewbots are gated out by
// `!isViewBot`, URL relays register through ViewBotURLService and never reach
// that socket path).
//
// Shape mirrors the codebase's other optional outbound integrations:
//   - B2StorageService: graceful-disabled (this.enabled = false) when its
//     credentials are absent, so the service is a no-op rather than a crash.
//   - ChatNotifier: swallow-on-failure (log + return null) so a Discord outage
//     never breaks the takeover flow that triggered the announcement.
//
// The discord.js gateway client is a long-lived connection, so login happens in
// an explicit async start() (called once from server/index.js' startServer()),
// NOT in the constructor — the constructor must stay side-effect-free so the
// bootstrap/services factory (and its unit tests) can build the bag without
// opening a network socket. stop() destroys the client for graceful shutdown.

const logger = require('../bootstrap/logger').child({ svc: 'DiscordBotService' });

// Per-streamer re-announce suppression. Prevents a flood when a streamer
// rapidly stops/re-takes the slot (or a viewer wars over takeovers): the same
// streamer is announced at most once per window.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Discord "danger"/red — reads as a live indicator on the card's left border.
const LIVE_COLOR = 0xED4245;

class DiscordBotService {
  /**
   * @param {object} [opts]
   * @param {string} [opts.token]        bot token (default: DISCORD_BOT_TOKEN)
   * @param {string} [opts.channelId]    announce channel id (default: DISCORD_ANNOUNCE_CHANNEL_ID)
   * @param {string} [opts.siteUrl]      public site URL for the "watch now" link
   *                                     (default: PUBLIC_SITE_URL || CLIENT_URL)
   * @param {number} [opts.cooldownMs]   per-streamer re-announce suppression window
   * @param {object} [opts.client]       pre-built discord.js Client (test seam; when
   *                                     provided, start() skips login())
   * @param {object} [opts.discordModule] override for `require('discord.js')` (test seam)
   */
  constructor(opts = {}) {
    this.token = opts.token || process.env.DISCORD_BOT_TOKEN || null;
    this.channelId = opts.channelId || process.env.DISCORD_ANNOUNCE_CHANNEL_ID || null;
    this.siteUrl = opts.siteUrl
      || process.env.PUBLIC_SITE_URL
      || process.env.CLIENT_URL
      || 'https://onestreamer.com';
    this.cooldownMs = opts.cooldownMs != null ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;

    // Test seams.
    this._injectedClient = opts.client || null;
    this._discordModule = opts.discordModule || null;

    // Both halves of the credential are required; a bot token with no target
    // channel (or vice versa) can't post anything.
    this.enabled = Boolean(this.token && this.channelId);

    this.client = null;
    this.ready = false;
    this._startPromise = null;
    this._lastAnnounced = new Map(); // dedupe key -> last announce epoch ms

    if (!this.enabled) {
      logger.warn('[Discord] DISCORD_BOT_TOKEN / DISCORD_ANNOUNCE_CHANNEL_ID not set — live announcements disabled');
    }
  }

  isEnabled() {
    return this.enabled;
  }

  /**
   * Log the bot into the Discord gateway. Idempotent — repeated calls return the
   * same in-flight/resolved promise. Never throws: a login failure disables
   * announcements for this run rather than crashing the server.
   */
  async start() {
    if (!this.enabled) return;
    if (this._startPromise) return this._startPromise;

    this._startPromise = (async () => {
      try {
        const client = this._injectedClient || this._buildClient();
        this.client = client;

        // A gateway hiccup must never bubble into an unhandled 'error' that
        // crashes the process.
        if (typeof client.on === 'function') {
          client.on('error', (err) => logger.error({ err }, '[Discord] gateway client error'));
        }

        if (!this._injectedClient) {
          await client.login(this.token);
        }

        this.ready = true;
        logger.info('[Discord] bot logged in — live announcements enabled');
      } catch (err) {
        this.ready = false;
        logger.error({ err }, '[Discord] login failed — live announcements disabled for this run');
      }
    })();

    return this._startPromise;
  }

  // Lazy require so a graceful-disabled deploy (or unit tests injecting a fake
  // client) never loads discord.js.
  _buildClient() {
    const { Client, GatewayIntentBits } = this._discordModule || require('discord.js');
    // Guilds is the only intent needed to resolve + post to a channel.
    return new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  /**
   * Announce a real streamer going live. Fire-and-forget: never throws, returns
   * null on any skip/failure so callers can ignore the result.
   *
   * @param {object} info
   * @param {string}  info.displayName  streamer's display name / username
   * @param {number?} info.userId       authenticated user id (>0), or null for a guest
   * @param {boolean} [info.isTakeover] whether this displaced another streamer
   * @param {string?} [info.title]      stream title, if the client supplied one
   * @param {number?} [info.startTime]  epoch ms the stream went live (default: now)
   * @returns {Promise<true|null>}
   */
  async announceStreamLive(info = {}) {
    if (!this.enabled) return null;

    try {
      const key = info.userId != null
        ? `u:${info.userId}`
        : `n:${String(info.displayName || '').toLowerCase()}`;
      const now = Date.now();
      const last = this._lastAnnounced.get(key);
      if (last != null && (now - last) < this.cooldownMs) {
        logger.debug(`[Discord] suppressing duplicate announce for ${key} (within cooldown)`);
        return null;
      }

      // start() is called at boot, but ensure-on-first-use keeps the service
      // robust if an announce races startup.
      if (!this.ready) {
        await this.start();
        if (!this.ready) return null;
      }

      const channel = await this._resolveChannel();
      if (!channel || typeof channel.send !== 'function') {
        logger.warn(`[Discord] announce channel ${this.channelId} not found or not sendable`);
        return null;
      }

      await channel.send({ embeds: [this.buildEmbed(info)] });

      // Only record the dedupe stamp once a post actually succeeds, so a
      // transient failure doesn't silence the next legitimate announce.
      this._lastAnnounced.set(key, now);
      logger.info(`[Discord] posted live announcement for ${info.displayName || 'streamer'}`);
      return true;
    } catch (err) {
      logger.error({ err }, '[Discord] failed to post live announcement');
      return null;
    }
  }

  async _resolveChannel() {
    const channels = this.client && this.client.channels;
    if (!channels) return null;

    const cached = channels.cache && typeof channels.cache.get === 'function'
      ? channels.cache.get(this.channelId)
      : null;
    if (cached) return cached;

    if (typeof channels.fetch === 'function') {
      return channels.fetch(this.channelId);
    }
    return null;
  }

  /**
   * Build the announcement card (a Discord embed). discord.js v14 accepts a
   * plain APIEmbed object in `embeds`, so no EmbedBuilder dependency is needed —
   * which also keeps this pure and trivially unit-testable.
   */
  buildEmbed(info = {}) {
    // Cap the display name so the assembled title can't exceed Discord's 256-char
    // embed-title limit (which would 400 the whole send). Usernames are normally
    // short, but the anonymous chat-username path isn't length-validated upstream,
    // so clamp defensively here — the rest of buildEmbed already clamps inputs.
    const displayName = String(info.displayName || 'A streamer').slice(0, 200);
    const verb = info.isTakeover ? 'took over and is now LIVE' : 'is now LIVE';

    const fields = [];
    if (info.title) {
      fields.push({ name: '📺 Stream', value: String(info.title).slice(0, 256), inline: false });
    }
    fields.push({
      name: '👤 Streamer',
      value: info.userId != null ? 'Registered account' : 'Guest',
      inline: true,
    });
    fields.push({
      name: '▶️ Watch',
      value: `[Tune in now](${this.siteUrl})`,
      inline: true,
    });

    return {
      title: `🔴 ${displayName} ${verb}!`,
      url: this.siteUrl,
      description: `**${displayName}** just went live on OneStreamer. Come hang out!`,
      color: LIVE_COLOR,
      fields,
      footer: { text: 'OneStreamer • Live now' },
      timestamp: new Date(info.startTime || Date.now()).toISOString(),
    };
  }

  /** Graceful shutdown — tear down the gateway connection. */
  async stop() {
    try {
      if (this.client && typeof this.client.destroy === 'function') {
        await this.client.destroy();
      }
    } catch (err) {
      logger.error({ err }, '[Discord] error during shutdown');
    } finally {
      this.ready = false;
    }
  }
}

module.exports = DiscordBotService;
