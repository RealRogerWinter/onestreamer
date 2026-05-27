/**
 * ViewBotRotationService - Manages ViewBot rotation using Socket.IO clients or LiveKit RTMP ingress
 * Supports both MediaSoup (socket-based) and LiveKit (RTMP ingress) backends
 */

const ViewBotSocketClient = require('./ViewBotSocketClient');
const path = require('path');
const fs = require('fs');
const webrtcConfig = require('../config/webrtc.config');

const logger = require('../bootstrap/logger').child({ svc: 'ViewBotRotationService' });

class ViewBotRotationService {
  constructor(serverUrl) {
    this.serverUrl = serverUrl || 'https://127.0.0.1:8443';
    this.bots = [];
    this.currentBot = null;
    this.rotationTimer = null;
    this.cooldowns = new Map();
    this.enabled = false;
    this.livekitViewBotService = null;
    this.livekitViewBotId = null;
    this.isRotating = false; // Prevent concurrent rotations

    // Detect backend
    this.backend = webrtcConfig.backend || 'mediasoup';

    // Settings
    this.settings = {
      minRotationInterval: 60000,   // 1 minute
      maxRotationInterval: 180000,  // 3 minutes
      cooldownDuration: 600000      // 10 minutes
    };

    logger.debug(`🔄 ViewBotRotationService: Initialized (backend: ${this.backend})`);
  }

  /**
   * Set LiveKit ViewBot service (called from server initialization)
   */
  setLiveKitService(livekitViewBotService) {
    this.livekitViewBotService = livekitViewBotService;
    logger.debug('✅ LiveKit ViewBot service registered with ViewBotRotationService');
  }

  /**
   * Set the StreamNotifier (PR 3.1) used to emit `stream-ended` events.
   * Replaces direct use of `global.io.emit('stream-ended', …)` from
   * stopCurrentBot().
   */
  setStreamNotifier(streamNotifier) {
    this.streamNotifier = streamNotifier;
    logger.debug('✅ StreamNotifier registered with ViewBotRotationService');
  }
  
  /**
   * Initialize with media files
   */
  async initialize() {
    logger.debug('📦 ViewBotRotationService: Loading media files...');
    
    // Load ALL MP4 files from uploads
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const mp4Files = files.filter(f => f.endsWith('.mp4'));  // No limit, use all MP4 files
      
      mp4Files.forEach((file, index) => {
        this.bots.push({
          id: `viewbot-${index + 1}`,
          name: path.basename(file, '.mp4'),
          mediaFile: path.join(uploadsDir, file),
          client: null
        });
      });
      
      logger.debug(`📹 Found ${mp4Files.length} video files in uploads folder`);
    }
    
    // Only use bots with real video files, no test patterns
    
    logger.debug(`✅ ViewBotRotationService: Loaded ${this.bots.length} bots`);
    
