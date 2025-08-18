const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const io = require('socket.io-client');
const puppeteer = require('puppeteer');
const ViewBotDatabaseService = require('./ViewBotDatabaseService');
const ViewBotGStreamerService = require('./ViewBotGStreamerService');

/**
 * ViewBotClientService - Creates actual bot clients that connect and stream like real users
 * This differs from ViewbotService by actually creating client connections that go through
 * the full WebRTC flow, making it appear as real streaming users to the system.
 */
class ViewBotClientService {
  constructor(serverUrl, mediasoupService, streamService, viewbotService = null) {
    this.serverUrl = serverUrl || 'http://localhost:8080';
    this.mediasoupService = mediasoupService;
    this.streamService = streamService;
    this.viewbotService = viewbotService;
    
    // Database service for persistence
    this.dbService = new ViewBotDatabaseService();
    this.dbInitialized = false;
    
    // GStreamer service for improved video streaming
    this.gstreamerService = new ViewBotGStreamerService();
    
    // ViewBot state management
    this.activeBots = new Map(); // Map<botId, botInstance>
    // Remove ViewBot limits - allow unlimited ViewBots
    this.maxBots = Infinity;
    this.botIdCounter = 0;
    
    // ViewBot rotation system (will be loaded from database)
    this.rotationEnabled = false; // Toggle for ViewBot stream switching
    this.currentLiveBot = null; // Currently streaming ViewBot
    this.rotationTimer = null; // Timer for automatic rotation
    this.realStreamerActive = false; // Protection flag for real streamers
    this.validationTimer = null; // Timer for real streamer status validation
    
    // Content sources
    this.contentSources = {
      testPattern: 'test-pattern',
      videoFile: 'video-file',
      webCam: 'webcam',
      screenCapture: 'screen-capture'
    };
    
    // Default configuration
    this.defaultConfig = {
      contentType: 'testPattern',
      videoFile: null,
      width: 1280,
      height: 720,
      frameRate: 30,
      videoBitrate: '1000k',
      audioBitrate: '128k',
      autoStart: false,
      streamDuration: 0 // 0 = infinite
    };
    
    // Global streaming method setting (applies to all bots)
    this.globalStreamingMethod = 'gstreamer'; // 'ffmpeg' or 'gstreamer' - GStreamer is now default
    
    // FFmpeg path detection
    this.ffmpegPath = null;
    
    // Initialize database and restore state
    this.initialize();
    
    console.log('🤖 VIEWBOT CLIENT: Service initialized');
  }

  /**
   * Initialize the service and restore state from database
   */
  async initialize() {
    try {
      // Detect FFmpeg path first
      await this.detectFFmpegPath();
      
      // Initialize database service
      await this.dbService.initialize();
      this.dbInitialized = true;
      
      // Restore system state from database
      await this.restoreSystemState();
      
      // Restore ViewBot configurations
      await this.restoreViewBots();
      
      // Start auto-validation for real streamer status
      this.startAutoValidation();
      
      console.log('✅ VIEWBOT CLIENT: Service fully initialized with database persistence');
    } catch (error) {
      console.error('❌ VIEWBOT CLIENT: Failed to initialize with database:', error);
      console.log('⚠️ VIEWBOT CLIENT: Continuing without persistence (memory-only mode)');
    }
  }

  /**
   * Detect the correct FFmpeg path for this system
   */
  async detectFFmpegPath() {
    const ffmpegCheck = await ViewBotClientService.checkFFmpegAvailability();
    if (ffmpegCheck.available) {
      this.ffmpegPath = ffmpegCheck.path;
      console.log(`✅ VIEWBOT CLIENT: Detected FFmpeg at ${this.ffmpegPath}`);
    } else {
      console.error(`❌ VIEWBOT CLIENT: FFmpeg not found - ViewBot streaming will not work`);
      console.error(`📋 VIEWBOT CLIENT: Please install FFmpeg and add it to PATH`);
    }
  }

  /**
   * Restore system state from database
   */
  async restoreSystemState() {
    if (!this.dbInitialized) return;
    
    try {
      const state = await this.dbService.loadSystemState();
      
      this.rotationEnabled = state.rotationEnabled;
      this.currentLiveBot = state.currentLiveBot;
      this.realStreamerActive = state.realStreamerActive;
      this.maxBots = state.maxBots === -1 ? Infinity : state.maxBots;
      
      console.log(`🔄 VIEWBOT CLIENT: Restored system state - rotation: ${this.rotationEnabled}, live bot: ${this.currentLiveBot}`);
      
      // CRITICAL FIX: If rotation was enabled, restart it after restoration
      // This ensures rotation continues after server restart
      if (this.rotationEnabled && !this.realStreamerActive) {
        console.log(`🔄 VIEWBOT CLIENT: Restarting rotation system after restoration`);
        // Schedule rotation restart after bots are restored
        setTimeout(() => this.restartRotationAfterRestore(), 5000);
      }
    } catch (error) {
      console.error('❌ VIEWBOT CLIENT: Failed to restore system state:', error);
    }
  }

  /**
   * Restore ViewBot configurations from database
   */
  async restoreViewBots() {
    if (!this.dbInitialized) return;
    
    try {
      const storedBots = await this.dbService.loadAllViewBots();
      
      for (const botData of storedBots) {
        console.log(`🔄 VIEWBOT CLIENT: Restoring ViewBot ${botData.botId}`);
        
        // Create bot instance with restored configuration
        const bot = new ViewBotInstance(
          botData.botId,
          botData.config,
          this.serverUrl,
          this.mediasoupService,
          this
        );
        
        // Set name from database
        if (botData.name) {
          bot.name = botData.name;
        }
        
        // Set custom time allotment if specified
        if (botData.timeAllotment) {
          bot.timeAllotment = botData.timeAllotment;
          bot.timeRemaining = botData.timeAllotment;
        }
        
        // Initialize the bot
        try {
          await bot.initialize();
          this.activeBots.set(botData.botId, bot);
          console.log(`✅ VIEWBOT CLIENT: Restored ViewBot ${botData.botId}`);
          
          // Auto-start if configured
          if (botData.autoStart && !this.realStreamerActive) {
            console.log(`🚀 VIEWBOT CLIENT: Auto-starting ViewBot ${botData.botId}`);
            setTimeout(() => this.startBotStreaming(botData.botId), 1000);
          }
        } catch (error) {
          console.error(`❌ VIEWBOT CLIENT: Failed to restore ViewBot ${botData.botId}:`, error);
        }
      }
      
      console.log(`✅ VIEWBOT CLIENT: Restored ${this.activeBots.size} ViewBots from database`);
    } catch (error) {
      console.error('❌ VIEWBOT CLIENT: Failed to restore ViewBots:', error);
    }
  }

  /**
   * Save current system state to database
   */
  async saveSystemState() {
    if (!this.dbInitialized) return;
    
    try {
      await this.dbService.saveSystemState({
        rotationEnabled: this.rotationEnabled,
        currentLiveBot: this.currentLiveBot,
        realStreamerActive: this.realStreamerActive,
        maxBots: this.maxBots === Infinity ? -1 : this.maxBots
      });
    } catch (error) {
      console.error('❌ VIEWBOT CLIENT: Failed to save system state:', error);
    }
  }

  /**
   * Gets the FFmpeg executable path
   */
  static getFFmpegPath() {
    // Common Windows FFmpeg installation paths
    const possiblePaths = [
      'C:\\Users\\18084\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe', // WinGet installation
      'ffmpeg', // In PATH
      'C:\\ffmpeg\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe'
    ];
    
    return possiblePaths;
  }

  /**
   * Checks if FFmpeg is available on the system
   */
  static async checkFFmpegAvailability() {
    const ffmpegPaths = ViewBotClientService.getFFmpegPath();
    
    for (const ffmpegPath of ffmpegPaths) {
      try {
        const result = await new Promise((resolve) => {
          const ffmpeg = spawn(ffmpegPath, ['-version']);
          
          ffmpeg.on('error', (error) => {
            resolve({ available: false, error: error.message, path: ffmpegPath });
          });
          
          ffmpeg.on('close', (code) => {
            resolve({
              available: code === 0,
              error: code !== 0 ? `FFmpeg exited with code ${code}` : null,
              path: ffmpegPath
            });
          });
          
          // Timeout after 3 seconds
          setTimeout(() => {
            ffmpeg.kill();
            resolve({ available: false, error: 'FFmpeg check timeout', path: ffmpegPath });
          }, 3000);
        });
        
        if (result.available) {
          console.log(`✅ VIEWBOT CLIENT: Found FFmpeg at ${ffmpegPath}`);
          return { available: true, path: ffmpegPath };
        }
        
      } catch (error) {
        // Continue to next path
      }
    }
    
    return {
      available: false,
      error: 'FFmpeg not found in PATH or common installation directories',
      instructions: [
        'FFmpeg appears to be installed but not accessible.',
        'Add FFmpeg to your system PATH, or',
        'Reinstall FFmpeg using: winget install ffmpeg'
      ]
    };
  }

  /**
   * Creates a new ViewBot that acts as a real streaming client
   */
  async createBot(config = {}) {
    // ViewBot limits removed - allow unlimited creation

    // Check if FFmpeg is available before creating ViewBot
    const ffmpegCheck = await ViewBotClientService.checkFFmpegAvailability();
    if (!ffmpegCheck.available) {
      console.error(`❌ VIEWBOT CLIENT: FFmpeg not available: ${ffmpegCheck.error}`);
      if (ffmpegCheck.instructions) {
        console.error(`📋 VIEWBOT CLIENT: Installation instructions:`);
        ffmpegCheck.instructions.forEach(instruction => {
          console.error(`   ${instruction}`);
        });
      }
      return { 
        success: false, 
        message: `FFmpeg required for ViewBot streaming. ${ffmpegCheck.error}. Please install FFmpeg and restart the server.`
      };
    }

    const botId = `viewbot-${Date.now()}-${this.botIdCounter++}`;
    const botConfig = { ...this.defaultConfig, ...config };
    
    // Apply global streaming method setting
    // Default to GStreamer for video files unless explicitly set to false
    if (botConfig.contentType === 'videoFile') {
      // Only use FFmpeg if explicitly requested, otherwise use GStreamer
      if (botConfig.useGStreamer !== false) {
        botConfig.useGStreamer = true; // Default to GStreamer
        console.log(`🎬 VIEWBOT CLIENT: Using GSTREAMER for video file streaming (default)`);
      } else {
        console.log(`🎬 VIEWBOT CLIENT: Using FFMPEG for video file streaming (explicitly requested)`);
      }
    }
    
    // Convert streamDuration (minutes) to timeAllotment (milliseconds) if provided
    if (config.streamDuration && config.streamDuration > 0) {
      botConfig.timeAllotment = config.streamDuration * 60 * 1000; // Convert minutes to milliseconds
      console.log(`⏱️ VIEWBOT CLIENT: Setting time allotment to ${config.streamDuration} minutes`);
    }

    try {
      console.log(`🤖 VIEWBOT CLIENT: Creating bot ${botId} with config:`, botConfig);
      
      const bot = new ViewBotInstance(botId, botConfig, this.serverUrl, this.mediasoupService, this);
      await bot.initialize();
      
      this.activeBots.set(botId, bot);
      
      // Save to database for persistence
      if (this.dbInitialized) {
        try {
          await this.dbService.saveViewBot({
            botId,
            name: `ViewBot ${botId.split('-').pop()}`,
            config: botConfig,
            contentType: botConfig.contentType || 'testPattern',
            isEnabled: true,
            autoStart: botConfig.autoStart || false,
            timeAllotment: botConfig.timeAllotment || null
          });
          console.log(`💾 VIEWBOT CLIENT: Saved ViewBot ${botId} to database`);
        } catch (dbError) {
          console.error(`⚠️ VIEWBOT CLIENT: Failed to save ViewBot ${botId} to database:`, dbError);
          // Continue without database - bot is still created in memory
        }
      }
      
      console.log(`✅ VIEWBOT CLIENT: Bot ${botId} created successfully`);
      
      return {
        success: true,
        message: `ViewBot ${botId} created`,
        botId,
        config: botConfig,
        status: bot.getStatus()
      };
    } catch (error) {
      console.error(`❌ VIEWBOT CLIENT: Failed to create bot ${botId}:`, error);
      return {
        success: false,
        message: `Failed to create bot: ${error.message}`
      };
    }
  }

  /**
   * Starts streaming for a specific bot (integrates with rotation system)
   */
  async startBotStreaming(botId) {
    console.log(`🎯 Starting ViewBot streaming for: ${botId.substring(0, 12)}...`);
    
    const bot = this.activeBots.get(botId);
    if (!bot) {
      console.log(`❌ ViewBot ${botId} not found in activeBots map`);
      console.log(`📊 Available bots: ${Array.from(this.activeBots.keys()).map(id => id.substring(0, 12)).join(', ')}`);
      return { success: false, message: `Bot ${botId} not found` };
    }

    // Validate real streamer status first
    console.log(`🔍 Validating real streamer status before starting ViewBot...`);
    this.validateRealStreamerStatus();
    
    // Check if real streamer protection is active
    if (this.realStreamerActive) {
      console.log(`🚫 ViewBot ${botId}: Blocked by real streamer protection`);
      return { success: false, message: 'Cannot start ViewBot - real streamer is active' };
    }
    
    console.log(`✅ ViewBot ${botId}: Real streamer check passed, proceeding with start`);

    try {
      // If rotation is enabled, stop current live bot first
      if (this.rotationEnabled && this.currentLiveBot && this.currentLiveBot !== botId) {
        const currentBot = this.activeBots.get(this.currentLiveBot);
        if (currentBot && currentBot.streaming) {
          console.log(`🔄 Stopping current live bot ${this.currentLiveBot} for manual start of ${botId}`);
          await currentBot.stopStreaming();
        }
      }

      const result = await bot.startStreaming();
      
      if (result.success) {
        // Update rotation system tracking
        if (this.rotationEnabled) {
          this.currentLiveBot = botId;
          // Only reset time allotment if no custom value was provided
          if (!bot.config.timeAllotment) {
            bot.resetTimeAllotment();
            console.log(`🔄 Manual start: Updated current live bot to ${botId} with fresh random time allotment`);
          } else {
            // Preserve custom time allotment but reset remaining time to full
            bot.timeRemaining = bot.timeAllotment;
            console.log(`🎯 Manual start: Updated current live bot to ${botId} with custom time allotment: ${bot.formatDuration(bot.timeAllotment)}`);
          }
        } else {
          console.log(`⏸️ Manual start: ViewBot ${botId} started with rotation disabled - will stream indefinitely`);
        }
        
        console.log(`🎬 VIEWBOT CLIENT: Bot ${botId} streaming started manually`);
      }
      
      return result;
    } catch (error) {
      console.error(`❌ VIEWBOT CLIENT: Failed to start streaming for bot ${botId}:`, error);
      return {
        success: false,
        message: `Failed to start streaming: ${error.message}`
      };
    }
  }

