/**
 * URLStreamExtractorService.js - Extract stream URLs from various platforms
 *
 * Supports: Twitch, YouTube, Kick, and 100+ sites via streamlink
 * Uses streamlink (primary) and yt-dlp (fallback) for URL extraction
 */

const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');

class URLStreamExtractorService extends EventEmitter {
  constructor() {
    super();

    // Platform detection patterns
    this.platformPatterns = {
      twitch: /(?:www\.)?twitch\.tv\/(\w+)/i,
      youtube: /(?:www\.)?(?:youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/i,
      kick: /(?:www\.)?kick\.com\/(\w+)/i,
      facebook: /(?:www\.)?facebook\.com\/.*\/videos\//i,
      dailymotion: /(?:www\.)?dailymotion\.com\//i,
      vimeo: /(?:www\.)?vimeo\.com\//i,
    };

    // Tool paths
    this.streamlinkPath = 'streamlink';
    this.ytdlpPath = 'yt-dlp';

    // Cache for stream info (5 minute TTL)
    this.streamInfoCache = new Map();
    this.cacheTTL = 5 * 60 * 1000;

    console.log('🔗 URLStreamExtractorService initialized');
  }

  /**
   * Detect platform from URL
   */
  detectPlatform(url) {
    for (const [platform, pattern] of Object.entries(this.platformPatterns)) {
      if (pattern.test(url)) {
        return platform;
      }
    }
    return 'unknown';
  }

  /**
   * Extract channel/video ID from URL
   */
  extractIdentifier(url) {
    for (const [platform, pattern] of Object.entries(this.platformPatterns)) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return { platform, identifier: match[1] };
      }
    }
    return { platform: 'unknown', identifier: null };
  }

  /**
   * Get available stream qualities
   */
  async getStreamQualities(url) {
    const platform = this.detectPlatform(url);

    try {
      // Try streamlink first
      const qualities = await this._getStreamlinkQualities(url);
      if (qualities.length > 0) {
        return { success: true, platform, qualities, tool: 'streamlink' };
      }
    } catch (err) {
      console.log(`⚠️ Streamlink quality check failed for ${url}:`, err.message);
    }

    try {
      // Fallback to yt-dlp
      const qualities = await this._getYtdlpQualities(url);
      if (qualities.length > 0) {
        return { success: true, platform, qualities, tool: 'yt-dlp' };
      }
    } catch (err) {
      console.log(`⚠️ yt-dlp quality check failed for ${url}:`, err.message);
    }

    return { success: false, platform, qualities: [], error: 'No streams found' };
  }

  /**
   * Get stream qualities via streamlink
   */
  async _getStreamlinkQualities(url) {
    return new Promise((resolve, reject) => {
      const process = spawn(this.streamlinkPath, ['--json', url], {
        timeout: 30000
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const info = JSON.parse(stdout);
            const qualities = Object.keys(info.streams || {});
            resolve(qualities);
          } catch (e) {
            reject(new Error('Failed to parse streamlink output'));
          }
        } else {
          reject(new Error(stderr || 'Streamlink failed'));
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Get stream qualities via yt-dlp
   */
  async _getYtdlpQualities(url) {
    return new Promise((resolve, reject) => {
      const process = spawn(this.ytdlpPath, ['-F', '--no-playlist', url], {
        timeout: 30000
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (stdout) {
          // Parse format listing
          const qualities = [];
          const lines = stdout.split('\n');
          for (const line of lines) {
            const match = line.match(/^(\d+)\s+(\w+)\s+(\d+x\d+|\d+p)/);
            if (match) {
              qualities.push(`${match[3]} (${match[2]})`);
            }
          }
          // Add common selectors
          if (qualities.length > 0) {
            qualities.unshift('best', 'worst');
          }
          resolve(qualities);
        } else {
          reject(new Error(stderr || 'yt-dlp failed'));
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Validate if URL is a live stream
   */
  async validateStream(url) {
    const platform = this.detectPlatform(url);

    // Check cache first
    const cacheKey = `validate:${url}`;
    const cached = this.streamInfoCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
      return cached.data;
    }

    let result = {
      valid: false,
      isLive: false,
      platform,
      title: null,
      error: null
    };

    try {
      // Try streamlink for live detection
      const info = await this._getStreamlinkInfo(url);
      result.valid = true;
      result.isLive = info.isLive;
      result.title = info.title;
      result.qualities = info.qualities;
      result.tool = 'streamlink';
    } catch (err) {
      // Try yt-dlp as fallback
      try {
        const info = await this._getYtdlpInfo(url);
        result.valid = true;
        result.isLive = info.isLive;
        result.title = info.title;
        result.qualities = info.qualities;
        result.tool = 'yt-dlp';
      } catch (err2) {
        result.error = err2.message || 'Failed to validate stream';
      }
    }

    // Cache result
    this.streamInfoCache.set(cacheKey, {
      timestamp: Date.now(),
      data: result
    });

    return result;
  }

  /**
   * Get stream info via streamlink
   */
  async _getStreamlinkInfo(url) {
    return new Promise((resolve, reject) => {
      const process = spawn(this.streamlinkPath, ['--json', url], {
        timeout: 30000
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (stdout) {
          try {
            const info = JSON.parse(stdout);
            resolve({
              isLive: Object.keys(info.streams || {}).length > 0,
              title: info.metadata?.title || info.metadata?.author || 'Unknown',
              qualities: Object.keys(info.streams || {})
            });
          } catch (e) {
            reject(new Error('Failed to parse streamlink output'));
          }
        } else {
          reject(new Error(stderr || 'No stream found'));
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Get stream info via yt-dlp
   */
  async _getYtdlpInfo(url) {
    return new Promise((resolve, reject) => {
      const process = spawn(this.ytdlpPath, [
        '-j', '--no-playlist', '--no-download', url
      ], {
        timeout: 30000
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (stdout) {
          try {
            const info = JSON.parse(stdout);
            resolve({
              isLive: info.is_live === true,
              title: info.title || info.fulltitle || 'Unknown',
              qualities: (info.formats || []).map(f => f.format_note || f.format_id).filter(Boolean)
            });
          } catch (e) {
            reject(new Error('Failed to parse yt-dlp output'));
          }
        } else {
          reject(new Error(stderr || 'No stream found'));
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Get the direct stream URL for piping to FFmpeg
   * Returns the URL that can be passed to FFmpeg -i
   */
  async getStreamURL(url, quality = 'best') {
    const platform = this.detectPlatform(url);

    try {
      // Try streamlink first (preferred for live streams)
      const streamUrl = await this._getStreamlinkURL(url, quality);
      return {
        success: true,
        streamUrl,
        platform,
        tool: 'streamlink',
        pipeMode: false // Direct URL mode
      };
    } catch (err) {
      console.log(`⚠️ Streamlink URL extraction failed:`, err.message);
    }

    try {
      // Try yt-dlp
      const streamUrl = await this._getYtdlpURL(url, quality);
      return {
        success: true,
        streamUrl,
        platform,
        tool: 'yt-dlp',
        pipeMode: false
      };
    } catch (err) {
      console.log(`⚠️ yt-dlp URL extraction failed:`, err.message);
    }

    // Fallback: Use pipe mode (streamlink outputs to stdout)
    return {
      success: true,
      streamUrl: url,
      platform,
      tool: 'streamlink',
      quality,
      pipeMode: true // Will pipe streamlink output to FFmpeg
    };
  }

  /**
   * Get stream URL via streamlink --stream-url
   */
  async _getStreamlinkURL(url, quality) {
    return new Promise((resolve, reject) => {
      const process = spawn(this.streamlinkPath, ['--stream-url', url, quality], {
        timeout: 30000
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || 'Failed to get stream URL'));
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Get stream URL via yt-dlp -g
   */
  async _getYtdlpURL(url, quality) {
    return new Promise((resolve, reject) => {
      const args = ['-g', '--no-playlist'];

      // Map quality to format selector
      if (quality === 'best') {
        args.push('-f', 'best[ext=mp4]/best');
      } else if (quality === 'worst') {
        args.push('-f', 'worst');
      } else {
        // Try to match resolution
        const resMatch = quality.match(/(\d+)p/);
        if (resMatch) {
          args.push('-f', `best[height<=${resMatch[1]}]`);
        }
      }

      args.push(url);

      const process = spawn(this.ytdlpPath, args, {
        timeout: 30000
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          // yt-dlp may return multiple URLs (video + audio), take first
          const urls = stdout.trim().split('\n');
          resolve(urls[0]);
        } else {
          reject(new Error(stderr || 'Failed to get stream URL'));
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Create a process that pipes stream data to stdout
   * Used when direct URL extraction fails
   */
  createStreamPipe(url, quality = 'best') {
    console.log(`🔄 Creating stream pipe for ${url} at quality ${quality}`);

    const process = spawn(this.streamlinkPath, [
      '--stdout',
      '--force', // Don't prompt for confirmation
      url,
      quality
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    process.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error(`❌ Streamlink error: ${msg}`);
      }
    });

    return process;
  }

  /**
   * Test if tools are available
   */
  async testTools() {
    const results = {
      streamlink: false,
      ytdlp: false
    };

    try {
      execSync(`${this.streamlinkPath} --version`, { timeout: 5000 });
      results.streamlink = true;
    } catch (e) {
      console.warn('⚠️ streamlink not available');
    }

    try {
      execSync(`${this.ytdlpPath} --version`, { timeout: 5000 });
      results.ytdlp = true;
    } catch (e) {
      console.warn('⚠️ yt-dlp not available');
    }

    return results;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.streamInfoCache.clear();
    console.log('🗑️ Stream info cache cleared');
  }
}

module.exports = URLStreamExtractorService;