    // Start rotation if enabled
    if (this.enabled) {
      await this.startRotation();
    }
  }
  
  /**
   * Start rotation
   */
  async startRotation() {
    // CRITICAL: Check if random stream rotation is active - it has priority
    if (global.randomStreamRotationService && global.randomStreamRotationService.isEnabled) {
      logger.debug('🛡️ ViewBotRotationService: Cannot start - Random stream rotation is active');
      return;
    }

    logger.debug('🎬 ViewBotRotationService: Starting rotation...');
    this.enabled = true;

    // Stop current bot if any
    await this.stopCurrentBot();

    // Start first rotation
    await this.rotateToNextBot();
  }
  
  /**
   * Stop rotation
   */
  async stopRotation() {
    logger.debug('⏹️ ViewBotRotationService: Stopping rotation...');
    this.enabled = false;
    
    // Clear rotation timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    // Stop current bot
    await this.stopCurrentBot();
  }
  
  /**
   * Rotate to next bot
   */
  async rotateToNextBot() {
    // CRITICAL: Check if random stream rotation is active - it has priority
    if (global.randomStreamRotationService && global.randomStreamRotationService.isEnabled) {
      logger.debug('🛡️ ViewBotRotationService: BLOCKED - Random stream rotation is active');
      return;
    }

    // Prevent concurrent rotations
    if (this.isRotating) {
      logger.debug('⚠️ ViewBotRotationService: Rotation already in progress, skipping...');
      return;
    }

    this.isRotating = true;
    const rotationStartTime = Date.now();
    logger.debug('🔄 ViewBotRotationService: Rotating to next bot...');
    logger.debug(`🔍 ViewBotRotationService: Current bot before rotation:`, this.currentBot?.id);

    try {
      // Stop current bot
      const stopStartTime = Date.now();
      logger.debug('🔍 ViewBotRotationService: Stopping current bot...');
      await this.stopCurrentBot();
      logger.debug(`🔍 ViewBotRotationService: Current bot stopped (took ${Date.now() - stopStartTime}ms)`);

      // Add a small delay to ensure LiveKit fully removes the participant from the room
      // This prevents multiple viewbots being active simultaneously
      await new Promise(resolve => setTimeout(resolve, 500));
      logger.debug('🔍 ViewBotRotationService: Cleanup delay completed');

      // Select next bot
      const nextBot = this.selectNextBot();

      if (!nextBot) {
        logger.debug('⚠️ No available bots (all on cooldown)');
        this.scheduleNextRotation(30000);
        return;
      }

      // Start the bot
      const startBotTime = Date.now();
      await this.startBot(nextBot);
      logger.debug(`⏱️ ViewBotRotationService: Bot started (took ${Date.now() - startBotTime}ms)`);
      logger.debug(`⏱️ ViewBotRotationService: Total rotation time: ${Date.now() - rotationStartTime}ms`);

      // Schedule next rotation
      const interval = this.getRandomInterval();
      this.scheduleNextRotation(interval);

    } catch (error) {
      logger.error('❌ Rotation error:', error);
      // Retry in 30 seconds
      this.scheduleNextRotation(30000);
    } finally {
      // Always reset rotation flag
      this.isRotating = false;
      logger.debug('✅ ViewBotRotationService: Rotation complete, flag reset');
    }
  }
  
  /**
   * Select next bot respecting cooldowns
   */
  selectNextBot() {
    const now = Date.now();
    
    const availableBots = this.bots.filter(bot => {
      // Must have a media file
      if (!bot.mediaFile) {
        logger.debug(`⚠️ Skipping ${bot.id} - no media file`);
        return false;
      }
      
      // Check cooldown
      const lastPlayed = this.cooldowns.get(bot.id);
      if (!lastPlayed) return true;
      return (now - lastPlayed) > this.settings.cooldownDuration;
    });
    
    if (availableBots.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * availableBots.length);
    return availableBots[randomIndex];
  }
  
  /**
   * Start a bot
   */
  async startBot(bot) {
    logger.debug(`🚀 ViewBotRotationService: Starting ${bot.id} (backend: ${this.backend})`);
    logger.debug(`🔍 ViewBotRotationService: Current bot before start:`, this.currentBot?.id);

    try {
      // Use LiveKit or MediaSoup based on backend
      if (this.backend === 'livekit' && this.livekitViewBotService) {
        await this.startLiveKitBot(bot);
      } else {
        await this.startMediaSoupBot(bot);
      }

      // Mark as current and update cooldown
      this.currentBot = bot;
      this.cooldowns.set(bot.id, Date.now());

      logger.debug(`✅ ViewBotRotationService: ${bot.id} is now streaming`);

    } catch (error) {
      logger.error(`❌ Failed to start ${bot.id}:`, error);

      // Cleanup on failure
      if (bot.client) {
        bot.client.cleanup();
        bot.client = null;
      }

      throw error;
    }
  }

  /**
   * Start LiveKit RTMP ingress bot
   */
  async startLiveKitBot(bot) {
    logger.debug(`🎥 ViewBotRotationService: Starting LiveKit RTMP ingress bot ${bot.id}`);

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
   * Start MediaSoup socket-based bot
   */
  async startMediaSoupBot(bot) {
    logger.debug(`🔍 ViewBotRotationService: Server URL:`, this.serverUrl);

    // Create Socket.IO client for this bot
    bot.client = new ViewBotSocketClient(bot.id, this.serverUrl, bot.mediaFile);

    // Connect to server
    logger.debug(`🔍 ViewBotRotationService: Connecting ${bot.id}...`);
    await bot.client.connect();
    logger.debug(`🔍 ViewBotRotationService: ${bot.id} connected, starting stream...`);

    // Start streaming
    await bot.client.startStreaming();
  }
  
  /**
   * Stop current bot
   */
  async stopCurrentBot() {
    if (!this.currentBot) return;

    const bot = this.currentBot;
    logger.debug(`⏹️ ViewBotRotationService: Stopping ${bot.id} (backend: ${this.backend})...`);

    // Emit stream-ended event BEFORE stopping the bot.
    // PR 3.1: routed through StreamNotifier (chokepoint). The `global.io`
    // fallback matches the LiveKitService / WebRTCViewBotRotation pattern
    // for startup-ordering edge cases — if a future construction path
    // misses the setStreamNotifier setter, the emit still goes out
    // through the legacy access path rather than silently dropping.
    if (this.streamNotifier) {
      logger.debug(`📢 ViewBotRotationService: Emitting stream-ended for ${bot.id}`);
      this.streamNotifier.streamEnded({
        reason: 'rotation',
        previousStreamer: bot.id,
        timestamp: Date.now(),
      });
    } else if (global.io) {
      logger.debug(`📢 ViewBotRotationService: Emitting stream-ended for ${bot.id} (fallback via global.io)`);
      global.io.emit('stream-ended', {
        reason: 'rotation',
        previousStreamer: bot.id,
        timestamp: Date.now(),
      });
    }

    // Stop LiveKit bot
    if (this.backend === 'livekit' && this.livekitViewBotId && this.livekitViewBotService) {
      try {
        await this.livekitViewBotService.stopViewBot(this.livekitViewBotId);
        this.livekitViewBotId = null;
      } catch (error) {
        logger.error(`⚠️ Error stopping LiveKit viewbot ${bot.id}:`, error);
      }
    }

    // Stop MediaSoup socket-based bot
    if (bot.client) {
      try {
        await bot.client.stopStreaming();
      } catch (error) {
        logger.error(`⚠️ Error stopping ${bot.id}:`, error.message);
      }

      // Always cleanup resources
      bot.client.cleanup();
      bot.client = null;
    }

    this.currentBot = null;
    logger.debug(`✅ ViewBotRotationService: ${bot.id} stopped and cleaned up`);
  }
  
  /**
   * Get random interval with weighted probabilities
   */
  getRandomInterval() {
    const { minRotationInterval, maxRotationInterval } = this.settings;
    
    // Roll for special cases
    const roll = Math.random() * 100; // 0-100
    let interval;
    
    if (roll < 0.5) {
      // 0.5% chance: ULTRA RARE - Very long interval (20-45 minutes)
      interval = 1200000 + Math.random() * 1500000; // 20-45 minutes
      logger.debug(`🎲💎 ULTRA RARE: Extremely long interval rolled (0.5% chance)!`);
    } else if (roll < 2.5) {
      // 2% chance: > 10 minutes (10-20 minutes)
      interval = 600000 + Math.random() * 600000; // 10-20 minutes
      logger.debug(`🎲 RARE: Super long interval rolled (2% chance)`);
    } else if (roll < 7.5) {
      // 5% chance total: > 6 minutes (6-10 minutes)
      interval = 360000 + Math.random() * 240000; // 6-10 minutes
      logger.debug(`🎲 UNCOMMON: Long interval rolled (5% chance)`);
    } else if (roll < 11.5) {
      // 4% chance: < 1 minute (15-60 seconds)
      interval = 15000 + Math.random() * 45000; // 15-60 seconds
      logger.debug(`🎲 UNCOMMON: Short interval rolled (4% chance)`);
    } else if (roll < 12) {
      // 0.5% chance: ULTRA RARE - Very short interval (5-15 seconds)
      interval = 5000 + Math.random() * 10000; // 5-15 seconds
      logger.debug(`🎲💎 ULTRA RARE: Lightning fast rotation rolled (0.5% chance)!`);
    } else {
      // 88% chance: Normal range (1-6 minutes by default)
      interval = Math.floor(Math.random() * (maxRotationInterval - minRotationInterval)) + minRotationInterval;
      logger.debug(`🎲 NORMAL: Standard interval rolled (88% chance)`);
    }
    
    logger.debug(`⏱️ Next rotation in ${Math.round(interval / 1000)} seconds (${(interval / 60000).toFixed(1)} minutes)`);
    return interval;
  }
  
  /**
   * Schedule next rotation
   */
  scheduleNextRotation(interval) {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }

    if (!this.enabled) return;

    // CRITICAL: Don't schedule if random stream rotation is active
    if (global.randomStreamRotationService && global.randomStreamRotationService.isEnabled) {
      logger.debug('🛡️ ViewBotRotationService: Not scheduling - Random stream rotation is active');
      return;
    }

    this.rotationTimer = setTimeout(() => {
      this.rotateToNextBot();
    }, interval);
  }
  
  /**
   * Force rotation
   */
  async forceRotation() {
    logger.debug('🔄 ViewBotRotationService: forceRotation() called at', new Date().toISOString());
    logger.debug('🔄 ViewBotRotationService: Forcing rotation...');
    
    // Clear existing timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    // Rotate immediately
    await this.rotateToNextBot();
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      currentBot: this.currentBot?.id || null,
      totalBots: this.bots.length,
      availableNow: this.bots.filter(bot => {
        const lastPlayed = this.cooldowns.get(bot.id);
        if (!lastPlayed) return true;
        return (Date.now() - lastPlayed) > this.settings.cooldownDuration;
      }).length,
      settings: this.settings,
      hasClient: this.currentBot?.client !== null,
      isStreaming: this.currentBot?.client?.isStreaming || false
    };
  }
  
  /**
   * Update settings
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    logger.debug('⚙️ Updated settings:', this.settings);
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    logger.debug('🧹 ViewBotRotationService: Cleaning up...');
    await this.stopRotation();
  }
}

module.exports = ViewBotRotationService;