  /**
   * Stops streaming for a specific bot (integrates with rotation system)
   */
  async stopBotStreaming(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: `Bot ${botId} not found` };
    }

    try {
      const result = await bot.stopStreaming();
      
      if (result.success) {
        // Update rotation system tracking
        if (this.rotationEnabled && this.currentLiveBot === botId) {
          console.log(`🔄 Manual stop: Clearing current live bot ${botId}`);
          this.currentLiveBot = null;
          
          // If rotation is enabled, try to start another ViewBot automatically
          const availableBots = Array.from(this.activeBots.values()).filter(b => 
            b.botId !== botId && b.isConnected && !b.streaming
          );
          
          if (availableBots.length > 0) {
            const nextBot = availableBots[Math.floor(Math.random() * availableBots.length)];
            console.log(`🔄 Auto-starting next ViewBot: ${nextBot.botId}`);
            
            // Start the next bot with a short delay
            setTimeout(async () => {
              try {
                await nextBot.startStreaming();
                // Only reset time allotment if no custom value was provided
                if (!nextBot.config.timeAllotment) {
                  nextBot.resetTimeAllotment();
                  console.log(`✅ Auto-rotation completed: ${botId} → ${nextBot.botId} (random time allotment)`);
                } else {
                  // Preserve custom time allotment but reset remaining time to full
                  nextBot.timeRemaining = nextBot.timeAllotment;
                  console.log(`✅ Auto-rotation completed: ${botId} → ${nextBot.botId} (custom time allotment: ${nextBot.formatDuration(nextBot.timeAllotment)})`);
                }
                this.currentLiveBot = nextBot.botId;
              } catch (error) {
                console.error(`❌ Auto-rotation failed:`, error);
              }
            }, 1000);
          }
        }
        
        // Clear streamer if this bot was the active one
        const currentStreamer = this.streamService.getCurrentStreamer();
        if (currentStreamer === botId) {
          this.streamService.clearStreamer();
          console.log(`🎬 VIEWBOT CLIENT: Bot ${botId} stepped down as active streamer`);
        }
      }
      
      return result;
    } catch (error) {
      console.error(`❌ VIEWBOT CLIENT: Failed to stop streaming for bot ${botId}:`, error);
      return {
        success: false,
        message: `Failed to stop streaming: ${error.message}`
      };
    }
  }

  /**
   * Destroys a bot and cleans up resources
   */
  async destroyBot(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: `Bot ${botId} not found` };
    }

    try {
      await bot.destroy();
      this.activeBots.delete(botId);
      
      // Remove from database
      if (this.dbInitialized) {
        try {
          await this.dbService.deleteViewBot(botId);
          console.log(`💾 VIEWBOT CLIENT: Removed ViewBot ${botId} from database`);
        } catch (dbError) {
          console.error(`⚠️ VIEWBOT CLIENT: Failed to remove ViewBot ${botId} from database:`, dbError);
        }
      }
      
      // Clear streamer if this bot was the active one
      const currentStreamer = this.streamService.getCurrentStreamer();
      if (currentStreamer === botId) {
        this.streamService.clearStreamer();
      }
      
      console.log(`🗑️ VIEWBOT CLIENT: Bot ${botId} destroyed`);
      
      return {
        success: true,
        message: `Bot ${botId} destroyed`
      };
    } catch (error) {
      console.error(`❌ VIEWBOT CLIENT: Failed to destroy bot ${botId}:`, error);
      return {
        success: false,
        message: `Failed to destroy bot: ${error.message}`
      };
    }
  }

  /**
   * Gets status of all active bots
   */
  async getAllBotsStatus() {
    const botsStatus = [];
    
    for (const [botId, bot] of this.activeBots.entries()) {
      let botName = bot.name;
      
      // Try to get name from database if not set in memory
      if (!botName && this.dbInitialized) {
        try {
          const dbBot = await this.dbService.loadViewBot(botId);
          if (dbBot && dbBot.name) {
            botName = dbBot.name;
            bot.name = dbBot.name; // Update in memory for future use
          }
        } catch (error) {
          // Ignore database errors, use default name
        }
      }
      
      botsStatus.push({
        botId,
        name: botName || `ViewBot ${botId.split('-').pop()}`,
        ...bot.getStatus()
      });
    }
    
    return {
      totalBots: this.activeBots.size,
      maxBots: '∞', // Unlimited ViewBots
      bots: botsStatus
    };
  }

  /**
   * Gets status of a specific bot
   */
  getBotStatus(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: `Bot ${botId} not found` };
    }

    return {
      success: true,
      botId,
      ...bot.getStatus()
    };
  }

  /**
   * Updates configuration for a specific bot
   */
  async updateBotConfig(botId, config) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: `Bot ${botId} not found` };
    }

    try {
      const result = await bot.updateConfig(config);
      return result;
    } catch (error) {
      console.error(`❌ VIEWBOT CLIENT: Failed to update config for bot ${botId}:`, error);
      return {
        success: false,
        message: `Failed to update config: ${error.message}`
      };
    }
  }

  /**
   * Updates name for a specific bot
   */
  async updateBotName(botId, name) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: `Bot ${botId} not found` };
    }

    try {
      // Update the bot's name in memory
      bot.name = name;
      
      // Update in database if available
      if (this.dbInitialized) {
        try {
          const dbResult = await this.dbService.updateViewBotName(botId, name);
          if (!dbResult.success) {
            // If bot doesn't exist in DB yet, save it
            await this.dbService.saveViewBot({
              botId,
              name,
              config: bot.config,
              contentType: bot.config.contentType || 'testPattern',
              isEnabled: true,
              autoStart: false
            });
            console.log(`💾 VIEWBOT CLIENT: Saved ViewBot ${botId} to database with name "${name}"`);
          } else {
            console.log(`💾 VIEWBOT CLIENT: Updated name for ViewBot ${botId} in database`);
          }
        } catch (dbError) {
          console.error(`⚠️ VIEWBOT CLIENT: Failed to update ViewBot name in database:`, dbError);
        }
      }

      return {
        success: true,
        message: `Bot ${botId} renamed to "${name}"`,
        name
      };
    } catch (error) {
      console.error(`❌ VIEWBOT CLIENT: Failed to update name for bot ${botId}:`, error);
      return {
        success: false,
        message: `Failed to update name: ${error.message}`
      };
    }
  }

  /**
   * Creates a "streamer bot" that immediately starts streaming (convenience method)
   */
  async createStreamerBot(config = {}) {
    const createResult = await this.createBot({ ...config, autoStart: true });
    
    if (!createResult.success) {
      return createResult;
    }

    if (config.autoStart !== false) {
      const startResult = await this.startBotStreaming(createResult.botId);
      
      if (!startResult.success) {
        // Clean up the bot if streaming failed
        await this.destroyBot(createResult.botId);
        return startResult;
      }
    }
    
    return createResult;
  }

  /**
   * Destroys all active bots
   */
  async destroyAllBots() {
    const results = [];
    
    // Stop rotation first
    this.stopViewBotRotation();
    
    for (const botId of this.activeBots.keys()) {
      const result = await this.destroyBot(botId);
      results.push({ botId, ...result });
    }
    
    return {
      success: true,
      message: `Destroyed ${results.length} bots`,
      results
    };
  }

  /**
   * Complete cleanup for server shutdown
   */
  async cleanup() {
    console.log('🧹 ViewBotClientService: Starting complete cleanup...');
    
    try {
      // Stop rotation timer
      this.stopViewBotRotation();
      
      // Stop auto-validation
      this.stopAutoValidation();
      
      // Stop all GStreamer processes
      if (this.gstreamerService) {
        console.log('   Stopping GStreamer service...');
        await this.gstreamerService.stopAll();
      }
      
      // Destroy all bots
      console.log('   Destroying all ViewBot clients...');
      await this.destroyAllBots();
      
      console.log('✅ ViewBotClientService: Cleanup complete');
    } catch (error) {
      console.error('❌ ViewBotClientService: Error during cleanup:', error);
    }
  }

  /**
   * Health check for the service
   */
  getHealthStatus() {
    const activeBots = Array.from(this.activeBots.values());
    const streamingBots = activeBots.filter(bot => bot.isStreaming());
    const healthyBots = activeBots.filter(bot => bot.isHealthy());
    
    // Get next rotation info
    let nextRotationTime = null;
    let timeToNextRotation = null;
    let timeToNextRotationFormatted = null;
    
    if (this.rotationEnabled && this.currentLiveBot) {
      const currentBot = this.activeBots.get(this.currentLiveBot);
      if (currentBot && currentBot.isStreaming() && currentBot.timeRemaining > 0) {
        nextRotationTime = Date.now() + currentBot.timeRemaining;
        timeToNextRotation = currentBot.timeRemaining;
        timeToNextRotationFormatted = currentBot.formatDuration(Math.max(0, timeToNextRotation));
      }
    }
    
    return {
      service: 'ViewBotClientService',
      status: 'running',
      totalBots: this.activeBots.size,
      streamingBots: streamingBots.length,
      healthyBots: healthyBots.length,
      maxCapacity: '∞', // Unlimited capacity
      utilizationPercent: 0, // Always 0% since capacity is unlimited
      serverUrl: this.serverUrl,
      lastCheck: new Date().toISOString(),
      // ViewBot rotation system status
      rotationEnabled: this.rotationEnabled,
      currentLiveBot: this.currentLiveBot,
      realStreamerActive: this.realStreamerActive,
      nextRotationTime: nextRotationTime,
      timeToNextRotation: timeToNextRotation,
      timeToNextRotationFormatted: timeToNextRotationFormatted
    };
  }

  /**
   * Toggles ViewBot rotation system on/off
   */
  async toggleRotation(enabled) {
    this.rotationEnabled = enabled;
    console.log(`🔄 ViewBot rotation system ${enabled ? 'ENABLED' : 'DISABLED'}`);
    
    if (!enabled) {
      // Stop rotation system
      if (this.rotationTimer) {
        clearTimeout(this.rotationTimer);
        this.rotationTimer = null;
      }
      this.stopViewBotRotation();
      
      // CRITICAL FIX: Stop all allotment timers when rotation is disabled
      // This allows viewbots to stream indefinitely
      for (const [botId, bot] of this.activeBots.entries()) {
        if (bot.streaming) {
          bot.pauseAllotmentTimer();
          console.log(`⏸️ Paused allotment timer for ViewBot ${botId} - rotation disabled`);
        }
      }
    } else {
      // Start rotation system
      await this.startViewBotRotation();
      
      // CRITICAL FIX: Resume allotment timers when rotation is enabled
      for (const [botId, bot] of this.activeBots.entries()) {
        if (bot.streaming) {
          bot.resumeAllotmentTimer();
          console.log(`▶️ Resumed allotment timer for ViewBot ${botId} - rotation enabled`);
        }
      }
    }
    
    // Save state to database
    await this.saveSystemState();
    
    return { success: true, rotationEnabled: this.rotationEnabled };
  }

  /**
   * Restarts rotation after system restore
   * CRITICAL FIX: Ensures rotation continues after server restart
   */
  async restartRotationAfterRestore() {
    console.log(`🔄 VIEWBOT CLIENT: Checking rotation restart conditions`);
    
    // Check if there's a current live bot that needs to continue
    if (this.currentLiveBot) {
      const currentBot = this.activeBots.get(this.currentLiveBot);
      if (currentBot && currentBot.isConnected && !currentBot.streaming) {
        console.log(`🔄 VIEWBOT CLIENT: Restarting rotation with previous bot: ${this.currentLiveBot}`);
        try {
          await currentBot.startStreaming();
          console.log(`✅ VIEWBOT CLIENT: Rotation resumed with ${this.currentLiveBot}`);
        } catch (error) {
          console.error(`❌ VIEWBOT CLIENT: Failed to restart ${this.currentLiveBot}, starting fresh rotation`);
          this.currentLiveBot = null;
          await this.startViewBotRotation();
        }
      } else {
        console.log(`🔄 VIEWBOT CLIENT: Previous bot ${this.currentLiveBot} not available, starting fresh rotation`);
        this.currentLiveBot = null;
        await this.startViewBotRotation();
      }
    } else {
      console.log(`🔄 VIEWBOT CLIENT: No previous bot, starting fresh rotation`);
      await this.startViewBotRotation();
    }
  }

  /**
   * Starts the ViewBot rotation system by selecting and starting the first ViewBot
   */
  async startViewBotRotation() {
    if (this.realStreamerActive) {
      console.log(`🛑 Cannot start ViewBot rotation - real streamer is active`);
      return;
    }

    // Find available ViewBots
    const availableBots = Array.from(this.activeBots.values()).filter(bot => 
      bot.isConnected && !bot.streaming
    );

    if (availableBots.length === 0) {
      console.log(`⚠️ No available ViewBots for rotation`);
      return;
    }

    // Reset time allotments for all ViewBots (preserve custom allotments)
    availableBots.forEach(bot => {
      if (!bot.config.timeAllotment) {
        // Only reset to random if no custom time allotment was provided
        bot.resetTimeAllotment();
      } else {
        // Preserve custom time allotment but reset remaining time to full
        bot.timeRemaining = bot.timeAllotment;
        console.log(`🎯 ViewBot ${bot.botId}: Preserved custom time allotment for rotation start: ${bot.formatDuration(bot.timeAllotment)}`);
      }
    });

    // Select the first ViewBot to start
    const firstBot = availableBots[0];
    
    try {
      await firstBot.startStreaming();
      this.currentLiveBot = firstBot.botId;
      console.log(`🔄 ViewBot rotation started with: ${firstBot.botId}`);
    } catch (error) {
      console.error(`❌ Failed to start initial ViewBot rotation:`, error);
    }
  }

  /**
   * Sets the real streamer status (protects from ViewBot takeover)
   */
  setRealStreamerStatus(isActive) {
    this.realStreamerActive = isActive;
    console.log(`👤 Real streamer status: ${isActive ? 'ACTIVE' : 'INACTIVE'}`);
    
    if (isActive && this.currentLiveBot) {
      // Stop current ViewBot if a real streamer becomes active
      console.log(`🛑 Real streamer active - stopping ViewBot ${this.currentLiveBot}`);
      this.stopViewBotRotation();
    }
    
    return { success: true, realStreamerActive: this.realStreamerActive };
  }

  /**
   * Validates and auto-corrects real streamer status based on actual stream state
   * This ensures the flag is always accurate and prevents orphaned states
   */
  validateRealStreamerStatus() {
    if (!this.realStreamerActive) {
      return; // If already inactive, no validation needed
    }

    // Get current streamer from the main services
    const currentStreamer = this.streamService ? this.streamService.getCurrentStreamer() : 
                           this.mediasoupService ? this.mediasoupService.getCurrentStreamer() : null;
    
    if (!currentStreamer) {
      // No active streamer at all - clear the real streamer flag
      console.log(`🔍 VALIDATION: No active streamer found, clearing real streamer flag`);
      this.realStreamerActive = false;
      return;
    }

    // Check if current streamer is a ViewBot
    const isViewbot = this.viewbotService ? this.viewbotService.isViewbotStream(currentStreamer) : 
                     currentStreamer.includes('viewbot-') || currentStreamer.includes('bot-');
    
    if (isViewbot && this.realStreamerActive) {
      // Current streamer is a ViewBot but real streamer flag is active - this is inconsistent
      console.log(`🔍 VALIDATION: Current streamer ${currentStreamer} is ViewBot, clearing real streamer flag`);
      this.realStreamerActive = false;
      return;
    }

    // If we get here and realStreamerActive is true, there should be a real user streaming
    console.log(`🔍 VALIDATION: Real streamer flag validated - current streamer: ${currentStreamer.substring(0, 12)}...`);
  }

  /**
   * Auto-validation that runs periodically to ensure real streamer status accuracy
   */
  startAutoValidation() {
    // Run validation every 30 seconds
    if (this.validationTimer) {
      clearInterval(this.validationTimer);
    }
    
    this.validationTimer = setInterval(() => {
      this.validateRealStreamerStatus();
    }, 30000); // 30 seconds
    
    console.log(`🔍 VALIDATION: Auto-validation started (30s intervals)`);
  }

  /**
   * Stop auto-validation timer
   */
  stopAutoValidation() {
    if (this.validationTimer) {
      clearInterval(this.validationTimer);
      this.validationTimer = null;
      console.log(`🔍 VALIDATION: Auto-validation stopped`);
    }
  }

  /**
   * Handles ViewBot rotation requests
   */
  async handleRotationRequest(botId, reason) {
    if (!this.rotationEnabled) {
      console.log(`🔄 Rotation request from ${botId} ignored - rotation disabled`);
      return { success: false, message: 'Rotation is disabled' };
    }

    if (this.realStreamerActive) {
      console.log(`🔄 Rotation request from ${botId} ignored - real streamer active`);
      return { success: false, message: 'Real streamer is active' };
    }

    console.log(`🔄 Processing rotation request from ${botId} (reason: ${reason})`);
    
    // Find the next available ViewBot to rotate to
    const availableBots = Array.from(this.activeBots.values()).filter(bot => 
      bot.botId !== botId && bot.isConnected && !bot.streaming
    );

    if (availableBots.length === 0) {
      console.log(`🔄 No available ViewBots for rotation - stopping rotation`);
      this.currentLiveBot = null;
      return { success: false, message: 'No available ViewBots for rotation' };
    }

    // Select a random ViewBot from available ones
    const nextBot = availableBots[Math.floor(Math.random() * availableBots.length)];
    
    try {
      // Stop current bot
      const currentBot = this.activeBots.get(botId);
      if (currentBot) {
        await currentBot.stopStreaming();
      }

      // Reset time allotments for ALL ViewBots except the next one (preserve custom allotments)
      Array.from(this.activeBots.values()).forEach(bot => {
        if (bot.botId !== nextBot.botId) {
          if (!bot.config.timeAllotment) {
            // Only reset to random if no custom time allotment was provided
            bot.resetTimeAllotment();
          } else {
            // Preserve custom time allotment but reset remaining time to full
            bot.timeRemaining = bot.timeAllotment;
            console.log(`🎯 ViewBot ${bot.botId}: Preserved custom time allotment during rotation: ${bot.formatDuration(bot.timeAllotment)}`);
          }
        }
      });

      // Start next bot with its current time allotment
      await nextBot.startStreaming();
      
      this.currentLiveBot = nextBot.botId;
      
      console.log(`🔄 ViewBot rotation completed: ${botId} → ${nextBot.botId}`);
      console.log(`🎲 Reset time allotments for ${availableBots.length} ViewBots (except ${nextBot.botId})`);
      
      // Record rotation in database
      if (this.dbInitialized) {
        try {
          await this.dbService.recordRotation({
            fromBotId: botId,
            toBotId: nextBot.botId,
            reason: reason,
            rotationType: 'automatic',
            durationBeforeRotation: currentBot ? (Date.now() - currentBot.sessionStartTime) : null,
            metadata: {
              availableBotsCount: availableBots.length,
              rotationEnabled: this.rotationEnabled
            }
          });
        } catch (dbError) {
          console.error('⚠️ VIEWBOT CLIENT: Failed to record rotation in database:', dbError);
        }
      }
      
      return { 
        success: true, 
        previousBot: botId,
        newBot: nextBot.botId,
        reason: reason
      };
    } catch (error) {
      console.error(`❌ ViewBot rotation failed:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Stops ViewBot rotation system
   */
  stopViewBotRotation() {
    if (this.currentLiveBot) {
      const currentBot = this.activeBots.get(this.currentLiveBot);
      if (currentBot) {
        currentBot.stopStreaming();
      }
      this.currentLiveBot = null;
    }

    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  /**
   * Gets rotation system status
   */
  getRotationStatus() {
    let timeToNextRotation = null;
    let timeToNextRotationFormatted = null;
    
    // Calculate time to next rotation if rotation is enabled and a bot is streaming
    if (this.rotationEnabled && this.currentLiveBot) {
      const currentBot = this.activeBots.get(this.currentLiveBot);
      console.log(`[ROTATION STATUS DEBUG] Current bot: ${this.currentLiveBot}, Bot exists: ${!!currentBot}, Streaming: ${currentBot?.streaming}, TimeRemaining: ${currentBot?.timeRemaining}`);
      if (currentBot && currentBot.streaming && currentBot.timeRemaining !== undefined && currentBot.timeRemaining !== null) {
        timeToNextRotation = currentBot.timeRemaining;
        
        // Format the time
        const seconds = Math.floor(timeToNextRotation / 1000);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        timeToNextRotationFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        console.log(`[ROTATION STATUS DEBUG] Time to next rotation: ${timeToNextRotation}ms, Formatted: ${timeToNextRotationFormatted}`);
      } else {
        console.log(`[ROTATION STATUS DEBUG] No time calculation - conditions not met`);
      }
    } else {
      console.log(`[ROTATION STATUS DEBUG] Rotation not enabled (${this.rotationEnabled}) or no current bot (${this.currentLiveBot})`);
    }
    
    return {
      rotationEnabled: this.rotationEnabled,
      currentLiveBot: this.currentLiveBot,
      realStreamerActive: this.realStreamerActive,
      availableBots: Array.from(this.activeBots.values()).filter(bot => 
        bot.isConnected && !bot.streaming
      ).length,
      totalBots: this.activeBots.size,
      timeToNextRotation: timeToNextRotation,
      timeToNextRotationFormatted: timeToNextRotationFormatted
    };
  }

  /**
   * Gets the current global streaming method setting
   */
  getStreamingMethod() {
    return {
      method: this.globalStreamingMethod,
      supported: ['ffmpeg', 'gstreamer']
    };
  }

  /**
   * Sets the global streaming method for all ViewBots
   * @param {string} method - 'ffmpeg' or 'gstreamer'
   */
  async setStreamingMethod(method) {
    if (method !== 'ffmpeg' && method !== 'gstreamer') {
      throw new Error(`Invalid streaming method: ${method}. Must be 'ffmpeg' or 'gstreamer'`);
    }

    // Check GStreamer availability if switching to it
    if (method === 'gstreamer') {
      const gstreamerAvailable = await ViewBotInstance.checkGStreamerAvailability();
      if (!gstreamerAvailable) {
        console.warn('⚠️ GStreamer is not installed. Install GStreamer for this method to work.');
        console.warn('   ViewBots will fall back to FFmpeg when GStreamer fails.');
      }
    }

    const previousMethod = this.globalStreamingMethod;
    this.globalStreamingMethod = method;
    
    // Update config for all existing bots
    for (const [botId, bot] of this.activeBots) {
      bot.config.useGStreamer = (method === 'gstreamer');
    }
    
    console.log(`🎬 Global streaming method changed from ${previousMethod} to ${method}`);
    
    // Save to database if available
    if (this.dbInitialized) {
      try {
        await this.saveSystemState();
      } catch (error) {
        console.error('Failed to save streaming method to database:', error);
      }
    }
    
    return {
      success: true,
      previousMethod,
      newMethod: method,
      message: `Streaming method changed to ${method.toUpperCase()} for all ViewBots`
    };
  }
}

/**
 * Individual ViewBot instance that acts as a streaming client
 */
class ViewBotInstance {
  constructor(botId, config, serverUrl, mediasoupService, parentService = null) {
    this.botId = botId;
    this.config = config;
    this.serverUrl = serverUrl;
    this.mediasoupService = mediasoupService;
    this.parentService = parentService; // CRITICAL FIX: Store reference to parent service
    
    // Connection state
    this.socket = null;
    this.browser = null;
    this.page = null;
    this.mediaStream = null;
    
    // Stream state
    this.isConnected = false;
    this.streaming = false;
    this.startTime = null;
    this.lastError = null;
    
    // ViewBot rotation system
    this.timeAllotment = config.timeAllotment || this.generateRandomTimeAllotment(); // Use manual or random time
    this.timeRemaining = this.timeAllotment;
    this.allotmentTimer = null;
    
    // Database session tracking
    this.currentSessionId = null;
    this.sessionStartTime = null;
    
    if (config.timeAllotment) {
      console.log(`🎯 ViewBot ${this.botId}: Using manual time allotment: ${this.formatDuration(this.timeAllotment)}`);
    }
    
    // WebRTC transport state
    this.transportInfo = null;
    this.rtpCapabilities = null;
    
    // FFmpeg processes and ports
    this.videoFFmpeg = null;
    this.audioFFmpeg = null;
    this.videoRtpPort = null;
    this.audioRtpPort = null;
    this.videoSSRC = null;
    this.audioSSRC = null;
    
    // Legacy properties (kept for backward compatibility)
    this.mediaGenerator = null;
    this.ffmpegProcess = null;
    
    console.log(`🤖 ViewBot ${this.botId} initialized`);
  }

  /**
   * Initializes the bot (connects to server, sets up media)
   */
  async initialize() {
    try {
      console.log(`🔌 ViewBot ${this.botId}: Connecting to server ${this.serverUrl}`);
      
      // Connect to the server via Socket.IO
      this.socket = io(this.serverUrl, {
        transports: ['websocket'],
        timeout: 5000
      });
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 5000);
        
        this.socket.on('connect', () => {
          clearTimeout(timeout);
          this.isConnected = true;
          console.log(`✅ ViewBot ${this.botId}: Connected to server`);
          resolve();
        });
        
        this.socket.on('connect_error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      // Set up socket event handlers
      this.setupSocketHandlers();
      
      // For ViewBots, we don't need Puppeteer setup anymore
      // FFmpeg processes will be created when streaming starts
      console.log(`✅ ViewBot ${this.botId}: Ready for FFmpeg-based streaming`);
      
      console.log(`✅ ViewBot ${this.botId}: Initialization complete`);
      
    } catch (error) {
      this.lastError = error.message;
      console.error(`❌ ViewBot ${this.botId}: Initialization failed:`, error);
      throw error;
    }
  }

  /**
   * Sets up socket event handlers
   */
  setupSocketHandlers() {
    this.socket.on('disconnect', () => {
      console.log(`🔌 ViewBot ${this.botId}: Disconnected from server`);
      this.isConnected = false;
      this.streaming = false;
    });

    this.socket.on('error', (error) => {
      console.error(`❌ ViewBot ${this.botId}: Socket error:`, error);
      this.lastError = error.message || 'Socket error';
    });

    // Handle streaming approval from server
    this.socket.on('streaming-approved', () => {
      console.log(`✅ ViewBot ${this.botId}: Streaming approved by server`);
      // The bot is now the official streamer, trigger viewer notifications
      this.onStreamingApproved();
    });

    // Handle takeover denial
    this.socket.on('takeover-denied', (data) => {
      console.log(`❌ ViewBot ${this.botId}: Takeover denied:`, data.reason);
      this.lastError = `Takeover denied: ${data.reason}`;
      this.streaming = false;
    });

    // Handle takeover by another streamer
    this.socket.on('stream-takeover', (data) => {
      console.log(`📢 ViewBot ${this.botId}: Stream taken over by ${data.newStreamerId}`);
      this.streaming = false;
    });

    // Handle stream end notifications
    this.socket.on('stream-ended', () => {
      console.log(`📺 ViewBot ${this.botId}: Stream ended notification received`);
      this.streaming = false;
    });
    
    this.socket.on('streamer-disconnected', () => {
      console.log(`📺 ViewBot ${this.botId}: Streamer disconnected notification received`);
    });

    // Handle viewer requests (ViewBot acting as streamer)
    this.socket.on('viewer-requesting-stream', (data) => {
      console.log(`👀 ViewBot ${this.botId}: Viewer ${data.viewerId} requesting stream`);
      this.handleViewerRequest(data.viewerId);
    });
  }

  /**
   * Called when server approves streaming - start producing media
   */
  async onStreamingApproved() {
    console.log(`🎬 ViewBot ${this.botId}: Now officially streaming, starting media production`);
    console.log(`🎬 ViewBot ${this.botId}: Socket connected: ${this.isConnected}, Socket ID: ${this.socket?.id}`);
    
    try {
      // Check if we should use GStreamer for video files
      // Use GStreamer by default for video files (unless explicitly set to false)
      const useGStreamer = this.config.useGStreamer !== false && 
                          this.config.contentType === 'videoFile' && 
                          this.config.videoFile;
      
      if (useGStreamer) {
        // For GStreamer, we use PlainTransport instead of WebRTC
        console.log(`🎬 ViewBot ${this.botId}: Using GStreamer with PlainTransport...`);
        await this.startGStreamerVideoFileStreaming();
      } else {
        // For FFmpeg, use WebRTC transport
        console.log(`🎬 ViewBot ${this.botId}: Setting up WebRTC transport and FFmpeg pipeline...`);
        await this.setupWebRTCTransport();
        await this.startFFmpegMediaGeneration();
      }
      
      // Confirm streaming is active
      this.streaming = true;
      this.startAllotmentTimer(); // Start the rotation timer
      
      const method = useGStreamer ? 'GStreamer' : 'FFmpeg';
      console.log(`✅ ViewBot ${this.botId}: ${method} pipeline active, streaming to MediaSoup`);
      
      // Wait a moment for streaming to start, then trigger viewer notification
      setTimeout(() => {
        this.notifyViewersOfReadyStream();
      }, 2000); // Give streaming 2 seconds to start
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to start FFmpeg streaming:`, error);
      this.lastError = error.message;
      this.streaming = false;
      
      // Notify server of failure
      if (this.socket) {
        this.socket.emit('streaming-error', {
          botId: this.botId,
          error: error.message
        });
      }
    }
  }

  /**
   * Sets up WebRTC transport for ViewBot to send media to MediaSoup
   */
  async setupWebRTCTransport() {
    console.log(`📡 ViewBot ${this.botId}: Setting up WebRTC send transport...`);
    
    try {
      // Request MediaSoup RTP capabilities (same as browser clients)
      const rtpCapabilities = await new Promise((resolve, reject) => {
        this.socket.emit('mediasoup:get-rtp-capabilities', {}, (response) => {
          if (response.success) {
            resolve(response.rtpCapabilities);
          } else {
            reject(new Error(response.error));
          }
        });
      });
      
      console.log(`✅ ViewBot ${this.botId}: Got RTP capabilities from server`);
      
      // Create WebRTC send transport (same as browser clients)
      const transportInfo = await new Promise((resolve, reject) => {
        this.socket.emit('mediasoup:create-send-transport', {}, (response) => {
          if (response.success) {
            resolve(response);
          } else {
            reject(new Error(response.error));
          }
        });
      });
      
      console.log(`✅ ViewBot ${this.botId}: WebRTC send transport created`);
      
      // Store transport info for later use
      this.transportInfo = transportInfo;
      this.rtpCapabilities = rtpCapabilities;
      
      console.log(`📡 ViewBot ${this.botId}: WebRTC transport setup complete`);
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: WebRTC transport setup failed:`, error);
      throw error;
    }
  }

  /**
   * Starts FFmpeg media generation and streaming to MediaSoup
   */
  async startFFmpegMediaGeneration() {
    console.log(`🎬 ViewBot ${this.botId}: Starting FFmpeg media generation...`);
    
    try {
      // This method is now only called for FFmpeg (GStreamer is handled in onStreamingApproved)
      if (this.config.contentType === 'videoFile' && this.config.videoFile) {
        // Use single FFmpeg process for video files (better A/V sync)
        console.log(`🎬 ViewBot ${this.botId}: Using combined FFmpeg for video file with A/V sync`);
        await this.startCombinedFFmpegGeneration();
      } else {
        // For test patterns, use separate processes (no sync issues with generated content)
        console.log(`🎬 ViewBot ${this.botId}: Using separate FFmpeg processes for test pattern`);
        // Generate test pattern video with FFmpeg
        await this.startFFmpegVideoGeneration();
        
        // Generate silent audio with FFmpeg
        await this.startFFmpegAudioGeneration();
      }
      
      console.log(`✅ ViewBot ${this.botId}: FFmpeg media generation started`);
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: FFmpeg media generation failed:`, error);
      throw error;
    }
  }

  /**
   * Starts combined FFmpeg process for video files (better A/V sync)
   * Now uses synchronized output approach for perfect A/V sync
   */
  async startCombinedFFmpegGeneration() {
    console.log(`🎬 ViewBot ${this.botId}: Starting synchronized FFmpeg for video file streaming...`);
    
    // Check if we should use the new multiplexed approach
    const useMuxedStream = this.config.useMuxedStream === true; // Default to false for stability
    
    if (useMuxedStream) {
      console.log(`🎬 ViewBot ${this.botId}: Using MULTIPLEXED stream for perfect A/V sync`);
      try {
        return await this.startMultiplexedFFmpegGeneration();
      } catch (error) {
        console.error(`❌ ViewBot ${this.botId}: Multiplexed stream failed, falling back to standard approach:`, error.message);
        // Continue with standard approach below
      }
    }
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    
    // Create RTP parameters for both streams
    const videoRtpParams = this.createVideoRtpParameters();
    const audioRtpParams = this.createAudioRtpParameters();
    
    // Create MediaSoup producers for both
    console.log(`📡 ViewBot ${this.botId}: Creating MediaSoup producers...`);
    await Promise.all([
      this.createWebRTCProducer('video', videoRtpParams),
      this.createWebRTCProducer('audio', audioRtpParams)
    ]);
    
    // Wait for transports to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      throw new Error('Failed to get RTP ports from server');
    }
    
    // Check file exists
    if (!fs.existsSync(this.config.videoFile)) {
      throw new Error(`Video file not found: ${this.config.videoFile}`);
    }
    
    // Build combined FFmpeg command with improved sync options
    const ffmpegArgs = [
      '-re', // Read input at native frame rate
      '-stream_loop', '-1', // Loop indefinitely
      '-i', this.config.videoFile,
      // Sync options - FIXED: Removed conflicting -async and -copyts flags
      '-vsync', 'cfr', // Constant frame rate for consistent timing
      // Video output
      '-map', '0:v:0', // Map first video stream
      '-vf', `scale=${width}:${height},setpts=PTS-STARTPTS`, // Scale and reset PTS
      '-r', frameRate.toString(),
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4', // FIXED: Optimized from 5 to 4 for better frame timing
      '-b:v', '1500k', // FIXED: Increased from 1000k for better quality
      '-maxrate', '2000k', // FIXED: Increased from 1500k
      '-bufsize', '4000k', // FIXED: Increased from 3000k for better buffering
      '-g', '30', // GOP size
      '-pix_fmt', 'yuv420p',
      '-an', // No audio in video RTP
      '-f', 'rtp',
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${this.videoRtpPort}`,
      // Audio output
      '-map', '0:a:0', // Map first audio stream
      '-af', 'asetpts=PTS-STARTPTS', // FIXED: Simplified audio filter for better sync
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      '-vn', // No video in audio RTP
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${this.audioRtpPort}`
    ];
    
    console.log(`🎬 ViewBot ${this.botId}: Starting combined FFmpeg process...`);
    console.log(`🎬 ViewBot ${this.botId}: Video RTP port: ${this.videoRtpPort}, Audio RTP port: ${this.audioRtpPort}`);
    
    try {
      this.combinedFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      console.log(`🎬 ViewBot ${this.botId}: Combined FFmpeg process PID: ${this.combinedFFmpeg.pid}`);
      
      // Set up handlers
      this.setupFFmpegHandlers(this.combinedFFmpeg, 'combined');
      
      // Store references for cleanup
      this.videoFFmpeg = this.combinedFFmpeg;
      this.audioFFmpeg = this.combinedFFmpeg;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('FFmpeg not installed. ViewBot requires FFmpeg for media generation.');
      }
      throw error;
    }
    
    console.log(`✅ ViewBot ${this.botId}: Combined FFmpeg process started with A/V sync`);
  }

  /**
   * NEW: Starts multiplexed FFmpeg generation for perfect A/V sync
   * Uses filter_complex and synchronized timestamp handling
   * Now supports PlainTransport with RTCP synchronization
   */
  async startMultiplexedFFmpegGeneration() {
    console.log(`🎬 ViewBot ${this.botId}: Starting MULTIPLEXED FFmpeg stream...`);
    
    // Check if we should use PlainTransport for better sync
    const usePlainTransport = this.config.usePlainTransport === true; // Default to false for stability
    
    if (usePlainTransport) {
      console.log(`🎬 ViewBot ${this.botId}: Using PlainTransport with RTCP synchronization`);
      try {
        return await this.startPlainTransportFFmpegGeneration();
      } catch (error) {
        console.error(`❌ ViewBot ${this.botId}: PlainTransport failed, falling back to standard approach:`, error.message);
        // Continue with standard approach below
      }
    }
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    
    // Create RTP parameters for both streams
    const videoRtpParams = this.createVideoRtpParameters();
    const audioRtpParams = this.createAudioRtpParameters();
    
    // Create MediaSoup producers for both
    console.log(`📡 ViewBot ${this.botId}: Creating MediaSoup producers for multiplexed stream...`);
    await Promise.all([
      this.createWebRTCProducer('video', videoRtpParams),
      this.createWebRTCProducer('audio', audioRtpParams)
    ]);
    
    // Wait for transports to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      throw new Error('Failed to get RTP ports from server');
    }
    
    // Check file exists
    if (!fs.existsSync(this.config.videoFile)) {
      throw new Error(`Video file not found: ${this.config.videoFile}`);
    }
    
    // Build multiplexed FFmpeg command with perfect sync
    const ffmpegArgs = [
      '-re', // Read input at native frame rate
      '-stream_loop', '-1', // Loop indefinitely
      '-i', this.config.videoFile,
      // Use filter_complex for synchronized processing
      '-filter_complex',
      `[0:v]scale=${width}:${height},fps=${frameRate},setpts=PTS-STARTPTS[vout];` +
      `[0:a]aresample=48000:first_pts=0,asetpts=PTS-STARTPTS,adelay=0|0[aout]`,
      // Map synchronized streams
      '-map', '[vout]',
      '-map', '[aout]',
      // Video encoding with optimized settings
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '60', // Increased GOP for better compression
      '-pix_fmt', 'yuv420p',
      '-flags', '+global_header', // Add global headers for better compatibility
      // Audio encoding with optimized settings
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-frame_duration', '20', // 20ms frames for consistent timing
      '-packet_loss', '10', // Handle up to 10% packet loss
      // Output configuration - Use segment muxer for synchronized chunks
      '-f', 'segment',
      '-segment_format', 'rtp',
      '-segment_time', '0.02', // 20ms segments for low latency
      '-segment_list_type', 'flat',
      '-segment_list', 'pipe:1',
      '-reset_timestamps', '1',
      // RTP output settings
      '-ssrc', '11111111:22222222', // Both SSRCs
      '-payload_type', '96:111', // Both payload types
      `rtp://127.0.0.1:${this.videoRtpPort}|rtp://127.0.0.1:${this.audioRtpPort}`
    ];
    
    // Optimized approach: Use filter_complex with synchronized timestamp processing
    const syncedArgs = [
      '-re',
      '-stream_loop', '-1', 
      '-i', this.config.videoFile,
      // Use filter_complex for perfectly synchronized processing
      '-filter_complex',
      `[0:v]scale=${width}:${height},fps=${frameRate},setpts=PTS-STARTPTS[vout];` +
      `[0:a]aresample=48000,asetpts=PTS-STARTPTS[aout]`,
      // Map synchronized video stream
      '-map', '[vout]',
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '60',
      '-pix_fmt', 'yuv420p',
      '-an', // No audio in video stream
      '-f', 'rtp',
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${this.videoRtpPort}`,
      // Map synchronized audio stream
      '-map', '[aout]',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-frame_duration', '20',
      '-vn', // No video in audio stream
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${this.audioRtpPort}`
    ];
    
    console.log(`🎬 ViewBot ${this.botId}: Using filter_complex for synchronized output`);
    console.log(`🎬 ViewBot ${this.botId}: Video RTP port: ${this.videoRtpPort}, Audio RTP port: ${this.audioRtpPort}`);
    
    try {
      this.combinedFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', syncedArgs);
      console.log(`🎬 ViewBot ${this.botId}: Multiplexed FFmpeg process PID: ${this.combinedFFmpeg.pid}`);
      
      // Enhanced error handling for multiplexed stream
      this.combinedFFmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('error') || output.includes('Error')) {
          console.error(`❌ ViewBot ${this.botId}: FFmpeg error:`, output);
        } else if (output.includes('Muxing overhead') || output.includes('video:') || output.includes('audio:')) {
          console.log(`✅ ViewBot ${this.botId}: Stream synchronized and running`);
        } else if (output.includes('frame=')) {
          // Log progress occasionally
          if (Math.random() < 0.01) {
            const frameMatch = output.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              console.log(`📊 ViewBot ${this.botId}: Multiplexed stream progress - frame ${frameMatch[1]}`);
            }
          }
        }
      });
      
      this.combinedFFmpeg.on('close', (code) => {
        console.log(`🛑 ViewBot ${this.botId}: Multiplexed FFmpeg process exited with code ${code}`);
      });
      
      this.combinedFFmpeg.on('error', (error) => {
        console.error(`❌ ViewBot ${this.botId}: FFmpeg process error:`, error);
      });
      
      // Store references for cleanup
      this.videoFFmpeg = this.combinedFFmpeg;
      this.audioFFmpeg = this.combinedFFmpeg;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('FFmpeg not installed. ViewBot requires FFmpeg for media generation.');
      }
      throw error;
    }
    
    console.log(`✅ ViewBot ${this.botId}: Multiplexed FFmpeg stream started with PERFECT A/V sync`);
  }

  /**
   * NEW: Starts FFmpeg with PlainTransport and RTCP synchronization
   * This provides the best possible A/V sync with proper timestamp coordination
   */
  async startPlainTransportFFmpegGeneration() {
    console.log(`🎬 ViewBot ${this.botId}: Starting PlainTransport FFmpeg stream with RTCP sync...`);
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    
    // Request PlainTransport creation from server
    console.log(`📡 ViewBot ${this.botId}: Requesting PlainTransport creation...`);
    
    const transportResult = await new Promise((resolve, reject) => {
      // Set a timeout in case the server doesn't support this event
      const timeout = setTimeout(() => {
        reject(new Error('PlainTransport not supported by server'));
      }, 3000);
      
      this.socket.emit('viewbot-create-plain-transport', {
        botId: this.botId,
        config: this.config
      }, (response) => {
        clearTimeout(timeout);
        if (response && response.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'Failed to create PlainTransport'));
        }
      });
    }).catch(error => {
      console.error(`❌ ViewBot ${this.botId}: PlainTransport not available:`, error.message);
      throw error;
    });
    
    if (!transportResult.success) {
      console.error(`❌ ViewBot ${this.botId}: Failed to create PlainTransport`);
      // Fallback to regular approach
      return this.startMultiplexedFFmpegGeneration();
    }
    
    const { videoRtpPort, videoRtcpPort, audioRtpPort, audioRtcpPort } = transportResult;
    
    console.log(`✅ ViewBot ${this.botId}: PlainTransport created`);
    console.log(`   Video RTP: ${videoRtpPort}, RTCP: ${videoRtcpPort}`);
    console.log(`   Audio RTP: ${audioRtpPort}, RTCP: ${audioRtcpPort}`);
    
    // Store ports for FFmpeg
    this.videoRtpPort = videoRtpPort;
    this.videoRtcpPort = videoRtcpPort;
    this.audioRtpPort = audioRtpPort;
    this.audioRtcpPort = audioRtcpPort;
    
    // Check file exists
    if (!fs.existsSync(this.config.videoFile)) {
      throw new Error(`Video file not found: ${this.config.videoFile}`);
    }
    
    // Build FFmpeg command with RTCP support for perfect sync
    const ffmpegArgs = [
      '-re', // Read at native frame rate
      '-stream_loop', '-1', // Loop indefinitely
      '-i', this.config.videoFile,
      // Use filter_complex for synchronized processing
      '-filter_complex',
      `[0:v]scale=${width}:${height},fps=${frameRate},setpts=PTS-STARTPTS[vout];` +
      `[0:a]aresample=48000,asetpts=PTS-STARTPTS[aout]`,
      // Video output with RTCP
      '-map', '[vout]',
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '60',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-f', 'rtp',
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${videoRtpPort}?rtcpport=${videoRtcpPort}`,
      // Audio output with RTCP
      '-map', '[aout]',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-frame_duration', '20',
      '-vn',
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${audioRtpPort}?rtcpport=${audioRtcpPort}`
    ];
    
    console.log(`🎬 ViewBot ${this.botId}: Starting FFmpeg with RTCP synchronization...`);
    
    try {
      this.combinedFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      console.log(`🎬 ViewBot ${this.botId}: PlainTransport FFmpeg process PID: ${this.combinedFFmpeg.pid}`);
      
      // Enhanced monitoring for RTCP sync
      this.combinedFFmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('error') || output.includes('Error')) {
          console.error(`❌ ViewBot ${this.botId}: FFmpeg error:`, output);
        } else if (output.includes('RTCP')) {
          console.log(`🔄 ViewBot ${this.botId}: RTCP sync active`);
        } else if (output.includes('frame=')) {
          if (Math.random() < 0.01) {
            const frameMatch = output.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              console.log(`📊 ViewBot ${this.botId}: PlainTransport stream - frame ${frameMatch[1]} (RTCP synced)`);
            }
          }
        }
      });
      
      this.combinedFFmpeg.on('close', (code) => {
        console.log(`🛑 ViewBot ${this.botId}: PlainTransport FFmpeg exited with code ${code}`);
      });
      
      // Store references
      this.videoFFmpeg = this.combinedFFmpeg;
      this.audioFFmpeg = this.combinedFFmpeg;
      this.usePlainTransport = true;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('FFmpeg not installed. ViewBot requires FFmpeg for media generation.');
      }
      throw error;
    }
    
    console.log(`✅ ViewBot ${this.botId}: PlainTransport FFmpeg started with PERFECT RTCP sync`);
  }

  /**
   * Check if GStreamer is available on the system
   */
  static async checkGStreamerAvailability() {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // Check common Windows installation path first
    const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
    if (fs.existsSync(gstreamerPath)) {
      return true;
    }
    
    // Try to find it in PATH
    try {
      await execPromise('gst-launch-1.0 --version');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Starts GStreamer-based video file streaming with MediaSoup PlainTransport
   * Alternative to FFmpeg for better performance and more control
   */
  
  
  
  /**
   * Starts GStreamer-based video file streaming with MediaSoup PlainTransport
   * Uses proper RTP configuration for MediaSoup compatibility
   */
  
  /**
   * Starts GStreamer-based video file streaming with proper A/V sync
   */
  
  /**
   * Starts GStreamer-based video file streaming with full playback
   */
  
  /**
   * Starts GStreamer-based video file streaming with MediaSoup PlainTransport
   * This version was displaying video successfully
   */
  
  /**
   * Starts GStreamer-based video file streaming with proper sync
   * Uses sync=false but with proper timestamps and rate control
   */
  
  /**
   * Starts GStreamer-based video file streaming using rtpbin
   * Based on mediasoup-demo's approach
   */
  
  /**
   * Starts GStreamer-based video file streaming with complete playback
   * Preserves sync while fixing early stopping issues
   */
  
  /**
   * Starts GStreamer-based video file streaming using rtpbin
   * This version has working sync but stops before end of video
   */
  
  /**
   * Starts GStreamer-based video file streaming with complete playback
   * Uses rtpbin with careful adjustments for full file playback
   */
  
  /**
   * Starts GStreamer-based video file streaming without rtpbin
   * Uses direct RTP streaming to avoid rtpbin's EOS issues
   */
  
  /**
   * Starts GStreamer-based video file streaming without rtpbin
   * Uses direct RTP streaming to avoid rtpbin's EOS issues
   * ENHANCED WITH EXTENSIVE DEBUGGING
   */
  async startGStreamerVideoFileStreaming() {
    console.log(`🎬 ViewBot ${this.botId}: Starting GStreamer-based video file streaming (DEBUGGING MODE)`);
    console.log(`📂 Video file: ${this.config.videoFile}`);
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    console.log(`📐 Resolution: ${width}x${height} @ ${frameRate}fps`);
    
    // Check file exists first
    if (!fs.existsSync(this.config.videoFile)) {
      console.error(`❌ ViewBot ${this.botId}: Video file not found: ${this.config.videoFile}`);
      throw new Error(`Video file not found: ${this.config.videoFile}`);
    }
    
    // Get file info
    const stats = fs.statSync(this.config.videoFile);
    console.log(`📊 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Generate fixed SSRCs that will be used by both GStreamer and MediaSoup
    const videoSSRC = 11111111;
    const audioSSRC = 22222222;
    
    console.log(`🔑 Using SSRCs - Video: ${videoSSRC}, Audio: ${audioSSRC}`);
    
    // Create RTP parameters with the EXACT SSRCs we'll use
    const videoRtpParams = {
      codecs: [{
        mimeType: 'video/VP8',
        payloadType: 96,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' }
        ]
      }],
      encodings: [{
        ssrc: videoSSRC
      }]
    };
    
    const audioRtpParams = {
      codecs: [{
        mimeType: 'audio/opus',
        payloadType: 111,
        clockRate: 48000,
        channels: 2,
        parameters: {
          'minptime': '10',
          'useinbandfec': '1'
        },
        rtcpFeedback: []
      }],
      encodings: [{
        ssrc: audioSSRC
      }]
    };
    
    // Create MediaSoup producers using socket events
    console.log(`📡 ViewBot ${this.botId}: Creating MediaSoup PlainTransport producers...`);
    console.log(`   Step 1: Creating video producer...`);
    
    // Store SSRCs for use in GStreamer
    this.videoSSRC = videoSSRC;
    this.audioSSRC = audioSSRC;
    
    try {
      await this.createWebRTCProducer('video', videoRtpParams);
      console.log(`   ✅ Video producer created`);
    } catch (err) {
      console.error(`   ❌ Failed to create video producer:`, err.message);
      throw err;
    }
    
    try {
      console.log(`   Step 2: Creating audio producer...`);
      await this.createWebRTCProducer('audio', audioRtpParams);
      console.log(`   ✅ Audio producer created`);
    } catch (err) {
      console.error(`   ❌ Failed to create audio producer:`, err.message);
      throw err;
    }
    
    // Wait for transports to be ready
    console.log(`⏳ Waiting for transports to be ready...`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      console.error(`❌ ViewBot ${this.botId}: Failed to get RTP ports from server`);
      console.error(`   Video port: ${this.videoRtpPort}, Audio port: ${this.audioRtpPort}`);
      throw new Error('Failed to get RTP ports from server');
    }
    
    console.log(`✅ ViewBot ${this.botId}: MediaSoup PlainTransport ready`);
    console.log(`   Video: RTP port ${this.videoRtpPort}, SSRC ${videoSSRC}`);
    console.log(`   Audio: RTP port ${this.audioRtpPort}, SSRC ${audioSSRC}`);
    
    try {
      // IMPORTANT: Use forward slashes for Windows paths in GStreamer
      const videoFile = this.config.videoFile.replace(/\\/g, '/');
      console.log(`📁 Converted path for GStreamer: ${videoFile}`);
      
      // Start separate pipelines without rtpbin
      console.log(`🚀 Starting GStreamer pipelines...`);
      await this.startDirectRTPPipelines(videoFile, width, height, frameRate);
      
      // Mark as using GStreamer
      this.useGStreamer = true;
      
      console.log(`✅ ViewBot ${this.botId}: GStreamer streaming started successfully`);
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: GStreamer launch failed:`, error.message);
      console.error(`   Full error:`, error);
      
      // Clean up any started processes
      this.cleanupGStreamerProcesses();
      
      // Fallback to FFmpeg if GStreamer fails
      console.log(`⚠️ ViewBot ${this.botId}: Falling back to FFmpeg method`);
      this.config.useGStreamer = false;
      
      if (typeof this.startFFmpegVideoFileStreaming === 'function') {
        await this.startFFmpegVideoFileStreaming();
      } else {
        throw new Error('FFmpeg fallback not available');
      }
    }
  }
  
  /**
   * Start GStreamer pipelines without rtpbin for complete playback
   * Uses separate video and audio pipelines with direct RTP streaming
   * ENHANCED WITH EXTENSIVE DEBUGGING
   */
  
  /**
   * Start GStreamer pipelines without rtpbin for complete playback
   * Uses separate video and audio pipelines with direct RTP streaming
   * FIXED: Use shell: true on Windows for GStreamer to work properly
   */
  async startDirectRTPPipelines(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Video pipeline - direct RTP without rtpbin
    const videoPipeline = [
      '-e',  // Force EOS on shutdown
      '-v',  // Verbose for debugging
      'filesrc', `location=${videoFile}`,
      '!', 'decodebin',
      '!', 'queue',
        'max-size-buffers=200',
        'max-size-time=2000000000',  // 2 seconds
        'max-size-bytes=10485760',   // 10MB
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', `video/x-raw,width=${width},height=${height}`,
      '!', 'videorate',
      '!', `video/x-raw,framerate=${frameRate}/1`,
      '!', 'vp8enc',
        'deadline=1',
        'cpu-used=4',
        'error-resilient=1',
        'target-bitrate=1500000',
        'keyframe-max-dist=30',
        'threads=2',
      '!', 'rtpvp8pay',
        `ssrc=${this.videoSSRC}`,
        'pt=96',
        'mtu=1200',
        'picture-id-mode=2',
      '!', 'udpsink',
        'host=127.0.0.1',
        `port=${this.videoRtpPort}`,
        'sync=true',   // Keep sync for proper timing
        'async=false'
    ];
    
    // Audio pipeline - direct RTP without rtpbin
    const audioPipeline = [
      '-e',  // Force EOS on shutdown
      '-v',  // Verbose for debugging
      'filesrc', `location=${videoFile}`,
      '!', 'decodebin',
      '!', 'queue',
        'max-size-buffers=200',
        'max-size-time=2000000000',  // 2 seconds
        'max-size-bytes=10485760',   // 10MB
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc',
        'bitrate=128000',
        'frame-size=20',
      '!', 'rtpopuspay',
        `ssrc=${this.audioSSRC}`,
        'pt=111',
        'mtu=1200',
      '!', 'udpsink',
        'host=127.0.0.1',
        `port=${this.audioRtpPort}`,
        'sync=true',   // Keep sync for proper timing
        'async=false'
    ];
    
    const gstreamerPath = '"C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe"';
    
    console.log(`🎥 ViewBot ${this.botId}: Starting video pipeline (no rtpbin)`);
    
    // CRITICAL FIX: Use shell: true on Windows for GStreamer to work
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      shell: true,  // REQUIRED for GStreamer on Windows
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(`🔊 ViewBot ${this.botId}: Starting audio pipeline (no rtpbin)`);
    
    // CRITICAL FIX: Use shell: true on Windows for GStreamer to work
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      shell: true,  // REQUIRED for GStreamer on Windows
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let videoStarted = false;
    let audioStarted = false;
    let videoEOS = false;
    let audioEOS = false;
    let videoError = '';
    let audioError = '';
    
    // Monitor video pipeline
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        videoError = output.substring(0, 200);
        console.error(`❌ ViewBot ${this.botId}: Video pipeline error`);
        console.error(output);
      } else if (output.includes('PLAYING')) {
        if (!videoStarted) {
          videoStarted = true;
          console.log(`▶️ ViewBot ${this.botId}: Video pipeline playing`);
        }
      } else if (output.includes('EOS')) {
        videoEOS = true;
        console.log(`🏁 ViewBot ${this.botId}: Video EOS received - complete playback!`);
      } else if (output.includes('Setting pipeline')) {
        console.log(`🔧 ViewBot ${this.botId}: Video pipeline initializing`);
      } else if (output.includes('caps = video/')) {
        console.log(`📹 ViewBot ${this.botId}: Video stream detected`);
      }
    });
    
    // Also monitor stdout for Windows
    this.gstreamerVideoProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Setting pipeline')) {
        console.log(`🔧 ViewBot ${this.botId}: Video pipeline state: ${output.trim()}`);
      }
    });
    
    // Monitor audio pipeline
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        audioError = output.substring(0, 200);
        console.error(`❌ ViewBot ${this.botId}: Audio pipeline error`);
        console.error(output);
      } else if (output.includes('PLAYING')) {
        if (!audioStarted) {
          audioStarted = true;
          console.log(`▶️ ViewBot ${this.botId}: Audio pipeline playing`);
        }
      } else if (output.includes('EOS')) {
        audioEOS = true;
        console.log(`🏁 ViewBot ${this.botId}: Audio EOS received - complete playback!`);
      } else if (output.includes('caps = audio/')) {
        console.log(`🔊 ViewBot ${this.botId}: Audio stream detected`);
      }
    });
    
    // Also monitor stdout for Windows
    this.gstreamerAudioProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Setting pipeline')) {
        console.log(`🔧 ViewBot ${this.botId}: Audio pipeline state: ${output.trim()}`);
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      console.error(`❌ ViewBot ${this.botId}: Failed to start video pipeline:`, error);
      throw error;
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      console.error(`❌ ViewBot ${this.botId}: Failed to start audio pipeline:`, error);
      // Audio failure is not critical, continue
    });
    
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      console.log(`🛑 ViewBot ${this.botId}: Video pipeline exited (code: ${code})`);
      
      if (videoEOS) {
        console.log(`   ✅ Video played to completion`);
      } else if (code === 0) {
        console.log(`   ✅ Video pipeline completed normally`);
      } else if (videoError) {
        console.error(`   ❌ Video error: ${videoError}`);
      }
      
      this.gstreamerVideoProcess = null;
      
      // Restart if looping is enabled
      if (this.config.loop && !this.stopping && (videoEOS || code === 0)) {
        console.log(`🔄 ViewBot ${this.botId}: Restarting video (loop enabled)`);
        setTimeout(() => {
          if (!this.stopping) {
            this.startDirectRTPPipelines(videoFile, width, height, frameRate)
              .catch(err => console.error(`Failed to restart:`, err));
          }
        }, 1000);
      }
    });
    
    this.gstreamerAudioProcess.on('exit', (code, signal) => {
      console.log(`🛑 ViewBot ${this.botId}: Audio pipeline exited (code: ${code})`);
      
      if (audioEOS) {
        console.log(`   ✅ Audio played to completion`);
      } else if (code === 0) {
        console.log(`   ✅ Audio pipeline completed normally`);
      } else if (audioError) {
        console.error(`   ❌ Audio error: ${audioError}`);
      }
      
      this.gstreamerAudioProcess = null;
    });
    
    // Wait for pipelines to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!videoStarted && !audioStarted) {
          const error = new Error('GStreamer pipelines failed to start');
          console.error(`❌ ViewBot ${this.botId}: ${error.message}`);
          
          if (videoError) {
            console.error(`   Video error: ${videoError}`);
          }
          if (audioError) {
            console.error(`   Audio error: ${audioError}`);
          }
          
          this.cleanupGStreamerProcesses();
          reject(error);
        } else {
          console.log(`⚠️ ViewBot ${this.botId}: Partial start (Video: ${videoStarted}, Audio: ${audioStarted})`);
          resolve();
        }
      }, 15000);
      
      const checkInterval = setInterval(() => {
        if (videoStarted || audioStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          console.log(`✅ ViewBot ${this.botId}: Pipelines started (Video: ${videoStarted}, Audio: ${audioStarted})`);
          resolve();
        }
      }, 100);
    });
  }

  
  /**
   * Clean up GStreamer processes
   */
  cleanupGStreamerProcesses() {
    console.log(`🧹 ViewBot ${this.botId}: Cleaning up GStreamer processes...`);
    this.stopping = true;
    
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      console.log(`   Killing video pipeline (PID: ${this.gstreamerVideoProcess.pid})`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      console.log(`   Killing audio pipeline (PID: ${this.gstreamerAudioProcess.pid})`);
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
    if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
      console.log(`   Killing GStreamer process (PID: ${this.gstreamerProcess.pid})`);
      this.gstreamerProcess.kill('SIGTERM');
      this.gstreamerProcess = null;
    }
    console.log(`   ✅ Cleanup complete`);
  }

  async startFFmpegVideoGeneration() {
    console.log(`📹 ViewBot ${this.botId}: Starting FFmpeg video generation...`);
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    const pattern = this.config.testPattern || this.config.contentType || 'color-bars';
    
    // Create RTP parameters for video FIRST
    const rtpParameters = this.createVideoRtpParameters();
    
    // Create MediaSoup plain transport and producer BEFORE starting FFmpeg
    console.log(`📡 ViewBot ${this.botId}: Creating MediaSoup video producer first...`);
    await this.createWebRTCProducer('video', rtpParameters);
    
    // Wait a moment for the transport to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if port was allocated
    if (!this.videoRtpPort) {
      throw new Error('Failed to get RTP port from server for video');
    }
    
    // Now start FFmpeg to send RTP data to the waiting transport
    const ffmpegArgs = this.createVideoFFmpegArgs(width, height, frameRate, pattern);
    
    console.log(`🎬 ViewBot ${this.botId}: Starting FFmpeg video process...`);
    console.log(`🎬 ViewBot ${this.botId}: FFmpeg will send video RTP to port ${this.videoRtpPort}`);
    console.log(`🎬 ViewBot ${this.botId}: FFmpeg video args:`, ffmpegArgs.join(' '));
    
    // Start FFmpeg process
    try {
      this.videoFFmpeg = spawn(this.ffmpegPath, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      this.videoFFmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('frame=')) {
          // FFmpeg is running
        }
      });
      
      this.videoFFmpeg.on('error', (error) => {
        console.error(`❌ ViewBot ${this.botId}: FFmpeg video error:`, error);
        throw error;
      });
      
      this.videoFFmpeg.on('close', (code) => {
        console.log(`🛑 ViewBot ${this.botId}: FFmpeg video process exited with code ${code}`);
        this.videoFFmpeg = null;
      });
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to start FFmpeg video:`, error);
      throw error;
    }
    
    console.log(`✅ ViewBot ${this.botId}: FFmpeg video generation started on port ${this.videoRtpPort}`);
  }
  
  async startGStreamerAudioPipeline(videoFile) {
    const { spawn } = require('child_process');
    
    // Build audio-only pipeline
    const audioPipeline = [
      'filesrc', `location="${videoFile}"`,
      '!', 'decodebin',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc',
        'bitrate=128000',
      '!', 'rtpopuspay',
        `ssrc=${Math.floor(Math.random() * 0xFFFFFFFF)}`,
        'pt=111',
        'mtu=1200',
      '!', 'udpsink',
        'host=127.0.0.1',
        `port=${this.audioRtpPort}`,
        'sync=false',
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
    
    console.log(`🔊 ViewBot ${this.botId}: Starting GStreamer audio pipeline on port ${this.audioRtpPort}`);
    
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        console.error(`❌ ViewBot ${this.botId}: GStreamer audio error:`, output);
      } else if (output.includes('PLAYING')) {
        console.log(`▶️ ViewBot ${this.botId}: GStreamer audio pipeline playing`);
      }
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      console.error(`❌ ViewBot ${this.botId}: Failed to start GStreamer audio:`, error);
      // Audio failure is not critical
      console.warn(`⚠️ ViewBot ${this.botId}: Continuing without audio`);
    });
    
    // Wait for pipeline to start (don't fail if audio doesn't work)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`⚠️ ViewBot ${this.botId}: Audio pipeline timeout, continuing`);
        resolve();
      }, 3000);
      
      const checkPlaying = (data) => {
        const output = data.toString();
        if (output.includes('PLAYING') || output.includes('Redistribute latency')) {
          clearTimeout(timeout);
          this.gstreamerAudioProcess.stderr.removeListener('data', checkPlaying);
          resolve();
        }
      };
      
      this.gstreamerAudioProcess.stderr.on('data', checkPlaying);
    });
  }


  /**
   * Starts FFmpeg video generation and creates MediaSoup video producer
   */
  async startFFmpegVideoGeneration() {
    console.log(`📹 ViewBot ${this.botId}: Starting FFmpeg video generation...`);
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    const pattern = this.config.testPattern || this.config.contentType || 'color-bars';
    
    // Create RTP parameters for video FIRST
    const rtpParameters = this.createVideoRtpParameters();
    
    // Create MediaSoup plain transport and producer BEFORE starting FFmpeg
    console.log(`📡 ViewBot ${this.botId}: Creating MediaSoup video producer first...`);
    await this.createWebRTCProducer('video', rtpParameters);
    
    // Wait a moment for the transport to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if port was allocated
    if (!this.videoRtpPort) {
      throw new Error('Failed to get RTP port from server for video');
    }
    
    // Now start FFmpeg to send RTP data to the waiting transport
    const ffmpegArgs = this.createVideoFFmpegArgs(width, height, frameRate, pattern);
    
    console.log(`🎬 ViewBot ${this.botId}: Starting FFmpeg video process...`);
    console.log(`🎬 ViewBot ${this.botId}: FFmpeg will send video RTP to port ${this.videoRtpPort}`);
    console.log(`🎬 ViewBot ${this.botId}: FFmpeg video args:`, ffmpegArgs.join(' '));
    
    // Start FFmpeg process
    try {
      console.log(`🎬 ViewBot ${this.botId}: Spawning FFmpeg video process...`);
      this.videoFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      
      console.log(`🎬 ViewBot ${this.botId}: FFmpeg video process PID: ${this.videoFFmpeg.pid}`);
      
      // Set up FFmpeg event handlers
      this.setupFFmpegHandlers(this.videoFFmpeg, 'video');
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.error(`❌ ViewBot ${this.botId}: FFmpeg not found. Please install FFmpeg to enable ViewBot streaming.`);
        console.error(`📋 ViewBot ${this.botId}: Installation instructions:`);
        console.error(`   Windows: Download from https://ffmpeg.org/download.html and add to PATH`);
        console.error(`   Or run: winget install ffmpeg`);
        console.error(`   Or use Chocolatey: choco install ffmpeg`);
        throw new Error('FFmpeg not installed. ViewBot requires FFmpeg for media generation.');
      }
      throw error;
    }
    
    console.log(`✅ ViewBot ${this.botId}: FFmpeg video generation started on port ${this.videoRtpPort}`);
  }

  /**
   * Starts FFmpeg audio generation and creates MediaSoup audio producer
   */
  async startFFmpegAudioGeneration() {
    console.log(`🎤 ViewBot ${this.botId}: Starting FFmpeg audio generation...`);
    
    // Create RTP parameters for audio FIRST
    const rtpParameters = this.createAudioRtpParameters();
    
    // Create MediaSoup plain transport and producer BEFORE starting FFmpeg
    console.log(`📡 ViewBot ${this.botId}: Creating MediaSoup audio producer first...`);
    await this.createWebRTCProducer('audio', rtpParameters);
    
    // Wait a moment for the transport to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if port was allocated
    if (!this.audioRtpPort) {
      throw new Error('Failed to get RTP port from server for audio');
    }
    
    // Now start FFmpeg to send RTP data to the waiting transport
    const ffmpegArgs = this.createAudioFFmpegArgs();
    
    console.log(`🎬 ViewBot ${this.botId}: Starting FFmpeg audio process...`);
    console.log(`🎬 ViewBot ${this.botId}: FFmpeg will send audio RTP to port ${this.audioRtpPort}`);
    console.log(`🎬 ViewBot ${this.botId}: FFmpeg audio args:`, ffmpegArgs.join(' '));
    
    // Start FFmpeg process
    try {
      this.audioFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      
      // Set up FFmpeg event handlers
      this.setupFFmpegHandlers(this.audioFFmpeg, 'audio');
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.error(`❌ ViewBot ${this.botId}: FFmpeg not found for audio generation.`);
        throw new Error('FFmpeg not installed. ViewBot requires FFmpeg for media generation.');
      }
      throw error;
    }
    
    console.log(`✅ ViewBot ${this.botId}: FFmpeg audio generation started on port ${this.audioRtpPort}`);
  }

  /**
   * Creates FFmpeg arguments for video test pattern generation
   */
  createVideoFFmpegArgs(width, height, frameRate, pattern) {
    if (!this.videoRtpPort) {
      throw new Error('Video RTP port not allocated by server');
    }
    
    // Determine input source based on content type
    let inputArgs = [];
    
    if (this.config.contentType === 'videoFile' && this.config.videoFile) {
      console.log(`🎬 ViewBot ${this.botId}: Using video file input: ${this.config.videoFile}`);
      console.log(`🎬 ViewBot ${this.botId}: ContentType is: "${this.config.contentType}"`);
      console.log(`🎬 ViewBot ${this.botId}: Video file path: "${this.config.videoFile}"`);
      
      // Check if file exists and is actually a file (not a directory)
      const path = require('path');
      
      if (!fs.existsSync(this.config.videoFile)) {
        console.error(`❌ ViewBot ${this.botId}: Video file does not exist: ${this.config.videoFile}`);
        throw new Error(`Video file not found: ${this.config.videoFile}`);
      }
      
      const stats = fs.statSync(this.config.videoFile);
      if (stats.isDirectory()) {
        console.error(`❌ ViewBot ${this.botId}: Path is a directory, not a file: ${this.config.videoFile}`);
        throw new Error(`Path is a directory, not a video file: ${this.config.videoFile}`);
      }
      
      // Check if file has a video extension
      const ext = path.extname(this.config.videoFile).toLowerCase();
      const validExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv', '.ts'];
      if (!validExtensions.includes(ext)) {
        console.warn(`⚠️ ViewBot ${this.botId}: File does not have a recognized video extension: ${ext}`);
        console.warn(`⚠️ ViewBot ${this.botId}: Supported extensions: ${validExtensions.join(', ')}`);
        console.warn(`⚠️ ViewBot ${this.botId}: Attempting to process anyway...`);
      }
      
      console.log(`✅ ViewBot ${this.botId}: Video file exists and will be used for streaming`);
      
      inputArgs = [
        '-stream_loop', '-1', // Loop video file indefinitely
        '-i', this.config.videoFile // Node.js spawn() handles paths with spaces automatically
      ];
    } else {
      // Use test pattern sources
      let videoInput;
      switch (pattern) {
        case 'color-bars':
        case 'color_bars':
          videoInput = `testsrc2=size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        case 'moving-text':
        case 'moving_text':
          videoInput = `color=black:size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        case 'clock':
          videoInput = `testsrc=size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        case 'noise':
          videoInput = `rgbtestsrc=size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        default:
          videoInput = `testsrc2=size=${width}x${height}:rate=${frameRate}:duration=3600`;
      }
      
      inputArgs = [
        '-f', 'lavfi',
        '-i', videoInput
      ];
    }
    
    // Use fixed SSRC that matches what MediaSoup expects
    const ssrc = 11111111; // Fixed video SSRC
    
    // Build complete FFmpeg args
    const args = [
      '-re', // Read input at native frame rate
      ...inputArgs, // Input source (test pattern or video file)
      // Video processing options with PTS reset for sync
      '-vf', `scale=${width}:${height},setpts=PTS-STARTPTS`, // Scale and reset PTS
      '-r', frameRate.toString(), // Set frame rate
      '-vsync', 'cfr', // Constant frame rate for consistent timing
      // Video codec settings for VP8
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-error-resilient', '1',
      '-auto-alt-ref', '0',
      '-cpu-used', '5',
      '-b:v', '1000k',
      '-maxrate', '1500k',
      '-bufsize', '3000k',
      '-g', '30', // Moderate GOP for better quality
      '-pix_fmt', 'yuv420p',
      // RTP output settings with fixed SSRC
      '-an', // No audio in video stream
      '-f', 'rtp',
      '-ssrc', String(ssrc),
      '-payload_type', '96',
      `rtp://127.0.0.1:${this.videoRtpPort}`
    ];
    
    console.log(`🎬 ViewBot ${this.botId}: Video FFmpeg command: ffmpeg ${args.join(' ')}`);
    
    // Debug the actual input configuration
    console.log(`🔍 ViewBot ${this.botId}: Video config debug:`);
    console.log(`  - contentType: "${this.config.contentType}"`);
    console.log(`  - videoFile: "${this.config.videoFile}"`);
    console.log(`  - using video file input: ${this.config.contentType === 'videoFile' && this.config.videoFile}`);
    console.log(`  - input args: [${inputArgs.join(', ')}]`);
    console.log(`  - target RTP port: ${this.videoRtpPort}`);
    
    return args;
  }

  /**
   * Creates FFmpeg arguments for audio generation
   */
  createAudioFFmpegArgs() {
    if (!this.audioRtpPort) {
      throw new Error('Audio RTP port not allocated by server');
    }
    
    // Use fixed SSRC that matches what MediaSoup expects
    const ssrc = 22222222; // Fixed audio SSRC
    
    // Determine audio input source based on content type
    let inputArgs = [];
    
    if (this.config.contentType === 'videoFile' && this.config.videoFile) {
      console.log(`🎤 ViewBot ${this.botId}: Extracting audio from video file: ${this.config.videoFile}`);
      console.log(`🎤 ViewBot ${this.botId}: ContentType is: "${this.config.contentType}"`);
      console.log(`🎤 ViewBot ${this.botId}: Video file path: "${this.config.videoFile}"`);
      
      // Check if file exists and is actually a file (not a directory)
      const path = require('path');
      
      if (!fs.existsSync(this.config.videoFile)) {
        console.error(`❌ ViewBot ${this.botId}: Video file does not exist: ${this.config.videoFile}`);
        throw new Error(`Video file not found: ${this.config.videoFile}`);
      }
      
      const stats = fs.statSync(this.config.videoFile);
      if (stats.isDirectory()) {
        console.error(`❌ ViewBot ${this.botId}: Path is a directory, not a file: ${this.config.videoFile}`);
        throw new Error(`Path is a directory, not a video file: ${this.config.videoFile}`);
      }
      
      console.log(`✅ ViewBot ${this.botId}: Video file exists, audio will be extracted`);
      
      inputArgs = [
        '-stream_loop', '-1', // Loop video file indefinitely
        '-i', this.config.videoFile // Node.js spawn() handles paths with spaces automatically
      ];
    } else {
      // Use silent audio for test patterns
      inputArgs = [
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:duration=3600' // Silent audio for 1 hour
      ];
    }
    
    // Build complete audio FFmpeg args
    const args = [
      '-re', // Read input at native frame rate
      ...inputArgs, // Input source (silent audio or video file audio)
      // Audio processing with sync
      '-af', 'aresample=async=1:first_pts=0', // Resample with sync
      // Audio codec settings for Opus
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      // RTP output settings with fixed SSRC
      '-vn', // No video in audio stream
      '-f', 'rtp',
      '-ssrc', String(ssrc),
      '-payload_type', '111',
      `rtp://127.0.0.1:${this.audioRtpPort}`
    ];
    
    console.log(`🎤 ViewBot ${this.botId}: Audio FFmpeg command: ffmpeg ${args.join(' ')}`);
    return args;
  }

  /**
   * Creates RTP parameters for video
   */
  createVideoRtpParameters() {
    const ssrc = Math.floor(Math.random() * 1000000);
    return {
      codecs: [
        {
          mimeType: 'video/VP8',
          clockRate: 90000,
          payloadType: 96,
          parameters: {},
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'goog-remb' }
          ]
        }
      ],
      headerExtensions: [],
      encodings: [
        {
          ssrc: ssrc,
          rtx: {
            ssrc: ssrc + 1
          }
        }
      ],
      rtcp: {
        cname: `viewbot-video-${this.botId}`,
        reducedSize: true
      }
    };
  }

  /**
   * Creates RTP parameters for audio
   */
  createAudioRtpParameters() {
    const ssrc = Math.floor(Math.random() * 1000000);
    return {
      codecs: [
        {
          mimeType: 'audio/opus',
          clockRate: 48000,
          payloadType: 111,
          channels: 2,
          parameters: {
            'sprop-stereo': 1,
            'useinbandfec': 1
          },
          rtcpFeedback: []
        }
      ],
      headerExtensions: [],
      encodings: [
        {
          ssrc: ssrc,
          dtx: false
        }
      ],
      rtcp: {
        cname: `viewbot-audio-${this.botId}`,
        reducedSize: true
      }
    };
  }

  /**
   * Sets up FFmpeg process event handlers
   */
  setupFFmpegHandlers(ffmpegProcess, kind) {
    ffmpegProcess.on('error', (error) => {
      console.error(`❌ ViewBot ${this.botId}: FFmpeg ${kind} error:`, error);
      this.lastError = `FFmpeg ${kind} error: ${error.message}`;
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        console.error(`❌ ViewBot ${this.botId}: FFmpeg ${kind} stderr:`, output);
      } else if (output.includes('frame=')) {
        // Occasionally log frame info for video
        if (kind === 'video' && Math.random() < 0.01) {
          console.log(`🎬 ViewBot ${this.botId}: FFmpeg video progress:`, output.trim().split('\n').pop());
        }
      }
    });

    ffmpegProcess.on('close', (code) => {
      console.log(`🛑 ViewBot ${this.botId}: FFmpeg ${kind} process exited with code ${code}`);
    });
  }

  /**
   * Creates MediaSoup plain RTP transport and producer for FFmpeg RTP stream
   */
  async createWebRTCProducer(kind, rtpParameters) {
    console.log(`📡 ViewBot ${this.botId}: Creating plain RTP transport for ${kind}...`);
    
    return new Promise((resolve, reject) => {
      // Request server to create plain RTP transport that will listen for FFmpeg RTP data
      this.socket.emit('viewbot-create-plain-transport', {
        botId: this.botId,
        kind: kind,
        rtpParameters: rtpParameters
      });
      
      // Listen for producer creation confirmation
      const handleProducerCreated = (data) => {
        if (data.botId === this.botId && data.kind === kind) {
          console.log(`✅ ViewBot ${this.botId}: Plain RTP ${kind} producer created:`, data.producerId);
          console.log(`📡 ViewBot ${this.botId}: Server allocated port ${data.rtpPort} for ${kind} RTP`);
          
          // Store the allocated port for FFmpeg
          if (kind === 'video') {
            this.videoRtpPort = data.rtpPort;
          } else {
            this.audioRtpPort = data.rtpPort;
          }
          
          // CRITICAL FIX: Check if socket still exists before removing listeners
          if (this.socket) {
            this.socket.off('viewbot-producer-created', handleProducerCreated);
          }
          resolve(data.producerId);
        }
      };
      
      const handleProducerError = (data) => {
        if (data.botId === this.botId && data.kind === kind) {
          console.error(`❌ ViewBot ${this.botId}: Plain RTP ${kind} producer creation failed:`, data.error);
          // CRITICAL FIX: Check if socket still exists before removing listeners
          if (this.socket) {
            this.socket.off('viewbot-producer-error', handleProducerError);
            this.socket.off('viewbot-producer-created', handleProducerCreated);
          }
          reject(new Error(data.error));
        }
      };
      
      this.socket.on('viewbot-producer-created', handleProducerCreated);
      this.socket.on('viewbot-producer-error', handleProducerError);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        // CRITICAL FIX: Check if socket still exists before trying to remove listeners
        if (this.socket) {
          this.socket.off('viewbot-producer-created', handleProducerCreated);
          this.socket.off('viewbot-producer-error', handleProducerError);
        }
        reject(new Error(`Plain RTP ${kind} producer creation timeout`));
      }, 10000);
    });
  }

  /**
   * Handles viewer requests for stream
   */
  handleViewerRequest(viewerId) {
    console.log(`🤝 ViewBot ${this.botId}: Handling stream request from viewer ${viewerId}`);
    
    // For ViewBots, we send a special offer that tells the viewer what kind of content to generate
    const offer = {
      type: 'viewbot-offer',
      contentType: this.config.contentType,
      testPattern: this.config.testPattern,
      config: this.config,
      streamerId: this.botId,
      isViewBot: true
    };
    
    if (this.socket) {
      this.socket.emit('stream-offer', {
        offer: offer,
        toViewerId: viewerId
      });
    }
    
    console.log(`📤 ViewBot ${this.botId}: Sent ViewBot offer to viewer ${viewerId}`);
  }

  /**
   * Initializes media generation based on configuration
   */
  async initializeMediaGeneration() {
    console.log(`🎬 ViewBot ${this.botId}: Initializing media generation (${this.config.contentType})`);
    
    switch (this.config.contentType) {
      case 'testPattern':
        await this.initializeTestPatternGeneration();
        break;
      case 'customText':
        await this.initializeTestPatternGeneration(); // Use same canvas system as test patterns
        break;
      case 'videoFile':
        // NEW: Skip old video file streaming - use RTP streaming instead
        console.log(`📹 ViewBot ${this.botId}: Video file streaming handled by RTP system, skipping old method`);
        break;
      case 'webCam':
        await this.initializeWebCamCapture();
        break;
      case 'screenCapture':
        await this.initializeScreenCapture();
        break;
      default:
        throw new Error(`Unsupported content type: ${this.config.contentType}`);
    }
  }

  /**
   * Initializes test pattern generation (similar to TestStreamGenerator)
   */
  async initializeTestPatternGeneration() {
    console.log(`🎨 ViewBot ${this.botId}: Setting up test pattern generation`);
    
    // Launch a headless browser for canvas-based generation
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });
    
    this.page = await this.browser.newPage();
    
    // Set up canvas-based media generation
    const canvasHTML = this.generateCanvasHTML();
    await this.page.setContent(canvasHTML);
    
    // Wait for canvas to be ready
    await this.page.waitForSelector('#media-canvas');
    
    console.log(`✅ ViewBot ${this.botId}: Test pattern generation ready`);
  }

  /**
   * Generates HTML for canvas-based media generation
   */
  generateCanvasHTML() {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>ViewBot Media Generator</title>
      </head>
      <body>
        <canvas id="media-canvas" width="${this.config.width}" height="${this.config.height}"></canvas>
        <script>
          const canvas = document.getElementById('media-canvas');
          const ctx = canvas.getContext('2d');
          let frame = 0;
          let hue = 0;
          
          function drawFrame() {
            // Clear canvas
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Draw content based on type
            const mainContentType = '${this.config.contentType}';
            const testPattern = '${this.config.testPattern || 'color-bars'}';
            
            if (mainContentType === 'customText') {
              drawCustomText();
            } else {
              // Test pattern mode
              switch(testPattern) {
                case 'color-bars':
                  drawColorBars();
                  break;
                case 'moving-text':
                  drawMovingText();
                  break;
                case 'clock':
                  drawClock();
                  break;
                case 'noise':
                  drawNoise();
                  break;
                case 'gradient':
                  drawGradient();
                  break;
                default:
                  drawColorBars();
              }
            }
            
            // Draw overlay info
            drawOverlay();
            
            // Update animation variables
            frame++;
            hue = (hue + 2) % 360;
            
            requestAnimationFrame(drawFrame);
          }
          
          function drawColorBars() {
            const colors = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
            const barWidth = canvas.width / colors.length;
            
            colors.forEach((color, index) => {
              ctx.fillStyle = color;
              ctx.fillRect(index * barWidth, 0, barWidth, canvas.height);
            });
          }
          
          function drawMovingText() {
            ctx.fillStyle = '#001122';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            const text = 'ViewBot ${this.botId} - Test Stream';
            const x = ((Date.now() * 0.1) % (canvas.width + 400)) - 400;
            
            ctx.fillStyle = '#00ff88';
            ctx.font = 'bold 48px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(text, x, canvas.height / 2);
          }
          
          function drawClock() {
            ctx.fillStyle = '#111111';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            const now = new Date();
            
            ctx.fillStyle = '#00ff00';
            ctx.font = 'bold 72px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(now.toLocaleTimeString(), canvas.width / 2, canvas.height / 2 - 20);
            
            ctx.font = 'bold 32px monospace';
            ctx.fillText(now.toLocaleDateString(), canvas.width / 2, canvas.height / 2 + 40);
          }
          
          function drawNoise() {
            const imageData = ctx.createImageData(canvas.width, canvas.height);
            const data = imageData.data;
            
            for (let i = 0; i < data.length; i += 4) {
              const noise = Math.random() * 255;
              data[i] = noise;     // Red
              data[i + 1] = noise; // Green
              data[i + 2] = noise; // Blue
              data[i + 3] = 255;   // Alpha
            }
            
            ctx.putImageData(imageData, 0, 0);
          }
          
          function drawGradient() {
            // Create animated rainbow gradient
            const time = Date.now() * 0.001;
            
            // Horizontal gradient with shifting colors
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
            
            for (let i = 0; i <= 1; i += 0.1) {
              const hue = ((i * 360 + time * 50) % 360);
              const color = 'hsl(' + hue + ', 100%, 50%)';
              gradient.addColorStop(i, color);
            }
            
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Add vertical gradient overlay
            const vertGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
            vertGradient.addColorStop(0, 'rgba(255,255,255,0.2)');
            vertGradient.addColorStop(0.5, 'rgba(255,255,255,0)');
            vertGradient.addColorStop(1, 'rgba(0,0,0,0.2)');
            
            ctx.fillStyle = vertGradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          
          function drawCustomText() {
            // Background color
            ctx.fillStyle = '${this.config.backgroundColor || '#001122'}';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Custom text
            const text = '${this.config.customText || 'Custom Text'}';
            const textColor = '${this.config.textColor || '#00ff88'}';
            const fontSize = ${this.config.fontSize || 48};
            
            ctx.fillStyle = textColor;
            ctx.font = 'bold ' + fontSize + 'px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Split text into lines if it's too long
            const maxWidth = canvas.width - 40;
            const lines = [];
            const words = text.split(' ');
            let currentLine = words[0];
            
            for (let i = 1; i < words.length; i++) {
              const word = words[i];
              const width = ctx.measureText(currentLine + ' ' + word).width;
              if (width < maxWidth) {
                currentLine += ' ' + word;
              } else {
                lines.push(currentLine);
                currentLine = word;
              }
            }
            lines.push(currentLine);
            
            // Draw each line
            const lineHeight = fontSize * 1.2;
            const totalHeight = lines.length * lineHeight;
            const startY = (canvas.height - totalHeight) / 2 + lineHeight / 2;
            
            for (let i = 0; i < lines.length; i++) {
              const y = startY + (i * lineHeight);
              ctx.fillText(lines[i], canvas.width / 2, y);
            }
          }
          
          function drawOverlay() {
            // Semi-transparent overlay
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, canvas.width, 40);
            ctx.fillRect(0, canvas.height - 60, canvas.width, 60);
            
            // Top text
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('ViewBot ${this.botId}', canvas.width / 2, 25);
            
            // Bottom text
            ctx.font = '12px Arial';
            ctx.fillText('Frame: ' + frame + ' | ' + new Date().toLocaleTimeString(), canvas.width / 2, canvas.height - 35);
            ctx.fillText('Resolution: ${this.config.width}×${this.config.height} | FPS: ${this.config.frameRate}', canvas.width / 2, canvas.height - 15);
          }
          
          // Start animation
          drawFrame();
        </script>
      </body>
      </html>
    `;
  }

  /**
   * Initializes video file streaming
   */
  async initializeVideoFileStreaming() {
    if (!this.config.videoFile || !fs.existsSync(this.config.videoFile)) {
      throw new Error(`Video file not found: ${this.config.videoFile}`);
    }
    
    console.log(`🎬 ViewBot ${this.botId}: Setting up video file streaming from ${this.config.videoFile}`);
    
    // Use FFmpeg to stream the video file
    const ffmpegArgs = [
      '-re', // Read input at native frame rate
      '-stream_loop', '-1', // Loop indefinitely
      '-i', this.config.videoFile,
      '-vf', `scale=${this.config.width}:${this.config.height}`,
      '-r', this.config.frameRate.toString(),
      '-c:v', 'libvpx',
      '-b:v', this.config.videoBitrate,
      '-c:a', 'libopus',
      '-b:a', this.config.audioBitrate,
      '-f', 'webm',
      'pipe:1'
    ];
    
    this.ffmpegProcess = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
    
    this.ffmpegProcess.on('error', (error) => {
      console.error(`❌ ViewBot ${this.botId}: FFmpeg error:`, error);
      this.lastError = `FFmpeg error: ${error.message}`;
    });
    
    this.ffmpegProcess.stderr.on('data', (data) => {
      // Log FFmpeg output for debugging
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        console.error(`❌ ViewBot ${this.botId}: FFmpeg stderr:`, output);
      }
    });
    
    console.log(`✅ ViewBot ${this.botId}: Video file streaming initialized`);
  }

  /**
   * Initializes webcam capture
   */
  async initializeWebCamCapture() {
    throw new Error('WebCam capture not implemented yet');
  }

  /**
   * Initializes screen capture
   */
  async initializeScreenCapture() {
    throw new Error('Screen capture not implemented yet');
  }

  /**
   * Starts streaming to the server
   */
  async startStreaming() {
    console.log(`🎬 ViewBot ${this.botId}: Starting streaming process...`);
    
    if (this.streaming) {
      console.log(`⚠️ ViewBot ${this.botId}: Already streaming, aborting start`);
      return { success: false, message: 'Already streaming' };
    }

    if (!this.isConnected) {
      console.log(`❌ ViewBot ${this.botId}: Not connected to server, cannot start streaming`);
      console.log(`💡 ViewBot ${this.botId}: Socket connection status: ${this.socket ? 'exists' : 'missing'}`);
      return { success: false, message: 'Not connected to server' };
    }
    
    console.log(`✅ ViewBot ${this.botId}: Pre-flight checks passed, proceeding with stream start`);
    
    // SAFETY CHECK: Double-check real streamer protection before attempting to stream
    if (this.parentService && this.parentService.realStreamerActive) {
      console.log(`🚫 ViewBot ${this.botId}: Cannot start - real streamer is active (safety check)`);
      return { success: false, message: 'Real streamer is active - ViewBot cannot start' };
    }

    try {
      console.log(`🎬 ViewBot ${this.botId}: Starting stream (${this.config.contentType})...`);
      
      // Initialize media generation for content types that need it
      if (this.config.contentType === 'testPattern' || this.config.contentType === 'customText') {
        console.log(`🎨 ViewBot ${this.botId}: Initializing media generation for ${this.config.contentType}`);
        await this.initializeMediaGeneration();
      } else {
        console.log(`🎬 ViewBot ${this.botId}: Skipping media generation for ${this.config.contentType}, using synthetic producers`);
      }
      
      // IMPORTANT: Use the same event flow as real users to trigger takeover logic
      // This will go through the takeover service and properly notify viewers
      if (this.socket) {
        this.socket.emit('request-to-stream', {
          streamType: 'viewbot',
          isViewBot: true,
          botId: this.botId,
          username: `ViewBot-${this.botId}`,
          streamConfig: this.config,
          useNewViewBotSystem: true // Flag to indicate using ViewBotClientService
        });
      }
      
      // Set up stream handling (no real media stream needed)
      this.mediaStream = null; // ViewBots don't need real media streams
      this.streaming = true;
      this.startAllotmentTimer(); // Start the rotation timer
      this.startTime = Date.now();
      this.sessionStartTime = this.startTime;
      
      // Start database session tracking
      if (this.parentService && this.parentService.dbInitialized) {
        try {
          const sessionResult = await this.parentService.dbService.startSession({
            botId: this.botId,
            metadata: {
              config: this.config,
              timeAllotment: this.timeAllotment
            }
          });
          
          if (sessionResult.success) {
            this.currentSessionId = sessionResult.sessionId;
            console.log(`💾 ViewBot ${this.botId}: Started database session ${this.currentSessionId}`);
          }
        } catch (dbError) {
          console.error(`⚠️ ViewBot ${this.botId}: Failed to start database session:`, dbError);
        }
      }
      
      console.log(`✅ ViewBot ${this.botId}: Streaming request sent via request-to-stream`);
      
      return {
        success: true,
        message: `ViewBot ${this.botId} started streaming`,
        streamId: this.botId,
        startTime: this.startTime
      };
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to start streaming:`, error);
      this.lastError = error.message;
      return {
        success: false,
        message: `Failed to start streaming: ${error.message}`
      };
    }
  }

  /**
   * Gets the media stream based on content type
   */
  async getMediaStream() {
    switch (this.config.contentType) {
      case 'testPattern':
        return await this.getCanvasMediaStream();
      case 'customText':
        return await this.getCanvasMediaStream(); // Use canvas for custom text too
      case 'videoFile':
        return await this.getVideoFileStream();
      default:
        throw new Error(`Media stream not implemented for content type: ${this.config.contentType}`);
    }
  }

  /**
   * Gets media stream from canvas (test patterns)
   */
  async getCanvasMediaStream() {
    if (!this.page) {
      throw new Error('Canvas page not initialized');
    }
    
    // Use puppeteer to capture the canvas as a media stream
    const mediaStream = await this.page.evaluate(() => {
      const canvas = document.getElementById('media-canvas');
      if (!canvas) {
        throw new Error('Canvas element not found');
      }
      
      return canvas.captureStream(30); // 30 FPS
    });
    
    return mediaStream;
  }

  /**
   * Gets media stream from video file
   */
  async getVideoFileStream() {
    // This would require more complex implementation
    // For now, return a placeholder
    throw new Error('Video file streaming not fully implemented');
  }

  /**
   * Stops streaming
   */
  async stopStreaming() {
    if (!this.streaming) {
      return { success: false, message: 'Not currently streaming' };
    }

    try {
      console.log(`⏹️ ViewBot ${this.botId}: Stopping stream...`);
      
      // Emit 'stop-stream' event
      if (this.socket && this.isConnected) {
        this.socket.emit('stop-stream', {
          botId: this.botId,
          isViewBot: true
        });
      }
      
      // Clean up media stream
      if (this.mediaStream) {
        if (this.mediaStream.getTracks) {
          this.mediaStream.getTracks().forEach(track => track.stop());
        }
        this.mediaStream = null;
      }
      
      this.streaming = false;
      this.stopAllotmentTimer(); // Stop the rotation timer
      const duration = this.startTime ? Date.now() - this.startTime : 0;
      this.startTime = null;
      
      // End database session tracking
      if (this.currentSessionId && this.parentService && this.parentService.dbInitialized) {
        try {
          await this.parentService.dbService.endSession(this.currentSessionId, {
            duration,
            status: 'completed'
          });
          console.log(`💾 ViewBot ${this.botId}: Ended database session ${this.currentSessionId}`);
          this.currentSessionId = null;
          this.sessionStartTime = null;
        } catch (dbError) {
          console.error(`⚠️ ViewBot ${this.botId}: Failed to end database session:`, dbError);
        }
      }
      
      // CRITICAL: Stop FFmpeg processes to actually stop broadcasting
      await this.cleanupMediaGeneration();
      
      console.log(`✅ ViewBot ${this.botId}: Streaming stopped (duration: ${duration}ms)`);
      
      return {
        success: true,
        message: `ViewBot ${this.botId} stopped streaming`,
        duration
      };
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to stop streaming:`, error);
      this.lastError = error.message;
      return {
        success: false,
        message: `Failed to stop streaming: ${error.message}`
      };
    }
  }

  /**
   * Updates bot configuration
   */
  async updateConfig(newConfig) {
    const wasStreaming = this.streaming;
    
    try {
      // Stop streaming if active
      if (wasStreaming) {
        await this.stopStreaming();
      }
      
      // Convert streamDuration (minutes) to timeAllotment (milliseconds) if provided
      if (newConfig.streamDuration !== undefined) {
        if (newConfig.streamDuration > 0) {
          newConfig.timeAllotment = newConfig.streamDuration * 60 * 1000; // Convert minutes to milliseconds
          this.timeAllotment = newConfig.timeAllotment;
          this.timeRemaining = this.timeAllotment; // Reset time remaining
          console.log(`⏱️ ViewBot ${this.botId}: Updated time allotment to ${newConfig.streamDuration} minutes`);
        } else {
          // If duration is 0, remove time allotment (infinite streaming)
          newConfig.timeAllotment = null;
          this.timeAllotment = this.generateRandomTimeAllotment(); // Use random time for rotation
          this.timeRemaining = this.timeAllotment;
          console.log(`⏱️ ViewBot ${this.botId}: Set to infinite streaming (using random rotation time)`);
        }
      }
      
      // Update configuration
      this.config = { ...this.config, ...newConfig };
      
      // Reinitialize media generation if content type changed
      if (newConfig.contentType || newConfig.videoFile || 
          newConfig.width || newConfig.height || newConfig.frameRate) {
        await this.cleanupMediaGeneration();
        await this.initializeMediaGeneration();
      }
      
      // Restart streaming if it was active
      if (wasStreaming) {
        await this.startStreaming();
      }
      
      return {
        success: true,
        message: `ViewBot ${this.botId} configuration updated`,
        config: this.config
      };
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to update config:`, error);
      this.lastError = error.message;
      return {
        success: false,
        message: `Failed to update config: ${error.message}`
      };
    }
  }

  /**
   * Cleans up media generation resources
   */
  async cleanupMediaGeneration() {
    console.log(`🧹 ViewBot ${this.botId}: Cleaning up media generation processes...`);
    
    
    // Clean up GStreamer processes if they exist
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      console.log(`🛑 ViewBot ${this.botId}: Killing GStreamer video process`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      console.log(`🛑 ViewBot ${this.botId}: Killing GStreamer audio process`);
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
    
    // Original cleanup for single process
    if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
      console.log(`🛑 ViewBot ${this.botId}: Killing GStreamer process`);
      this.gstreamerProcess.kill('SIGTERM');
      this.gstreamerProcess = null;
      this.useGStreamer = false;
    }
    
    // Clean up combined FFmpeg process if exists
    if (this.combinedFFmpeg && !this.combinedFFmpeg.killed) {
      console.log(`🛑 ViewBot ${this.botId}: Killing combined FFmpeg process`);
      this.combinedFFmpeg.kill('SIGTERM');
      this.combinedFFmpeg = null;
      this.videoFFmpeg = null;
      this.audioFFmpeg = null;
    } else {
      // Clean up video FFmpeg process
      if (this.videoFFmpeg && !this.videoFFmpeg.killed) {
        console.log(`🛑 ViewBot ${this.botId}: Killing video FFmpeg process`);
        this.videoFFmpeg.kill('SIGTERM');
        this.videoFFmpeg = null;
      }
      
      // Clean up audio FFmpeg process (only if it's different from video)
      if (this.audioFFmpeg && this.audioFFmpeg !== this.videoFFmpeg && !this.audioFFmpeg.killed) {
        console.log(`🛑 ViewBot ${this.botId}: Killing audio FFmpeg process`);
        this.audioFFmpeg.kill('SIGTERM');
        this.audioFFmpeg = null;
      }
    }
    
    // Clean up legacy FFmpeg process (for backward compatibility)
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      console.log(`🛑 ViewBot ${this.botId}: Killing legacy FFmpeg process`);
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
    
    // Clean up Puppeteer resources (no longer used but kept for safety)
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    
    console.log(`✅ ViewBot ${this.botId}: Media generation cleanup complete`);
  }

  /**
   * Destroys the bot and cleans up all resources
   */
  async destroy() {
    console.log(`🗑️ ViewBot ${this.botId}: Destroying bot...`);
    
    try {
      // Stop streaming if active
      await this.stopStreaming();
      
      // Disconnect from server
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
      }
      
      // Clean up media generation
      await this.cleanupMediaGeneration();
      
      this.isConnected = false;
      
      console.log(`✅ ViewBot ${this.botId}: Destroyed successfully`);
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Error during destruction:`, error);
      this.lastError = error.message;
      throw error;
    }
  }

  /**
   * Gets the current status of the bot
   */
  getStatus() {
    const uptime = this.startTime ? Date.now() - this.startTime : 0;
    
    return {
      isConnected: this.isConnected,
      isStreaming: this.streaming,
      streaming: this.streaming,  // Add duplicate for compatibility
      startTime: this.startTime,
      uptime,
      config: this.config,
      lastError: this.lastError,
      serverUrl: this.serverUrl,
      // ViewBot rotation info
      timeAllotment: this.timeAllotment,
      timeRemaining: this.timeRemaining,
      timeAllotmentFormatted: this.formatDuration(this.timeAllotment),
      timeRemainingFormatted: this.formatDuration(Math.max(0, this.timeRemaining)),
      sessionStartTime: this.sessionStartTime
    };
  }

  /**
   * Checks if the bot is streaming
   */
  isStreaming() {
    return this.streaming;
  }

  /**
   * Checks if the bot is healthy
   */
  isHealthy() {
    return this.isConnected && !this.lastError;
  }

  /**
   * Notifies viewers that ViewBot stream is ready for consumption
   * This triggers the stream switching mechanism without page refresh
   */
  notifyViewersOfReadyStream() {
    if (!this.socket) {
      console.error(`❌ ViewBot ${this.botId}: Cannot notify viewers - no socket connection`);
      return;
    }

    try {
      console.log(`📺 ViewBot ${this.botId}: Notifying viewers that stream is ready...`);
      
      // Emit a custom event to trigger stream switching
      if (this.socket) {
        this.socket.emit('viewbot-stream-ready', {
          botId: this.botId,
          streamType: 'viewbot',
          timestamp: Date.now()
        });
      }
      
      console.log(`✅ ViewBot ${this.botId}: Stream ready notification sent to server`);
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to notify viewers:`, error);
    }
  }

  /**
   * Generates a random time allotment between 15 seconds and 8 minutes (in milliseconds)
   */
  generateRandomTimeAllotment() {
    const minTime = 15 * 1000; // 15 seconds in ms
    const maxTime = 8 * 60 * 1000; // 8 minutes in ms
    const randomTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    
    console.log(`🎲 ViewBot ${this.botId}: Generated random time allotment: ${this.formatDuration(randomTime)}`);
    return randomTime;
  }

  /**
   * Formats duration in milliseconds to human readable format
   */
  formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m ${seconds}s`;
    }
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Starts the allotment timer when ViewBot begins streaming
   * CRITICAL FIX: Only start timer if rotation system is enabled
   */
  startAllotmentTimer() {
    if (this.allotmentTimer) {
      clearInterval(this.allotmentTimer);
    }

    // Check if rotation is enabled through the parent service
    const parentService = this.getParentService();
    if (parentService && !parentService.rotationEnabled) {
      console.log(`⏸️ ViewBot ${this.botId}: Rotation disabled - timer will not start, streaming indefinitely`);
      return;
    }

    console.log(`⏱️ ViewBot ${this.botId}: Starting allotment timer (${this.formatDuration(this.timeAllotment)})`);
    
    this.allotmentTimer = setInterval(() => {
      this.timeRemaining -= 1000; // Decrease by 1 second
      
      // Check if time is up
      if (this.timeRemaining <= 0) {
        console.log(`⏰ ViewBot ${this.botId}: Time allotment expired, requesting rotation`);
        this.requestRotation();
      }
    }, 1000);
  }

  /**
   * Stops the allotment timer when ViewBot stops streaming
   */
  stopAllotmentTimer() {
    if (this.allotmentTimer) {
      clearInterval(this.allotmentTimer);
      this.allotmentTimer = null;
      console.log(`⏱️ ViewBot ${this.botId}: Stopped allotment timer`);
    }
  }

  /**
   * Pauses the allotment timer (rotation disabled)
   * CRITICAL FIX: Allows viewbots to stream indefinitely when rotation is disabled
   */
  pauseAllotmentTimer() {
    if (this.allotmentTimer) {
      clearInterval(this.allotmentTimer);
      this.allotmentTimer = null;
      console.log(`⏸️ ViewBot ${this.botId}: Paused allotment timer - streaming indefinitely`);
    }
  }

  /**
   * Resumes the allotment timer (rotation re-enabled)
   * CRITICAL FIX: Restarts timer when rotation is re-enabled
   */
  resumeAllotmentTimer() {
    if (this.streaming && !this.allotmentTimer && this.timeRemaining > 0) {
      console.log(`▶️ ViewBot ${this.botId}: Resuming allotment timer with ${this.formatDuration(this.timeRemaining)} remaining`);
      
      this.allotmentTimer = setInterval(() => {
        this.timeRemaining -= 1000; // Decrease by 1 second
        
        // Check if time is up
        if (this.timeRemaining <= 0) {
          console.log(`⏰ ViewBot ${this.botId}: Time allotment expired, requesting rotation`);
          this.requestRotation();
        }
      }, 1000);
    }
  }

  /**
   * Gets reference to parent ViewBotClientService
   * CRITICAL FIX: Needed to check rotation enabled status
   */
  getParentService() {
    return this.parentService;
  }

  /**
   * Requests rotation to another ViewBot (used when time allotment expires)
   * CRITICAL FIX: Only send rotation request if rotation is enabled
   */
  requestRotation() {
    this.stopAllotmentTimer();
    
    // CRITICAL FIX: Check if rotation is enabled before requesting rotation
    const parentService = this.getParentService();
    if (!parentService || !parentService.rotationEnabled) {
      console.log(`🚫 ViewBot ${this.botId}: Rotation request ignored - rotation system disabled, continuing to stream`);
      return;
    }
    
    // CRITICAL FIX: Directly call the parent service's rotation handler
    // Socket events don't work for internal rotation - we need direct method calls
    console.log(`🔄 ViewBot ${this.botId}: Time expired, triggering rotation through parent service`);
    
    if (parentService && parentService.handleRotationRequest) {
      // Call the parent service's rotation handler directly
      parentService.handleRotationRequest(this.botId, 'time-expired');
    } else {
      console.error(`❌ ViewBot ${this.botId}: Cannot trigger rotation - parent service handler not available`);
      // Fallback: stop streaming
      this.stopStreaming();
    }
  }

  /**
   * Resets the time allotment with a new random value
   */
  resetTimeAllotment() {
    this.timeAllotment = this.generateRandomTimeAllotment();
    this.timeRemaining = this.timeAllotment;
    console.log(`🎲 ViewBot ${this.botId}: Time allotment reset to ${this.formatDuration(this.timeAllotment)}`);
  }
}

module.exports = ViewBotClientService;