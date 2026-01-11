/**
 * KickRandomService.js - Find random live Kick streamers
 *
 * Uses a Python helper with curl_cffi to bypass Kick's bot protection.
 * No API key required.
 */

const { spawn } = require('child_process');
const path = require('path');

class KickRandomService {
  constructor() {
    // Cache of recently seen streamers to avoid duplicates
    this.recentStreamers = [];
    this.maxRecentCache = 50;

    // Blocked categories
    this.blockedCategories = new Set([
      'ASMR',
      'Pools, Hot Tubs, and Beaches',
    ]);

    // Viewer range - capped to avoid mega-streamers and increase variety
    this.minViewers = 1;
    this.maxViewers = 5000;

    // Path to Python helper
    this.helperPath = path.join(__dirname, 'kick-api-helper.py');

    console.log('🟢 KickRandomService initialized (using curl_cffi helper)');
  }

  /**
   * Call the Python helper script
   */
  async callHelper(command, ...args) {
    return new Promise((resolve, reject) => {
      const fullArgs = [this.helperPath, command, ...args.map(String)];
      const proc = spawn('python3', fullArgs, {
        timeout: 20000
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('❌ Kick helper error:', stderr);
          reject(new Error(stderr || `Helper exited with code ${code}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse helper output: ${stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });

      // Timeout
      setTimeout(() => {
        proc.kill();
        reject(new Error('Helper timeout'));
      }, 20000);
    });
  }

  /**
   * Get featured/live streams from Kick
   */
  async getLiveStreams(page = 1, limit = 50) {
    try {
      const result = await this.callHelper('live-streams', page, limit);

      if (result.success && result.streams) {
        return result.streams;
      }

      console.warn('⚠️ Kick API returned no streams:', result.error || 'Unknown error');
      return [];
    } catch (error) {
      console.error('❌ Kick API error:', error.message);
      return [];
    }
  }

  /**
   * Get stream info for a specific channel
   */
  async getChannelInfo(username) {
    try {
      const result = await this.callHelper('channel', username);

      if (result.success && result.channel) {
        return result.channel;
      }

      return null;
    } catch (error) {
      console.error(`❌ Error getting Kick channel info for ${username}:`, error.message);
      return null;
    }
  }

  /**
   * Get authenticated playback URL for a channel (includes JWT token)
   */
  async getPlaybackUrl(username) {
    try {
      const result = await this.callHelper('playback-url', username);

      if (result.success && result.playback_url) {
        return result;
      }

      console.warn(`⚠️ No playback URL for ${username}:`, result.error || 'Unknown error');
      return null;
    } catch (error) {
      console.error(`❌ Error getting Kick playback URL for ${username}:`, error.message);
      return null;
    }
  }

  /**
   * Find a random live Kick streamer
   */
  async findRandomStreamer(options = {}) {
    const {
      minViewers = this.minViewers,
      maxViewers = this.maxViewers,
      excludeUsernames = []
    } = options;

    console.log('🔍 Searching for random Kick streamer...');

    try {
      // Get multiple pages for more variety
      const page = Math.floor(Math.random() * 5) + 1; // Random page 1-5
      const streams = await this.getLiveStreams(page, 100);

      if (!streams || streams.length === 0) {
        console.warn('⚠️ No Kick streams found');
        return null;
      }

      // Filter streams
      const filtered = streams.filter(stream => {
        if (!stream.is_live) return false;

        const viewers = stream.viewer_count || stream.viewers || 0;

        // Check viewer count - be lenient with 0 viewers as Kick API often reports 0
        // Only filter if minViewers > 1 or if viewers exceed maxViewers
        if (minViewers > 1 && viewers < minViewers) {
          return false;
        }
        if (viewers > maxViewers) {
          return false;
        }

        // Check blocked categories
        const categoryName = stream.categories?.[0]?.name;
        if (categoryName && this.blockedCategories.has(categoryName)) {
          return false;
        }

        // Check excluded usernames
        const username = stream.channel?.slug;
        if (username && excludeUsernames.includes(username.toLowerCase())) {
          return false;
        }

        // Check recent cache (avoid repeats)
        if (username && this.recentStreamers.includes(username)) {
          return false;
        }

        return true;
      });

      if (filtered.length === 0) {
        console.warn('⚠️ No suitable Kick streams found after filtering');
        return null;
      }

      // Pick random stream
      const randomIndex = Math.floor(Math.random() * filtered.length);
      const selected = filtered[randomIndex];

      const username = selected.channel?.slug;
      const displayName = selected.channel?.user?.username || username;

      // Add to recent cache
      if (username) {
        this.recentStreamers.push(username);
        if (this.recentStreamers.length > this.maxRecentCache) {
          this.recentStreamers.shift();
        }
      }

      const viewers = selected.viewer_count || selected.viewers || 0;
      const categoryName = selected.categories?.[0]?.name || 'Unknown';
      const thumbnailUrl = selected.thumbnail?.src || selected.channel?.user?.profilepic;

      console.log(`✅ Found random Kick streamer: ${displayName} in ${categoryName} (${viewers} viewers)`);

      // Get authenticated playback URL (with JWT token) from the channel API
      // This is crucial because:
      // 1. streamlink doesn't support Kick
      // 2. The basic livestreams API doesn't return authenticated URLs
      let playbackUrl = null;
      const playbackInfo = await this.getPlaybackUrl(username);
      if (playbackInfo && playbackInfo.playback_url) {
        playbackUrl = playbackInfo.playback_url;
        console.log(`   📺 Authenticated Playback URL obtained`);
      } else {
        console.warn(`   ⚠️ Could not get authenticated playback URL for ${username}`);
      }

      return {
        username: username,
        displayName: displayName,
        title: selected.session_title || 'Live on Kick',
        game: categoryName,
        viewers: viewers,
        thumbnailUrl: thumbnailUrl,
        url: `https://kick.com/${username}`,
        playbackUrl: playbackUrl, // Authenticated HLS URL with JWT token
        platform: 'kick',
        startedAt: selected.start_time || selected.created_at
      };

    } catch (error) {
      console.error('❌ Error finding random Kick streamer:', error.message);
      return null;
    }
  }

  /**
   * Check if a streamer is currently live
   */
  async isStreamerLive(username) {
    try {
      const channel = await this.getChannelInfo(username);
      return channel && channel.livestream !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Clear recent streamers cache
   */
  clearRecentCache() {
    this.recentStreamers = [];
    console.log('🧹 Kick recent streamers cache cleared');
  }

  /**
   * Update viewer range
   */
  setViewerRange(min, max) {
    this.minViewers = min;
    this.maxViewers = max;
    console.log(`👁️ Kick viewer range set: ${min} - ${max}`);
  }

  /**
   * Block a category
   */
  blockCategory(categoryName) {
    this.blockedCategories.add(categoryName);
  }

  /**
   * Unblock a category
   */
  unblockCategory(categoryName) {
    this.blockedCategories.delete(categoryName);
  }

  /**
   * Get blocked categories
   */
  getBlockedCategories() {
    return Array.from(this.blockedCategories);
  }
}

module.exports = KickRandomService;
