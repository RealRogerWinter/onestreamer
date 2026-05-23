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
    this.ytdlpPath = '/usr/local/bin/yt-dlp'; // Use updated version for better YouTube support

    // YouTube cookies file path (optional - for bypassing bot detection).
    // YOUTUBE_COOKIES_PATH env overrides; defaults to the repo-relative
    // youtube-cookies.txt next to where this service lives. The repo
    // ships config/youtube-cookies.example.txt as the format reference.
    const path = require('path');
    this.youtubeCookiesPath = process.env.YOUTUBE_COOKIES_PATH
      ? path.resolve(process.env.YOUTUBE_COOKIES_PATH)
      : path.join(__dirname, '..', '..', 'youtube-cookies.txt');

    // Check if cookies file exists and has content
    try {
      const fs = require('fs');
      if (fs.existsSync(this.youtubeCookiesPath)) {
        const stats = fs.statSync(this.youtubeCookiesPath);
        if (stats.size > 100) { // More than just header
          this.hasYoutubeCookies = true;
          console.log('🍪 YouTube cookies file found');
        }
      }
    } catch (e) {
      this.hasYoutubeCookies = false;
    }

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
      const platform = this.detectPlatform(url);
      const args = ['-F', '--no-playlist'];

      // Add YouTube cookies if available
      if (platform === 'youtube' && this.hasYoutubeCookies) {
        args.push('--cookies', this.youtubeCookiesPath);
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

    // Check if this is a direct HLS URL (e.g., from Kick API)
    // These are always valid and live
    if (url.includes('.m3u8') || url.includes('playback.live-video.net')) {
      console.log(`📡 Direct HLS URL detected, assuming valid and live`);
      result.valid = true;
      result.isLive = true;
      result.title = 'Live Stream';
      result.qualities = ['best'];
      result.tool = 'direct';
      result.isHLS = true;

      // Cache and return
      this.streamInfoCache.set(cacheKey, {
        timestamp: Date.now(),
        data: result
      });
      return result;
    }

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
      const platform = this.detectPlatform(url);
      const args = ['-j', '--no-playlist', '--no-download'];

      // Add YouTube cookies if available
      if (platform === 'youtube' && this.hasYoutubeCookies) {
        args.push('--cookies', this.youtubeCookiesPath);
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
          // Check for specific YouTube errors
          if (stderr && stderr.includes('Sign in to confirm you\'re not a bot')) {
            reject(new Error(`YouTube bot detection: This video requires authentication. Please add YouTube cookies to ${this.youtubeCookiesPath} (or set YOUTUBE_COOKIES_PATH)`));
          } else if (stderr && stderr.includes('Video unavailable')) {
            reject(new Error('Video unavailable or private'));
          } else {
            reject(new Error(stderr || 'No stream found'));
          }
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Get the direct stream URL for piping to FFmpeg
   * Returns the URL that can be passed to FFmpeg -i
   *
   * NOTE: For live streaming platforms (Twitch, YouTube, Kick), we ALWAYS use pipe mode
   * because extracted URLs contain auth tokens that expire quickly. Streamlink/yt-dlp
   * handle token refresh internally when piping.
   *
   * EXCEPTION: Direct HLS URLs (.m3u8) can be passed directly to FFmpeg
   */
  async getStreamURL(url, quality = 'best') {
    const platform = this.detectPlatform(url);

    // Check if this is a direct HLS URL (e.g., from Kick API)
    // These can be passed directly to FFmpeg without streamlink
    if (url.includes('.m3u8') || url.includes('playback.live-video.net')) {
      console.log(`📡 Using direct HLS URL (no streamlink needed): ${url.substring(0, 80)}...`);
      return {
        success: true,
        streamUrl: url,
        platform: platform === 'unknown' ? 'hls' : platform,
        tool: 'direct',
        quality,
        pipeMode: false, // Direct URL - FFmpeg can read it directly
        isHLS: true
      };
    }

    // Live streaming platforms MUST use pipe mode - direct URLs have expiring tokens
    const liveStreamingPlatforms = ['twitch', 'youtube', 'kick', 'facebook'];
    if (liveStreamingPlatforms.includes(platform)) {
      console.log(`📡 Using pipe mode for ${platform} (auth tokens expire quickly)`);
      return {
        success: true,
        streamUrl: url,
        platform,
        tool: 'streamlink',
        quality,
        pipeMode: true // Pipe streamlink output directly to FFmpeg
      };
    }

    // For other platforms, try direct URL extraction first
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
   * Uses yt-dlp for YouTube (better compatibility), streamlink for others
   */
  createStreamPipe(url, quality = 'best') {
    const platform = this.detectPlatform(url);
    console.log(`🔄 Creating stream pipe for ${url} at quality ${quality} (platform: ${platform})`);

    // Use yt-dlp for YouTube - streamlink has login issues with YouTube
    if (platform === 'youtube') {
      return this._createYtdlpPipe(url, quality);
    }

    // Use streamlink for Twitch, Kick, and other platforms
    return this._createStreamlinkPipe(url, quality);
  }

  /**
   * Create streamlink pipe process
   */
  _createStreamlinkPipe(url, quality) {
    console.log(`📺 Using streamlink for ${url}`);

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
   * Create yt-dlp pipe process (better for YouTube)
   */
  _createYtdlpPipe(url, quality) {
    console.log(`📺 Using yt-dlp for ${url}`);

    const platform = this.detectPlatform(url);

    // Map quality to yt-dlp format selector
    // For YouTube, prefer HLS formats (91-96) or format 18 which have both video+audio
    // HLS formats: 91=144p, 92=240p, 93=360p, 94=480p, 95=720p, 96=1080p
    let formatSelector;
    if (quality === 'best' || quality === 'source') {
      // Prefer HLS 1080p (96), then 720p (95), then combined format 18 (360p), then any best
      formatSelector = '96/95/94/93/18/best';
    } else if (quality === 'worst' || quality === 'audio_only') {
      formatSelector = 'worst/91/139';
    } else {
      // Try to match resolution (e.g., "720p60" -> 720)
      const resMatch = quality.match(/(\d+)p/);
      if (resMatch) {
        const height = parseInt(resMatch[1]);
        if (height >= 1080) {
          formatSelector = '96/95/94/93/18/best';
        } else if (height >= 720) {
          formatSelector = '95/94/93/18/best';
        } else if (height >= 480) {
          formatSelector = '94/93/18/best';
        } else if (height >= 360) {
          formatSelector = '93/18/92/best';
        } else {
          formatSelector = '92/91/18/best';
        }
      } else {
        formatSelector = '95/94/93/18/best';  // Default to 720p
      }
    }

    const args = [
      '-f', formatSelector,
      '-o', '-',              // Output to stdout
      '--no-playlist',        // Don't download playlists
      '--no-part',            // Don't use .part files
      '--no-mtime',           // Don't set mtime
      '--no-warnings',        // Suppress warnings for cleaner output
    ];

    // Add YouTube cookies if available (helps bypass bot detection)
    if (platform === 'youtube' && this.hasYoutubeCookies) {
      args.push('--cookies', this.youtubeCookiesPath);
      console.log('🍪 Using YouTube cookies for authentication');
    }

    args.push(url);

    console.log(`📺 yt-dlp args: ${args.join(' ')}`);

    const process = spawn(this.ytdlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    process.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('ERROR') || msg.includes('error:')) {
        console.error(`❌ yt-dlp error: ${msg}`);
      } else if (msg.includes('[download]') && !msg.includes('ETA')) {
        // Log download progress occasionally (skip ETA spam)
        console.log(`📥 yt-dlp: ${msg.trim()}`);
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
