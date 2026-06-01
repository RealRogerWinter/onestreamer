/**
 * SimpleViewBotRotation.js - viewbot rotation gating
 *
 * Live surface used by the rest of the server:
 * - Real-streamer / URL-stream protection (`isRealStreamerActive`,
 *   `isURLStreamActive`) so viewbots never interrupt a live streamer.
 * - Rotation enable/disable + start/stop (`updateSettings`, `startRotation`,
 *   `stopRotation`, `shutdown`) wired from the URL/random rotation services and
 *   the stream/disconnect socket handlers.
 * - Status reporting (`getStatus`).
 *
 * The actual bot-POOL half (an `availableBots` pool loaded via `initialize()`,
 * per-bot selection/start/stop, cooldowns) was inert — `initialize()` had no
 * live caller, so the pool was always empty and rotation never started a bot.
 * It was removed; `rotateToNextBot()` is now a safe no-op kept only because
 * `startRotation()` still calls it. Live viewbots run via the LiveKit RTMP
 * ingress path (SimpleViewBotRotation → ViewBotLiveKitService is no longer the
 * driver; the legacy MediaSoup/GStreamer backend was removed — ADR-0024).
 */

const logger = require('../bootstrap/logger').child({ svc: 'SimpleViewBotRotation' });

class SimpleViewBotRotation {
  constructor() {
    // Core state
    this.rotationTimer = null;
    this.livekitViewBotService = null;
    this.streamService = null; // Reference to StreamService for real streamer protection
    this.urlViewBotService = null; // Reference to ViewBotURLService for URL stream protection

    // Settings — `enabled` is read/written by the URL + random rotation
    // services (see ViewBotURLService / RandomStreamRotationService /
    // ViewBotCleanupCoordinator) to pause/resume viewbots around real streams.
    this.settings = {
      minRotationInterval: 30000,  // 30 seconds minimum
      maxRotationInterval: 180000, // 3 minutes maximum
      cooldownDuration: 600000,    // 10 minute cooldown per bot
      enabled: false  // Disabled by default, will be enabled when needed
    };

    logger.debug('🎯 SimpleViewBotRotation: Initialized');
  }

  /**
   * Set StreamService reference for real streamer protection
   */
  setStreamService(streamService) {
    this.streamService = streamService;
    logger.debug('✅ StreamService registered with SimpleViewBotRotation for real streamer protection');
  }

  /**
   * Set ViewBotURLService reference for URL stream protection
   * URL streams are treated like real streamers - viewbots cannot interrupt them
   */
  setURLViewBotService(urlViewBotService) {
    this.urlViewBotService = urlViewBotService;
    logger.debug('✅ ViewBotURLService registered with SimpleViewBotRotation for URL stream protection');
  }

  /**
   * Check if a URL stream is currently active
   * URL streams are protected like real streamers
   */
  isURLStreamActive() {
    if (!this.urlViewBotService) {
      return false;
    }

    const isActive = this.urlViewBotService.isURLStreamActive();
    if (isActive) {
      const activeStream = this.urlViewBotService.getActiveURLStream();
      logger.debug(`🛡️ PROTECTION: URL stream ${activeStream?.urlId} is active - viewbots blocked`);
    }
    return isActive;
  }

  /**
   * Check if a real streamer (non-viewbot) OR URL stream is currently active
   */
  isRealStreamerActive() {
    // First check for URL streams - they are treated like real streamers
    if (this.isURLStreamActive()) {
      return true;
    }

    if (!this.streamService) {
      logger.warn('⚠️ SimpleViewBotRotation: No StreamService - cannot check for real streamer');
      return false;
    }

    const currentStreamer = this.streamService.getCurrentStreamer();
    if (!currentStreamer) {
      return false;
    }

    // Check if current streamer is NOT a viewbot
    const isViewbot = currentStreamer.startsWith('viewbot-') ||
                      currentStreamer.includes('viewbot') ||
                      currentStreamer.startsWith('bot-') ||
                      currentStreamer.startsWith('url-stream-'); // URL streams use this prefix

    const isRealStreamer = !isViewbot;

    if (isRealStreamer) {
      logger.debug(`🛡️ PROTECTION: Real streamer ${currentStreamer} is active - viewbots blocked`);
    }

    return isRealStreamer;
  }

  /**
   * Set LiveKit ViewBot service (called from server initialization)
   */
  setLiveKitService(livekitViewBotService) {
    this.livekitViewBotService = livekitViewBotService;
    logger.debug('✅ LiveKit ViewBot service registered with rotation system');
  }

  /**
   * Start the rotation system
   */
  async startRotation() {
    logger.debug('🎬 Starting viewbot rotation system');

    // Check if random rotation is active - it takes priority
    if (global.randomStreamRotationService && global.randomStreamRotationService.isRandomRotationActive()) {
      logger.debug('🛡️ VIEWBOT ROTATION BLOCKED: Random stream rotation is active - viewbots disabled');
      return;
    }

    // Stop any existing rotation
    await this.stopRotation();

    // Start first bot
    await this.rotateToNextBot();
  }
  
  /**
   * Stop the rotation system
   */
  async stopRotation() {
    logger.debug('⏹️ Stopping viewbot rotation');

    // Clear rotation timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  /**
   * Rotate to the next viewbot.
   *
   * No-op: the bot-pool half (selection/start/stop, cooldowns) was inert and
   * removed. Kept as a safe no-op because `startRotation()` still calls it and
   * external callers may still reach `startRotation`. It intentionally does NOT
   * throw and schedules no follow-up tick.
   */
  async rotateToNextBot() {
    // Intentionally empty — see method doc and the file header.
  }

  /**
   * Update rotation settings.
   *
   * Toggling `enabled` is the live behaviour the URL/random rotation services
   * rely on; with the bot pool removed, `startRotation()`/`stopRotation()` are
   * side-effect-safe (start clears+no-op-rotates, stop clears the timer).
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    logger.debug('⚙️ Updated rotation settings:', this.settings);

    // Restart rotation if enabled state changed
    if (newSettings.enabled !== undefined) {
      if (newSettings.enabled) {
        this.startRotation();
      } else {
        this.stopRotation();
      }
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      enabled: this.settings.enabled,
      currentBot: null,
      settings: this.settings,
      nextRotation: this.rotationTimer ? 'scheduled' : 'none'
    };
  }

  /**
   * Clean shutdown
   */
  async shutdown() {
    logger.debug('🛑 Shutting down rotation system');
    await this.stopRotation();
  }
}

// Export singleton instance
module.exports = new SimpleViewBotRotation();
