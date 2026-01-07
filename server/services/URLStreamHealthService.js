/**
 * URLStreamHealthService.js - Monitor health of URL streams
 *
 * Features:
 * - Periodic source URL validation
 * - FFmpeg stats monitoring
 * - Connection health tracking
 * - Automatic alerts on issues
 */

const EventEmitter = require('events');
const { spawn } = require('child_process');

class URLStreamHealthService extends EventEmitter {
  constructor(viewBotURLService) {
    super();

    this.urlService = viewBotURLService;

    // Health check configuration
    this.config = {
      sourceCheckInterval: 30000, // Check source every 30 seconds
      statsInterval: 10000,       // Check FFmpeg stats every 10 seconds
      staleThreshold: 60000,      // Consider stale after 60s no progress
      enabled: true
    };

    // Health data per stream
    this.healthData = new Map(); // urlId -> health metrics

    // Timers
    this.checkTimer = null;

    console.log('🏥 URLStreamHealthService initialized');
  }

  /**
   * Start health monitoring
   */
  start() {
    if (this.checkTimer) {
      this.stop();
    }

    console.log('🏥 Starting URL stream health monitoring');
    this.config.enabled = true;

    this.checkTimer = setInterval(() => {
      this._runHealthChecks();
    }, this.config.sourceCheckInterval);

    // Run initial check
    this._runHealthChecks();
  }

  /**
   * Stop health monitoring
   */
  stop() {
    console.log('🏥 Stopping URL stream health monitoring');
    this.config.enabled = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Run health checks on all active streams
   */
  async _runHealthChecks() {
    const streams = this.urlService.getAllStreams();

    for (const stream of streams) {
      if (stream.status === 'streaming') {
        await this._checkStreamHealth(stream.urlId);
      }
    }
  }

  /**
   * Check health of a specific stream
   */
  async _checkStreamHealth(urlId) {
    const stream = this.urlService.getStreamStatus(urlId);
    if (!stream) return;

    // Get or create health data
    let health = this.healthData.get(urlId);
    if (!health) {
      health = {
        urlId,
        lastCheck: Date.now(),
        sourceStatus: 'unknown',
        ffmpegStatus: 'unknown',
        frameCount: 0,
        lastFrameTime: Date.now(),
        errors: [],
        warnings: []
      };
      this.healthData.set(urlId, health);
    }

    // Check source stream is still live
    try {
      const sourceHealth = await this._checkSourceLive(stream.sourceUrl);
      health.sourceStatus = sourceHealth.isLive ? 'live' : 'offline';
      health.sourceTitle = sourceHealth.title;

      if (!sourceHealth.isLive) {
        this._addWarning(health, 'Source stream appears offline');
        this.emit('source-offline', { urlId, sourceUrl: stream.sourceUrl });
      }
    } catch (err) {
      health.sourceStatus = 'error';
      this._addError(health, `Source check failed: ${err.message}`);
    }

    // Check if stream is stale (no progress)
    if (health.lastFrameTime && (Date.now() - health.lastFrameTime > this.config.staleThreshold)) {
      health.ffmpegStatus = 'stale';
      this._addWarning(health, 'No FFmpeg progress detected');
      this.emit('stream-stale', { urlId });
    } else {
      health.ffmpegStatus = 'active';
    }

    health.lastCheck = Date.now();

    // Emit health update
    this.emit('health-update', {
      urlId,
      health: this.getHealthSummary(urlId)
    });
  }

  /**
   * Check if source URL is still live
   */
  async _checkSourceLive(url) {
    return new Promise((resolve, reject) => {
      // Quick check using streamlink
      const process = spawn('streamlink', ['--json', url], {
        timeout: 15000
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
            const isLive = Object.keys(info.streams || {}).length > 0;
            resolve({
              isLive,
              title: info.metadata?.title || 'Unknown'
            });
          } catch (e) {
            resolve({ isLive: false, title: null });
          }
        } else {
          resolve({ isLive: false, title: null });
        }
      });

      process.on('error', (err) => {
        reject(err);
      });

      // Timeout fallback
      setTimeout(() => {
        if (!process.killed) {
          process.kill();
          resolve({ isLive: false, title: null });
        }
      }, 15000);
    });
  }

  /**
   * Update FFmpeg progress (called from ViewBotURLService)
   */
  updateFFmpegProgress(urlId, stats) {
    let health = this.healthData.get(urlId);
    if (!health) {
      health = {
        urlId,
        lastCheck: Date.now(),
        sourceStatus: 'unknown',
        ffmpegStatus: 'active',
        frameCount: 0,
        lastFrameTime: Date.now(),
        errors: [],
        warnings: []
      };
      this.healthData.set(urlId, health);
    }

    health.frameCount = stats.frame || health.frameCount;
    health.lastFrameTime = Date.now();
    health.ffmpegStatus = 'active';
    health.bitrate = stats.bitrate;
    health.fps = stats.fps;
    health.time = stats.time;
  }

  /**
   * Add warning to health data
   */
  _addWarning(health, message) {
    const warning = {
      message,
      timestamp: Date.now()
    };
    health.warnings.push(warning);

    // Keep only last 10 warnings
    if (health.warnings.length > 10) {
      health.warnings.shift();
    }

    console.warn(`⚠️ URL Stream ${health.urlId}: ${message}`);
  }

  /**
   * Add error to health data
   */
  _addError(health, message) {
    const error = {
      message,
      timestamp: Date.now()
    };
    health.errors.push(error);

    // Keep only last 10 errors
    if (health.errors.length > 10) {
      health.errors.shift();
    }

    console.error(`❌ URL Stream ${health.urlId}: ${message}`);
  }

  /**
   * Get health summary for a stream
   */
  getHealthSummary(urlId) {
    const health = this.healthData.get(urlId);
    if (!health) return null;

    const now = Date.now();

    return {
      urlId,
      overall: this._calculateOverallHealth(health),
      sourceStatus: health.sourceStatus,
      ffmpegStatus: health.ffmpegStatus,
      uptime: health.lastFrameTime ? now - health.lastFrameTime : null,
      frameCount: health.frameCount,
      bitrate: health.bitrate,
      fps: health.fps,
      lastCheck: health.lastCheck,
      recentErrors: health.errors.slice(-3),
      recentWarnings: health.warnings.slice(-3)
    };
  }

  /**
   * Calculate overall health score
   */
  _calculateOverallHealth(health) {
    let score = 100;

    // Source status
    if (health.sourceStatus === 'offline') score -= 50;
    if (health.sourceStatus === 'error') score -= 30;

    // FFmpeg status
    if (health.ffmpegStatus === 'stale') score -= 40;
    if (health.ffmpegStatus === 'error') score -= 30;

    // Recent errors
    score -= health.errors.filter(e => Date.now() - e.timestamp < 60000).length * 10;

    // Recent warnings
    score -= health.warnings.filter(w => Date.now() - w.timestamp < 60000).length * 5;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get all health summaries
   */
  getAllHealthSummaries() {
    const summaries = [];
    for (const urlId of this.healthData.keys()) {
      const summary = this.getHealthSummary(urlId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * Clear health data for a stream
   */
  clearHealthData(urlId) {
    this.healthData.delete(urlId);
  }

  /**
   * Clean shutdown
   */
  shutdown() {
    this.stop();
    this.healthData.clear();
  }
}

module.exports = URLStreamHealthService;
