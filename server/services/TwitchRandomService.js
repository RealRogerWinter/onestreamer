/**
 * TwitchRandomService.js - Find random live Twitch streamers
 *
 * Uses Twitch Helix API to discover random live streams.
 * Requires TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env
 */

const https = require('https');

class TwitchRandomService {
  constructor() {
    this.clientId = process.env.TWITCH_CLIENT_ID;
    this.clientSecret = process.env.TWITCH_CLIENT_SECRET;
    this.accessToken = null;
    this.tokenExpiry = 0;

    // Cache of recently seen streamers to avoid duplicates
    this.recentStreamers = [];
    this.maxRecentCache = 50;

    // Blocked categories (games/categories to skip)
    this.blockedCategories = new Set([
      'ASMR',               // May have content issues
      'Pools, Hot Tubs, and Beaches', // May have content issues
    ]);

    // Viewer range - capped to avoid mega-streamers and increase variety
    this.minViewers = 1;
    this.maxViewers = 5000;

    // PR-W3: WhitelistService is injected when ADR-0010's gate is active.
    // When set, candidate filtering goes through it; when null, the legacy
    // local blockedCategories Set above is the only filter (defense-in-depth
    // for hosts that haven't deployed PR-W1).
    this.whitelistService = null;

    console.log('🎮 TwitchRandomService initialized');

    if (!this.clientId || !this.clientSecret) {
      console.warn('⚠️ TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET not set - random Twitch discovery will not work');
    }
  }

  /**
   * Inject the WhitelistService (ADR-0010, PR-W3). When set, candidate
   * filtering consults it instead of the local blockedCategories Set. The
   * rotation service fans this out from its own setter.
   */
  setWhitelistService(whitelistService) {
    this.whitelistService = whitelistService;
    console.log('✅ WhitelistService registered with TwitchRandomService');
  }

  /**
   * Check if service is configured
   */
  isConfigured() {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Get OAuth access token from Twitch
   */
  async getAccessToken() {
    if (!this.isConfigured()) {
      throw new Error('Twitch API not configured. Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET');
    }

    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    console.log('🔑 Fetching new Twitch access token...');

    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials'
      }).toString();

