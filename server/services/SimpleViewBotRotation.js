/**
 * SimpleViewBotRotation.js - Dead simple viewbot rotation system
 *
 * Features:
 * - One viewbot streaming at a time
 * - Random rotation intervals
 * - Cooldown system to prevent replays
 * - Supports both MediaSoup (GStreamer) and LiveKit (RTMP ingress) backends
 */

const SimpleViewBotSocket = require('./SimpleViewBotSocket');
const { spawn } = require('child_process');
const webrtcConfig = require('../config/webrtc.config');

const logger = require('../bootstrap/logger').child({ svc: 'SimpleViewBotRotation' });
// PR 8.3 (Phase 8): the actual ProcessManager singleton. The previous
// `global.processManager.trackProcess(...)` paths in this file were
// no-ops — `global.processManager` was never assigned. Importing the
// singleton directly makes the registry populate so the shutdown reaper
// can find these PIDs. See ADR-0011 and PR 8.3 in CHANGELOG.
const processManager = require('./ProcessManager');

class SimpleViewBotRotation {
  constructor() {
    // Core state
    this.currentBot = null;
    this.rotationTimer = null;
    this.gstreamerProcess = null;
    this.livekitViewBotService = null;
    this.livekitViewBotId = null;
    this.streamService = null; // Reference to StreamService for real streamer protection
    this.urlViewBotService = null; // Reference to ViewBotURLService for URL stream protection

    // PR 8.2 (Phase 8 — see ADR-0016): observability hook for the watchdog
    // owned by UnifiedViewBotRotation. Updated at the entry of every
    // `rotateToNextBot()` invocation; the watchdog reads it to detect a
    // stalled tick chain.
    this.lastTickAt = null;

    // Bot pool - these should be loaded from config/database
    this.availableBots = [];

    // Cooldowns - Map of botId -> lastPlayedTimestamp
    this.cooldowns = new Map();

    // Settings
    this.settings = {
      minRotationInterval: 30000,  // 30 seconds minimum
      maxRotationInterval: 180000, // 3 minutes maximum
      cooldownDuration: 600000,    // 10 minute cooldown per bot
      enabled: false  // Disabled by default, will be enabled when needed
    };

    // MediaSoup RTP ports (should match server config)
    this.rtpPorts = {
      video: 5004,
      audio: 5006
    };

    // Detect backend
    this.backend = webrtcConfig.backend || 'mediasoup';
    logger.debug(`🎯 SimpleViewBotRotation: Initialized (backend: ${this.backend})`);
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
   * Initialize the rotation system with available bots
   */
  async initialize(bots) {
    this.availableBots = bots;
    logger.debug(`📦 Loaded ${bots.length} viewbots into rotation pool`);
    
    if (this.settings.enabled && this.availableBots.length > 0) {
      await this.startRotation();
    }
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
    
    // Stop current bot
    await this.stopCurrentBot();
  }
  
  /**
   * Rotate to the next viewbot
   */
  async rotateToNextBot() {
    // PR 8.2: record tick attempt BEFORE the early-return guards so the
    // watchdog also detects "blocked-by-real-streamer" wedges (where the
    // loop returns without scheduling the next tick). The watchdog
    // distinguishes wedge causes via its rotation-state context.
    this.lastTickAt = Date.now();
    logger.debug('🔄 Rotating to next viewbot');

    // Check if random rotation is active - it takes priority
    if (global.randomStreamRotationService && global.randomStreamRotationService.isRandomRotationActive()) {
      logger.debug('🛡️ VIEWBOT ROTATION BLOCKED: Random stream rotation is active - viewbots disabled');
      return;
    }

    // CRITICAL: Check if real streamer is active before rotation
    if (this.isRealStreamerActive()) {
      logger.debug('🛡️ VIEWBOT ROTATION BLOCKED: Real streamer is active - will not rotate');
      // Don't schedule next rotation - wait for real streamer to disconnect
      return;
    }

    // Stop current bot
    await this.stopCurrentBot();

    // Select next bot
    const nextBot = this.selectNextBot();

    if (!nextBot) {
      logger.debug('⚠️ No available bots for rotation (all on cooldown?)');
      // Retry in 30 seconds
      this.scheduleNextRotation(30000);
      return;
    }

    // Start the new bot
    await this.startBot(nextBot);

    // Schedule next rotation at random interval
    const interval = this.getRandomInterval();
    this.scheduleNextRotation(interval);
  }
  
  /**
   * Select next bot respecting cooldowns
   */
  selectNextBot() {
    const now = Date.now();
    
    // Filter available bots (not on cooldown)
    const availableBots = this.availableBots.filter(bot => {
      const lastPlayed = this.cooldowns.get(bot.id);
      if (!lastPlayed) return true;
      return (now - lastPlayed) > this.settings.cooldownDuration;
    });
    
    if (availableBots.length === 0) {
      return null;
    }
    
    // Random selection
    const randomIndex = Math.floor(Math.random() * availableBots.length);
    return availableBots[randomIndex];
  }
  
  /**
   * Start a specific bot streaming
   */
  async startBot(bot) {
    try {
      // CRITICAL SAFETY CHECK: Verify no real streamer before starting
      if (this.isRealStreamerActive()) {
        logger.debug(`🛡️ VIEWBOT START BLOCKED: Real streamer is active - cannot start ${bot.id}`);
        return;
      }

      logger.debug(`🚀 Starting viewbot: ${bot.id} (backend: ${this.backend})`);

      // Update state
      this.currentBot = bot;
      this.cooldowns.set(bot.id, Date.now());

      // Use LiveKit or MediaSoup based on backend
      if (this.backend === 'livekit' && this.livekitViewBotService) {
        await this.startLiveKitBot(bot);
      } else {
        await this.startMediaSoupBot(bot);
      }

      logger.debug(`✅ ViewBotRotationService: viewbot-${bot.id} is now streaming`);

      // Emit event for other systems
      this.emitEvent('viewbot-started', { botId: bot.id });

    } catch (error) {
      logger.error(`❌ Failed to start bot ${bot.id}:`, error);
      this.handleBotError(bot);
    }
  }

  /**
   * Start LiveKit RTMP ingress bot
   */
  async startLiveKitBot(bot) {
    logger.debug(`🎥 Starting LiveKit RTMP ingress bot: ${bot.id}`);

    if (!bot.mediaFile) {
      logger.warn(`⚠️ Bot ${bot.id} has no media file, skipping`);
      throw new Error('No media file for LiveKit bot');
    }

    const result = await this.livekitViewBotService.createViewBot({
      videoFile: bot.mediaFile
    });

    if (!result.success) {
      throw new Error(result.message || 'Failed to create LiveKit viewbot');
    }

    this.livekitViewBotId = result.botId;
    logger.debug(`✅ LiveKit viewbot created: ${this.livekitViewBotId}`);
  }

  /**
   * Start MediaSoup GStreamer bot
   */
  async startMediaSoupBot(bot) {
    logger.debug(`🎥 Starting MediaSoup GStreamer bot: ${bot.id}`);

    // Build GStreamer pipeline
    const pipeline = this.buildGStreamerPipeline(bot);

    // PR 8.3 (Phase 8): spawn with `detached: true` so the gst-launch
    // process becomes its own process-group leader. The shutdown reaper
    // uses negative-PID group kill (`kill -SIG -<pid>`), which is a no-op
    // — or worse, signals the wrong group — if the child inherits Node's
    // PGID. Precedent: ViewBotClientService also spawns gst-launch with
    // `detached: !isWindows` for the same reason.
    this.gstreamerProcess = spawn('gst-launch-1.0', pipeline.split(' '), {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });

    // PR 8.3 (Phase 8): register with the actual ProcessManager singleton.
    // Previous `global.processManager.trackProcess(...)` calls were no-ops
    // (the global was never assigned) — the resulting orphan-process leak
    // is what PR 8.3 is closing.
    processManager.registerProcess(bot.id, 'gstreamer', this.gstreamerProcess.pid);

    // PR 8.3 (review fix): deregister on natural exit so the registry
    // doesn't keep a ghost PID. Without this, a gst-launch that exits on
    // its own (EOS, crash, gracefully killed by a per-bot path) leaves an
    // entry behind; the shutdown reaper later sends SIGTERM to a dead or
    // recycled PID. The deregister is fire-and-forget (no await) because
    // it's inside an event handler.
    this.gstreamerProcess.once('exit', () => {
      processManager.onBotStopped(bot.id).catch((err) => {
        logger.error(`[ProcessManager] onBotStopped(${bot.id}) from exit handler failed:`, err.message);
      });
    });

    // Handle process events
    this.gstreamerProcess.on('error', (error) => {
      logger.error(`❌ GStreamer error for ${bot.id}:`, error);
      this.handleBotError(bot);
    });

    this.gstreamerProcess.on('exit', (code) => {
      logger.debug(`📤 GStreamer exited for ${bot.id} with code ${code}`);
      if (code !== 0 && this.currentBot?.id === bot.id) {
        this.handleBotError(bot);
      }
    });

    // Log output for debugging
    this.gstreamerProcess.stdout.on('data', (data) => {
      logger.debug(`[GStreamer ${bot.id}]:`, data.toString());
    });

    this.gstreamerProcess.stderr.on('data', (data) => {
      if (data.toString().includes('ERROR')) {
        logger.error(`[GStreamer ERROR ${bot.id}]:`, data.toString());
      }
    });
  }
  
  /**
   * Stop the current bot
   */
  async stopCurrentBot() {
    if (!this.currentBot) return;

    const botId = this.currentBot.id;
    logger.debug(`⏹️ Stopping viewbot: ${botId} (backend: ${this.backend})`);

    // Stop LiveKit bot
    if (this.backend === 'livekit' && this.livekitViewBotId && this.livekitViewBotService) {
      try {
        await this.livekitViewBotService.stopViewBot(this.livekitViewBotId);
        this.livekitViewBotId = null;
      } catch (error) {
        logger.error(`⚠️ Error stopping LiveKit viewbot ${botId}:`, error);
      }
    }

    // Kill GStreamer process
    if (this.gstreamerProcess) {
      try {
        this.gstreamerProcess.kill('SIGTERM');
        // Force kill after timeout
        setTimeout(() => {
          if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
            this.gstreamerProcess.kill('SIGKILL');
          }
        }, 2000);
      } catch (error) {
        logger.error(`⚠️ Error killing GStreamer for ${botId}:`, error);
      }

      this.gstreamerProcess = null;
    }

    // PR 8.3 (Phase 8): deregister with the ProcessManager so the
    // shutdown reaper doesn't find this PID still in the registry. The
    // `onBotStopped` path also runs `killBotProcesses` for belt-and-braces
    // (process-group SIGKILL on top of the per-handle SIGTERM above).
    try {
      await processManager.onBotStopped(botId);
    } catch (err) {
      logger.error(`⚠️ ProcessManager.onBotStopped(${botId}) failed:`, err.message);
    }

    // Emit event
    this.emitEvent('viewbot-stopped', { botId });

    // Clear current bot
    this.currentBot = null;
  }
  
