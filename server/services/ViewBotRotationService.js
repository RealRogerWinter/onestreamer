/**
 * ViewBotRotationService - Manages ViewBot rotation using Socket.IO clients or LiveKit RTMP ingress
 * Supports both MediaSoup (socket-based) and LiveKit (RTMP ingress) backends
 */

const ViewBotSocketClient = require('./ViewBotSocketClient');
const path = require('path');
const fs = require('fs');
const webrtcConfig = require('../config/webrtc.config');

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

    console.log(`🔄 ViewBotRotationService: Initialized (backend: ${this.backend})`);
  }

  /**
   * Set LiveKit ViewBot service (called from server initialization)
   */
  setLiveKitService(livekitViewBotService) {
    this.livekitViewBotService = livekitViewBotService;
    console.log('✅ LiveKit ViewBot service registered with ViewBotRotationService');
  }
  
  /**
   * Initialize with media files
   */
  async initialize() {
    console.log('📦 ViewBotRotationService: Loading media files...');
    
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
      
      console.log(`📹 Found ${mp4Files.length} video files in uploads folder`);
    }
    
    // Only use bots with real video files, no test patterns
    
    console.log(`✅ ViewBotRotationService: Loaded ${this.bots.length} bots`);
    
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
      console.log('🛡️ ViewBotRotationService: Cannot start - Random stream rotation is active');
      return;
    }

    console.log('🎬 ViewBotRotationService: Starting rotation...');
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
    console.log('⏹️ ViewBotRotationService: Stopping rotation...');
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
      console.log('🛡️ ViewBotRotationService: BLOCKED - Random stream rotation is active');
      return;
    }

    // Prevent concurrent rotations
    if (this.isRotating) {
      console.log('⚠️ ViewBotRotationService: Rotation already in progress, skipping...');
      return;
    }

    this.isRotating = true;
    const rotationStartTime = Date.now();
    console.log('🔄 ViewBotRotationService: Rotating to next bot...');
    console.log(`🔍 ViewBotRotationService: Current bot before rotation:`, this.currentBot?.id);

    try {
      // Stop current bot
      const stopStartTime = Date.now();
      console.log('🔍 ViewBotRotationService: Stopping current bot...');
      await this.stopCurrentBot();
      console.log(`🔍 ViewBotRotationService: Current bot stopped (took ${Date.now() - stopStartTime}ms)`);

      // Add a small delay to ensure LiveKit fully removes the participant from the room
      // This prevents multiple viewbots being active simultaneously
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('🔍 ViewBotRotationService: Cleanup delay completed');

      // Select next bot
      const nextBot = this.selectNextBot();

      if (!nextBot) {
        console.log('⚠️ No available bots (all on cooldown)');
        this.scheduleNextRotation(30000);
        return;
      }

      // Start the bot
      const startBotTime = Date.now();
      await this.startBot(nextBot);
      console.log(`⏱️ ViewBotRotationService: Bot started (took ${Date.now() - startBotTime}ms)`);
      console.log(`⏱️ ViewBotRotationService: Total rotation time: ${Date.now() - rotationStartTime}ms`);

      // Schedule next rotation
      const interval = this.getRandomInterval();
      this.scheduleNextRotation(interval);

    } catch (error) {
      console.error('❌ Rotation error:', error);
      // Retry in 30 seconds
      this.scheduleNextRotation(30000);
    } finally {
      // Always reset rotation flag
      this.isRotating = false;
      console.log('✅ ViewBotRotationService: Rotation complete, flag reset');
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
        console.log(`⚠️ Skipping ${bot.id} - no media file`);
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
    console.log(`🚀 ViewBotRotationService: Starting ${bot.id} (backend: ${this.backend})`);
    console.log(`🔍 ViewBotRotationService: Current bot before start:`, this.currentBot?.id);

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

      console.log(`✅ ViewBotRotationService: ${bot.id} is now streaming`);

    } catch (error) {
      console.error(`❌ Failed to start ${bot.id}:`, error);

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
    console.log(`🎥 ViewBotRotationService: Starting LiveKit RTMP ingress bot ${bot.id}`);

    const result = await this.livekitViewBotService.createViewBot({
      videoFile: bot.mediaFile
    });

    if (!result.success) {
      throw new Error(result.message || 'Failed to create LiveKit viewbot');
    }

    this.livekitViewBotId = result.botId;
    console.log(`✅ LiveKit viewbot created: ${this.livekitViewBotId}`);
  }

  /**
   * Start MediaSoup socket-based bot
   */
  async startMediaSoupBot(bot) {
    console.log(`🔍 ViewBotRotationService: Server URL:`, this.serverUrl);

    // Create Socket.IO client for this bot
    bot.client = new ViewBotSocketClient(bot.id, this.serverUrl, bot.mediaFile);

    // Connect to server
    console.log(`🔍 ViewBotRotationService: Connecting ${bot.id}...`);
    await bot.client.connect();
    console.log(`🔍 ViewBotRotationService: ${bot.id} connected, starting stream...`);

    // Start streaming
    await bot.client.startStreaming();
  }
  
  /**
   * Stop current bot
   */
  async stopCurrentBot() {
    if (!this.currentBot) return;

    const bot = this.currentBot;
    console.log(`⏹️ ViewBotRotationService: Stopping ${bot.id} (backend: ${this.backend})...`);

    // Emit stream-ended event BEFORE stopping the bot
    if (global.io) {
      console.log(`📢 ViewBotRotationService: Emitting stream-ended for ${bot.id}`);
      global.io.emit('stream-ended', {
        reason: 'rotation',
        previousStreamer: bot.id,
        timestamp: Date.now()
      });
    }

    // Stop LiveKit bot
    if (this.backend === 'livekit' && this.livekitViewBotId && this.livekitViewBotService) {
      try {
        await this.livekitViewBotService.stopViewBot(this.livekitViewBotId);
        this.livekitViewBotId = null;
      } catch (error) {
        console.error(`⚠️ Error stopping LiveKit viewbot ${bot.id}:`, error);
      }
    }

    // Stop MediaSoup socket-based bot
    if (bot.client) {
      try {
        await bot.client.stopStreaming();
      } catch (error) {
        console.error(`⚠️ Error stopping ${bot.id}:`, error.message);
      }

      // Always cleanup resources
      bot.client.cleanup();
      bot.client = null;
    }

    this.currentBot = null;
    console.log(`✅ ViewBotRotationService: ${bot.id} stopped and cleaned up`);
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
      console.log(`🎲💎 ULTRA RARE: Extremely long interval rolled (0.5% chance)!`);
    } else if (roll < 2.5) {
      // 2% chance: > 10 minutes (10-20 minutes)
      interval = 600000 + Math.random() * 600000; // 10-20 minutes
      console.log(`🎲 RARE: Super long interval rolled (2% chance)`);
    } else if (roll < 7.5) {
      // 5% chance total: > 6 minutes (6-10 minutes)
      interval = 360000 + Math.random() * 240000; // 6-10 minutes
      console.log(`🎲 UNCOMMON: Long interval rolled (5% chance)`);
    } else if (roll < 11.5) {
      // 4% chance: < 1 minute (15-60 seconds)
      interval = 15000 + Math.random() * 45000; // 15-60 seconds
      console.log(`🎲 UNCOMMON: Short interval rolled (4% chance)`);
    } else if (roll < 12) {
      // 0.5% chance: ULTRA RARE - Very short interval (5-15 seconds)
      interval = 5000 + Math.random() * 10000; // 5-15 seconds
      console.log(`🎲💎 ULTRA RARE: Lightning fast rotation rolled (0.5% chance)!`);
    } else {
      // 88% chance: Normal range (1-6 minutes by default)
      interval = Math.floor(Math.random() * (maxRotationInterval - minRotationInterval)) + minRotationInterval;
      console.log(`🎲 NORMAL: Standard interval rolled (88% chance)`);
    }
    
    console.log(`⏱️ Next rotation in ${Math.round(interval / 1000)} seconds (${(interval / 60000).toFixed(1)} minutes)`);
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
      console.log('🛡️ ViewBotRotationService: Not scheduling - Random stream rotation is active');
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
    console.log('🔄 ViewBotRotationService: forceRotation() called at', new Date().toISOString());
    console.log('🔄 ViewBotRotationService: Forcing rotation...');
    
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
    console.log('⚙️ Updated settings:', this.settings);
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    console.log('🧹 ViewBotRotationService: Cleaning up...');
    await this.stopRotation();
  }
}

module.exports = ViewBotRotationService;