      const options = {
        hostname: 'id.twitch.tv',
        port: 443,
        path: '/oauth2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) {
              this.accessToken = json.access_token;
              this.tokenExpiry = Date.now() + (json.expires_in * 1000);
              console.log('✅ Twitch access token obtained');
              resolve(this.accessToken);
            } else {
              reject(new Error(json.message || 'Failed to get access token'));
            }
          } catch (e) {
            reject(new Error('Failed to parse Twitch token response'));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Make authenticated request to Twitch API
   */
  async twitchRequest(path) {
    const token = await this.getAccessToken();

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.twitch.tv',
        port: 443,
        path: path,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Client-Id': this.clientId
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error('Failed to parse Twitch API response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Get list of live streams from Twitch
   */
  async getLiveStreams(options = {}) {
    const {
      language = 'en',
      first = 100,
      gameId = null
    } = options;

    let path = `/helix/streams?first=${first}&language=${language}`;
    if (gameId) {
      path += `&game_id=${gameId}`;
    }

    const response = await this.twitchRequest(path);
    return response.data || [];
  }

  /**
   * Get list of top games/categories
   */
  async getTopGames(first = 100) {
    const response = await this.twitchRequest(`/helix/games/top?first=${first}`);
    return response.data || [];
  }

  /**
   * Get streams from a random category for better variety
   * This avoids the bias toward mega-streamers by picking a random game first
   */
  async getStreamsFromRandomCategory(options = {}) {
    const { language = 'en', first = 100 } = options;

    try {
      // Get top 100 categories - this includes a good mix of popular and niche games
      const games = await this.getTopGames(100);

      if (!games || games.length === 0) {
        console.warn('⚠️ No games found, falling back to general streams');
        return { streams: await this.getLiveStreams({ language, first }), category: null };
      }

      // Pick a random category (weighted toward variety, not just top games)
      // Use square root weighting to give smaller categories better odds
      const weightedIndex = Math.floor(Math.pow(Math.random(), 0.7) * games.length);
      const randomGame = games[weightedIndex];

      console.log(`🎲 Selected random category: ${randomGame.name}`);

      // Get streams from this category
      const streams = await this.getLiveStreams({
        language,
        first,
        gameId: randomGame.id
      });

      return { streams, category: randomGame.name };
    } catch (error) {
      console.error('❌ Error getting streams from random category:', error.message);
      // Fallback to general streams
      return { streams: await this.getLiveStreams({ language, first }), category: null };
    }
  }

  /**
   * Find a random live Twitch streamer
   */
  async findRandomStreamer(options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Twitch API not configured');
    }

    const {
      language = 'en',
      minViewers = this.minViewers,
      maxViewers = this.maxViewers,
      preferredCategories = null, // Array of game IDs, or null for any
      excludeUsernames = [],
      useCategoryDiversification = true // NEW: use random category selection for variety
    } = options;

    console.log('🔍 Searching for random Twitch streamer...');

    try {
      let streams = [];
      let selectedCategory = null;

      // If preferred categories, get streams from those
      if (preferredCategories && preferredCategories.length > 0) {
        for (const gameId of preferredCategories) {
          const gameStreams = await this.getLiveStreams({ language, gameId, first: 50 });
          streams = streams.concat(gameStreams);
        }
      } else if (useCategoryDiversification) {
        // NEW: Use category diversification for better variety
        // This picks a random game category first, then selects from streams in that category
        const result = await this.getStreamsFromRandomCategory({ language, first: 100 });
        streams = result.streams;
        selectedCategory = result.category;
      } else {
        // Fallback: Get general live streams (biased toward top streamers)
        streams = await this.getLiveStreams({ language, first: 100 });
      }

      // Step 1: cheap local filters (viewer count, exclusions, recent cache).
      // These run before the whitelist filter so we don't waste Helix API
      // budget on candidates that wouldn't be picked anyway.
      let candidates = streams.filter(stream => {
        if (stream.viewer_count < minViewers || stream.viewer_count > maxViewers) {
          return false;
        }
        if (excludeUsernames.includes(stream.user_login.toLowerCase())) {
          return false;
        }
        if (this.recentStreamers.includes(stream.user_login)) {
          return false;
        }
        // Legacy fallback: when WhitelistService isn't wired (PR-W1 not
        // deployed yet on this host), the local blockedCategories Set is
        // still the only line of defense. When the whitelist IS wired,
        // this is redundant (the seed migrates these entries into the DB
        // blacklist) and the whitelist check below is authoritative.
        if (!this.whitelistService && this.blockedCategories.has(stream.game_name)) {
          return false;
        }
        return true;
      });

      // Step 2: whitelist gate (ADR-0010, PR-W3). Skipped entirely when no
      // service is wired. When wired, we first attach CCL data (one batched
      // /helix/channels call), then call filterCandidates which evaluates
      // mode + per-platform allow/block lists + mature/CCL gates.
      if (this.whitelistService && candidates.length > 0) {
        try {
          candidates = await this._attachCclData(candidates);
        } catch (cclErr) {
          // CCL fetch failure shouldn't tank the rotation — fall through
          // with empty CCL data so the mature_flag / ccl_gate checks are
          // effectively no-ops. The streamer/category lists still apply.
          console.warn(`⚠️ TwitchRandomService: CCL fetch failed (${cclErr.message}); proceeding without CCL data`);
        }
        const shaped = candidates.map(stream => ({
          raw: stream,
          login: stream.user_login,
          currentGameName: stream.game_name,
          isMature: stream.is_mature === true,
          ccls: stream._ccls || [],
        }));
        candidates = this.whitelistService
          .filterCandidates('twitch', shaped)
          .map(s => s.raw);
      }

      const filtered = candidates;

      if (filtered.length === 0) {
        console.warn('⚠️ No suitable streams found');
        return null;
      }

      // Pick random stream
      const randomIndex = Math.floor(Math.random() * filtered.length);
      const selected = filtered[randomIndex];

      // Add to recent cache
      this.recentStreamers.push(selected.user_login);
      if (this.recentStreamers.length > this.maxRecentCache) {
        this.recentStreamers.shift();
      }

      const categoryNote = selectedCategory ? ` (from random category: ${selectedCategory})` : '';
      console.log(`✅ Found random streamer: ${selected.user_name} playing ${selected.game_name} (${selected.viewer_count} viewers)${categoryNote}`);

      return {
        username: selected.user_login,
        displayName: selected.user_name,
        title: selected.title,
        game: selected.game_name,
        viewers: selected.viewer_count,
        thumbnailUrl: selected.thumbnail_url,
        url: `https://twitch.tv/${selected.user_login}`,
        language: selected.language,
        startedAt: selected.started_at
      };

    } catch (error) {
      console.error('❌ Error finding random streamer:', error.message);
      throw error;
    }
  }

  /**
   * Validate that a streamer is currently live
   */
  async isStreamerLive(username) {
    try {
      const response = await this.twitchRequest(`/helix/streams?user_login=${username}`);
      return response.data && response.data.length > 0;
    } catch (error) {
      console.error(`❌ Error checking if ${username} is live:`, error.message);
      return false;
    }
  }

  /**
   * PR-W4: snapshot of the current stream state for drift checks. Returns
   * the fields `WhitelistService.checkAllowed` needs to decide whether a
   * currently-live whitelisted streamer is still in policy. Returns null
   * when the streamer is offline.
   *
   * Two API calls: /helix/streams for game + is_mature, then
   * /helix/channels for content_classification_labels. The CCL call is
   * batched/parallel-safe but for a single user the cost is negligible.
   */
  async getCurrentStreamSnapshot(username) {
    try {
      const streamsResp = await this.twitchRequest(`/helix/streams?user_login=${encodeURIComponent(username)}`);
      const stream = streamsResp.data && streamsResp.data[0];
      if (!stream) return null;

      let ccls = [];
      try {
        const channelsResp = await this.twitchRequest(`/helix/channels?broadcaster_id=${encodeURIComponent(stream.user_id)}`);
        const channel = channelsResp.data && channelsResp.data[0];
        if (channel) ccls = channel.content_classification_labels || [];
      } catch (e) {
        // Non-fatal — proceed without CCL data, the drift check still
        // applies streamer/category gates.
      }

      return {
        platform: 'twitch',
        login: stream.user_login,
        currentGameName: stream.game_name,
        isMature: stream.is_mature === true,
        ccls,
      };
    } catch (error) {
      console.error(`❌ Twitch drift check failed for ${username}:`, error.message);
      return null;
    }
  }

  /**
   * Get streamer info by username
   */
  async getStreamerInfo(username) {
    try {
      const response = await this.twitchRequest(`/helix/users?login=${username}`);
      if (response.data && response.data.length > 0) {
        return response.data[0];
      }
      return null;
    } catch (error) {
      console.error(`❌ Error getting streamer info for ${username}:`, error.message);
      return null;
    }
  }

  /**
   * Clear recent streamers cache (for testing or reset)
   */
  clearRecentCache() {
    this.recentStreamers = [];
    console.log('🧹 Recent streamers cache cleared');
  }

  /**
   * Add category to blocked list
   */
  blockCategory(categoryName) {
    this.blockedCategories.add(categoryName);
    console.log(`🚫 Blocked category: ${categoryName}`);
  }

  /**
   * Remove category from blocked list
   */
  unblockCategory(categoryName) {
    this.blockedCategories.delete(categoryName);
    console.log(`✅ Unblocked category: ${categoryName}`);
  }

  /**
   * Get current blocked categories
   */
  getBlockedCategories() {
    return Array.from(this.blockedCategories);
  }

  /**
   * Update viewer range settings
   */
  setViewerRange(min, max) {
    this.minViewers = min;
    this.maxViewers = max;
    console.log(`👁️ Viewer range set: ${min} - ${max}`);
  }

  /**
   * PR-W3: attach `content_classification_labels` to each candidate by
   * calling /helix/channels in batches of 100. Mutates input objects in
   * place (adds `_ccls`) and returns the same array. Used by the whitelist
   * filter so the CCL gate can reject mature-labeled streams even when
   * the streamer is on the allowlist.
   *
   * Failure is the caller's problem — they can either propagate or fall
   * through with empty CCL data; we don't swallow here.
   */
  async _attachCclData(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return candidates;

    const idsToFetch = Array.from(new Set(
      candidates.map(c => c.user_id).filter(Boolean)
    ));
    if (idsToFetch.length === 0) return candidates;

    const cclByUserId = new Map();
    for (let i = 0; i < idsToFetch.length; i += 100) {
      const batch = idsToFetch.slice(i, i + 100);
      const query = batch.map(id => `broadcaster_id=${encodeURIComponent(id)}`).join('&');
      const resp = await this.twitchRequest(`/helix/channels?${query}`);
      for (const row of (resp && resp.data) || []) {
        cclByUserId.set(row.broadcaster_id, row.content_classification_labels || []);
      }
    }

    for (const c of candidates) {
      c._ccls = cclByUserId.get(c.user_id) || [];
    }
    return candidates;
  }
}

module.exports = TwitchRandomService;
