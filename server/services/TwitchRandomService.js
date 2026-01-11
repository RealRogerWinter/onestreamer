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

    console.log('🎮 TwitchRandomService initialized');

    if (!this.clientId || !this.clientSecret) {
      console.warn('⚠️ TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET not set - random Twitch discovery will not work');
    }
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

      // Filter streams
      const filtered = streams.filter(stream => {
        // Check viewer count
        if (stream.viewer_count < minViewers || stream.viewer_count > maxViewers) {
          return false;
        }

        // Check blocked categories
        if (this.blockedCategories.has(stream.game_name)) {
          return false;
        }

        // Check excluded usernames
        if (excludeUsernames.includes(stream.user_login.toLowerCase())) {
          return false;
        }

        // Check recent cache (avoid repeats)
        if (this.recentStreamers.includes(stream.user_login)) {
          return false;
        }

        return true;
      });

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
}

module.exports = TwitchRandomService;