  /**
   * Build GStreamer pipeline for a bot
   */
  buildGStreamerPipeline(bot) {
    // Use bot's media file or test pattern
    const videoSource = bot.mediaFile 
      ? `filesrc location="${bot.mediaFile}" ! decodebin name=decoder`
      : `videotestsrc pattern=smpte ! video/x-raw,width=1280,height=720,framerate=30/1`;
    
    const audioSource = bot.mediaFile
      ? `decoder. ! audioconvert ! audioresample`
      : `audiotestsrc wave=sine freq=440`;
    
    // Build pipeline for RTP streaming to MediaSoup
    const videoPipeline = `${videoSource} ! videoconvert ! x264enc tune=zerolatency bitrate=1000 ! rtph264pay config-interval=1 pt=102 ! udpsink host=127.0.0.1 port=${this.rtpPorts.video}`;
    
    const audioPipeline = `${audioSource} ! opusenc ! rtpopuspay pt=101 ! udpsink host=127.0.0.1 port=${this.rtpPorts.audio}`;
    
    // Combine pipelines
    return bot.mediaFile 
      ? `${videoSource} decoder. ! videoconvert ! x264enc tune=zerolatency bitrate=1000 ! rtph264pay config-interval=1 pt=102 ! udpsink host=127.0.0.1 port=${this.rtpPorts.video} ${audioPipeline}`
      : `${videoPipeline} ${audioPipeline}`;
  }
  
  /**
   * Get random rotation interval
   */
  getRandomInterval() {
    const { minRotationInterval, maxRotationInterval } = this.settings;
    const interval = Math.floor(Math.random() * (maxRotationInterval - minRotationInterval)) + minRotationInterval;
    logger.debug(`⏱️ Next rotation in ${Math.round(interval / 1000)} seconds`);
    return interval;
  }
  
  /**
   * Schedule next rotation
   */
  scheduleNextRotation(interval) {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }
    
    if (!this.settings.enabled) {
      logger.debug('🚫 Rotation disabled, not scheduling next rotation');
      return;
    }
    
    this.rotationTimer = setTimeout(() => {
      this.rotateToNextBot();
    }, interval);
  }
  
  /**
   * Handle bot streaming error
   */
  handleBotError(bot) {
    logger.error(`🔧 Handling error for bot ${bot.id}`);
    
    // Mark bot with extended cooldown
    this.cooldowns.set(bot.id, Date.now() + this.settings.cooldownDuration);
    
    // Delay before rotating to prevent CPU spike from rapid retries
    setTimeout(() => {
      this.rotateToNextBot();
    }, 5000); // Wait 5 seconds before retry
  }
  
  /**
   * Update rotation settings
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    logger.debug('⚙️ Updated rotation settings:', this.settings);
    
    // Restart rotation if enabled state changed
    if (newSettings.enabled !== undefined) {
      if (newSettings.enabled && this.availableBots.length > 0) {
        this.startRotation();
      } else if (!newSettings.enabled) {
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
      currentBot: this.currentBot?.id || null,
      totalBots: this.availableBots.length,
      availableNow: this.availableBots.filter(bot => {
        const lastPlayed = this.cooldowns.get(bot.id);
        if (!lastPlayed) return true;
        return (Date.now() - lastPlayed) > this.settings.cooldownDuration;
      }).length,
      settings: this.settings,
      nextRotation: this.rotationTimer ? 'scheduled' : 'none'
    };
  }
  
  /**
   * Simple event emitter for integration
   */
  emitEvent(event, data) {
    // This can be replaced with actual event emitter or socket.io emission
    logger.debug(`📡 Event: ${event}`, data);
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
