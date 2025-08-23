const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const io = require('socket.io-client');
const puppeteer = require('puppeteer');
const ViewBotDatabaseService = require('./ViewBotDatabaseService');
const ViewBotGStreamerService = require('./ViewBotGStreamerService');
const processManager = require('./ProcessManager');
const stateManager = require('./ViewBotStateManager');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/**
 * ViewBotClientService - Creates actual bot clients that connect and stream like real users
 * This differs from ViewbotService by actually creating client connections that go through
 * the full WebRTC flow, making it appear as real streaming users to the system.
 */
class ViewBotClientService {
  constructor(serverUrl, mediasoupService, streamService, viewbotService = null) {
    // Use environment variable for server URL, fallback to provided serverUrl or localhost
    // ViewBots MUST connect via HTTPS since the Socket.IO server is on HTTPS
    const protocol = 'https';
    const port = process.env.HTTPS_PORT || 8443;
    const host = process.env.SERVER_HOST || 'onestreamer.live'; // Use SERVER_HOST from env
    
    const envServerUrl = process.env.VIEWBOT_SERVER_URL || `${protocol}://${host}:${port}`;
    this.serverUrl = serverUrl || envServerUrl;
    
    console.log(`🤖 VIEWBOT CLIENT: Service initialized with server URL: ${this.serverUrl}`);
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
    this.rotationEnabled = false; // DISABLED - Using SimpleViewBotMediaSoup instead
    this.currentLiveBot = null; // Currently streaming ViewBot
    this.rotationTimer = null; // Timer for automatic rotation
    this.realStreamerActive = false; // Protection flag for real streamers
    this.validationTimer = null; // Timer for real streamer status validation
    
    // Load rotation settings from config file or use defaults
    this.loadRotationConfig();
    
    // Default values (will be overridden by config if it exists)
    if (!this.rotationProbability) {
      this.rotationProbability = 0.31; // 31% chance per check - roughly every 3.5 minutes with 65s intervals
    }
    if (!this.rotationCheckIntervalMin) {
      this.rotationCheckIntervalMin = 5000; // 5 seconds minimum
    }
    if (!this.rotationCheckIntervalMax) {
      this.rotationCheckIntervalMax = 10000; // 10 seconds maximum
    }
    this.realStreamerTakeoverDelay = 7500; // 7.5 seconds average delay
    this.pendingTakeoverTimer = null; // Timer for delayed ViewBot takeover
    
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
    
    // Cooldown system for variety in rotation
    this.botCooldowns = new Map(); // Map of botId -> { count: number, lastPlayed: Date }
    this.cooldownWindowMs = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    this.cooldownMultiplier = 0.5; // Reduce probability by 50% for each play
    this.minProbability = 0.1; // Minimum 10% of original probability
    
    // Start cooldown cleanup timer
    this.startCooldownCleanup();
    
    // Rotation queue management for preventing race conditions
    this.rotationQueue = [];
    this.rotationLock = false;
    this.rotationProcessTimer = null;
    this.rotationQueueWindow = 500; // Process queue every 500ms
    
    // Flag to prevent viewbots from starting during initialization
    this.initializationInProgress = true;
    
    // Initialize database and restore state
    this.initialize();
    
    console.log('🤖 VIEWBOT CLIENT: Service initialized with cooldown system and rotation queue');
  }

  /**
   * Load rotation configuration from file
   */
  loadRotationConfig() {
    try {
      const configPath = path.join(__dirname, '../../viewbot-rotation-config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        this.rotationProbability = config.rotationProbability || 0.31;
        this.rotationCheckIntervalMin = config.rotationCheckIntervalMin || 5000;
        this.rotationCheckIntervalMax = config.rotationCheckIntervalMax || 10000;
        console.log(`📄 Loaded rotation config: ${(this.rotationProbability * 100).toFixed(1)}% probability, ${this.rotationCheckIntervalMin/1000}-${this.rotationCheckIntervalMax/1000}s intervals`);
      }
    } catch (error) {
      console.log('⚠️ Could not load rotation config, using defaults:', error.message);
    }
  }
  
  /**
   * Save rotation configuration to file
   */
  saveRotationConfig() {
    try {
      const configPath = path.join(__dirname, '../../viewbot-rotation-config.json');
      const config = {
        rotationProbability: this.rotationProbability,
        rotationCheckIntervalMin: this.rotationCheckIntervalMin,
        rotationCheckIntervalMax: this.rotationCheckIntervalMax,
        comment: `Rotation settings: ${(this.rotationProbability * 100).toFixed(1)}% probability, ${this.rotationCheckIntervalMin/1000}-${this.rotationCheckIntervalMax/1000} second intervals`
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`💾 Saved rotation config to file`);
    } catch (error) {
      console.error('❌ Could not save rotation config:', error.message);
    }
  }

  /**
   * Get current rotation settings
   */
  getRotationSettings() {
    return {
      rotationProbability: this.rotationProbability,
      rotationCheckIntervalMin: this.rotationCheckIntervalMin,
      rotationCheckIntervalMax: this.rotationCheckIntervalMax
    };
  }

  /**
   * Update rotation settings
   */
  updateRotationSettings(settings) {
    if (settings.rotationProbability !== undefined) {
      this.rotationProbability = settings.rotationProbability;
    }
    if (settings.rotationCheckIntervalMin !== undefined) {
      this.rotationCheckIntervalMin = settings.rotationCheckIntervalMin;
    }
    if (settings.rotationCheckIntervalMax !== undefined) {
      this.rotationCheckIntervalMax = settings.rotationCheckIntervalMax;
    }
    
    console.log(`🔄 Updated rotation settings: ${(this.rotationProbability * 100).toFixed(1)}% probability, ${this.rotationCheckIntervalMin/1000}-${this.rotationCheckIntervalMax/1000}s intervals`);
    
    // Save to config file
    this.saveRotationConfig();
    
    // Restart rotation timers with new intervals if any bots are active
    const activeBots = Array.from(this.viewBots.values()).filter(bot => bot.isStreaming);
    if (activeBots.length > 0) {
      console.log('🔄 Restarting rotation timers with new settings...');
      activeBots.forEach(bot => {
        if (bot.rotationCheckTimer) {
          clearTimeout(bot.rotationCheckTimer);
          this.startRotationCheckTimer(bot.botId);
        }
      });
    }
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
      
      // Check presence after a short delay to ensure all bots are initialized
      // CRITICAL: Only check presence if rotation wasn't already restarted
      setTimeout(() => {
        console.log('🔍 VIEWBOT CLIENT: Initial presence check...');
        // Clear initialization flag
        this.initializationInProgress = false;
        // Only maintain presence if no bot is currently live
        if (!this.currentLiveBot) {
          this.maintainViewBotPresence();
        } else {
          console.log(`ℹ️ VIEWBOT CLIENT: Skipping presence check - ${this.currentLiveBot} is already live`);
        }
      }, 10000); // 10 second delay for bots to initialize
      
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
    if (!this.dbInitialized) {
      console.log('⚠️ VIEWBOT CLIENT: Database not initialized, skipping system state restore');
      return;
    }
    
    try {
      console.log('📊 VIEWBOT CLIENT: Loading system state from database...');
      const state = await this.dbService.loadSystemState();
      console.log('📊 VIEWBOT CLIENT: Loaded state:', state);
      
      this.rotationEnabled = state.rotationEnabled;
      this.currentLiveBot = state.currentLiveBot;
      this.realStreamerActive = state.realStreamerActive;
      this.maxBots = state.maxBots === -1 ? Infinity : state.maxBots;
      
      // Load probability settings if saved
      if (state.rotationProbability !== undefined) {
        this.rotationProbability = state.rotationProbability;
      }
      if (state.rotationCheckIntervalMin !== undefined) {
        this.rotationCheckIntervalMin = state.rotationCheckIntervalMin;
      }
      if (state.rotationCheckIntervalMax !== undefined) {
        this.rotationCheckIntervalMax = state.rotationCheckIntervalMax;
      }
      
      console.log(`🔄 VIEWBOT CLIENT: Restored system state - rotation: ${this.rotationEnabled}, live bot: ${this.currentLiveBot}`);
      
      // CRITICAL FIX: Don't restart rotation here - let restoreViewBots handle it
      // This prevents race conditions during startup
      
      // Start periodic error cleanup
      setInterval(() => {
        this.cleanupStaleErrors();
      }, 60000); // Clean up every 60 seconds
      
    } catch (error) {
      console.error('❌ VIEWBOT CLIENT: Failed to restore system state:', error);
    }
  }
  
  /**
   * Cleans up stale errors from ViewBots
   */
  cleanupStaleErrors() {
    for (const [botId, bot] of this.activeBots.entries()) {
      // Clear non-critical errors if the bot is connected and not streaming
      if (bot.isConnected && !bot.streaming && bot.lastError) {
        // List of errors that can be safely cleared after some time
        const clearableErrors = [
          'GStreamer',
          'FFmpeg',
          'pipelines failed',
          'global_cooldown',
          'individual_cooldown',
          'takeover_denied'
        ];
        
        if (clearableErrors.some(err => bot.lastError.includes(err))) {
          console.log(`🧹 Clearing stale error for ViewBot ${botId}: ${bot.lastError}`);
          bot.lastError = null;
        }
      }
    }
  }

  /**
   * Restore ViewBot configurations from database
   */
  async restoreViewBots() {
    if (!this.dbInitialized) return;
    
    try {
      const storedBots = await this.dbService.loadAllViewBots();
      
      // CRITICAL PERFORMANCE FIX: Don't create ViewBotInstance objects at startup
      // Store only the configuration data
      console.log(`📊 VIEWBOT CLIENT: Loading ${storedBots.length} ViewBot configurations from database...`);
      
      // Create a map to store bot configurations without creating instances
      this.botConfigurations = new Map();
      
      for (const botData of storedBots) {
        // Store the configuration data
        this.botConfigurations.set(botData.botId, botData);
        
        // Create a minimal placeholder in activeBots for API visibility
        // This is NOT a real ViewBotInstance, just a data object
        const placeholder = {
          botId: botData.botId,
          name: botData.name,
          config: botData.config,
          isConnected: false,
          streaming: false,
          lazyLoad: true,
          isPlaceholder: true, // Flag to identify this is not a real instance
          contentType: botData.contentType,
          timeAllotment: botData.timeAllotment
        };
        
        this.activeBots.set(botData.botId, placeholder);
      }
      
      console.log(`✅ VIEWBOT CLIENT: Restored ${this.activeBots.size} ViewBots from database`);
      
      // CRITICAL: Start rotation AFTER all bots are restored
      // This prevents race conditions where multiple bots try to stream
      if (this.rotationEnabled && !this.realStreamerActive) {
        console.log(`🔄 VIEWBOT CLIENT: Starting rotation system after ViewBot restoration`);
        // Give bots time to fully initialize their connections
        setTimeout(() => {
          // Clear initialization flag before starting rotation
          this.initializationInProgress = false;
          this.restartRotationAfterRestore();
        }, 3000);
      }
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
        maxBots: this.maxBots === Infinity ? -1 : this.maxBots,
        rotationProbability: this.rotationProbability,
        rotationCheckIntervalMin: this.rotationCheckIntervalMin,
        rotationCheckIntervalMax: this.rotationCheckIntervalMax
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
    // Allow multiple viewbots to coexist - no longer enforce singleton pattern
    // This enables proper persistence and multiple viewbot management
    console.log(`📊 VIEWBOT CLIENT: Current active bots: ${this.activeBots.size}`);
    
    // Optional: Add a reasonable limit to prevent resource exhaustion
    const MAX_BOTS = 100; // Configurable limit
    if (this.activeBots.size >= MAX_BOTS) {
      console.error(`❌ VIEWBOT CLIENT: Maximum number of bots (${MAX_BOTS}) reached`);
      return {
        success: false,
        message: `Maximum number of ViewBots (${MAX_BOTS}) reached. Please remove some bots before creating new ones.`
      };
    }

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
      
      // CRITICAL: Always use correct server URL when creating new bots
      const protocol = 'https';
      const port = process.env.HTTPS_PORT || 8443;
      const host = process.env.SERVER_HOST || 'onestreamer.live';
      const correctServerUrl = process.env.VIEWBOT_SERVER_URL || `${protocol}://${host}:${port}`;
      
      const bot = new ViewBotInstance(botId, botConfig, correctServerUrl, this.mediasoupService, this);
      
      // Set bot name if provided
      const botName = config.name || `ViewBot ${botId.split('-').pop()}`;
      bot.name = botName;
      
      await bot.initialize();
      
      this.activeBots.set(botId, bot);
      
      // Save to database for persistence
      if (this.dbInitialized) {
        try {
          await this.dbService.saveViewBot({
            botId,
            name: botName,
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
   * Ensure a bot is connected (lazy loading support)
   */
  async ensureBotConnected(botId) {
    let bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: `Bot ${botId} not found` };
    }
    
    // If it's a placeholder, create the real ViewBotInstance
    if (bot.isPlaceholder) {
      console.log(`🔄 VIEWBOT CLIENT: Creating real instance for placeholder ${botId}...`);
      
      const botConfig = this.botConfigurations.get(botId);
      if (!botConfig) {
        return { success: false, message: `Configuration for ${botId} not found` };
      }
      
      // CRITICAL FIX: Use ProcessManager to ensure clean state before creating new instance
      await processManager.killBotProcesses(botId);
      
      // Create the real ViewBotInstance
      const protocol = 'https';
      const port = process.env.HTTPS_PORT || 8443;
      const host = process.env.SERVER_HOST || 'onestreamer.live';
      const correctServerUrl = process.env.VIEWBOT_SERVER_URL || `${protocol}://${host}:${port}`;
      
      const realBot = new ViewBotInstance(
        botConfig.botId,
        botConfig.config,
        correctServerUrl,
        this.mediasoupService,
        this
      );
      
      // Copy properties from config
      if (botConfig.name) realBot.name = botConfig.name;
      if (botConfig.timeAllotment) {
        realBot.timeAllotment = botConfig.timeAllotment;
        realBot.timeRemaining = botConfig.timeAllotment;
      }
      
      // Replace placeholder with real instance
      this.activeBots.set(botId, realBot);
      bot = realBot;
      
      console.log(`✅ VIEWBOT CLIENT: Created real instance for ${botId}`);
    }
    
    // If already connected, return success
    if (bot.isConnected) {
      return { success: true };
    }
    
    // Initialize connection
    console.log(`🔌 VIEWBOT CLIENT: Connecting ${botId}...`);
    try {
      await bot.initialize();
      console.log(`✅ VIEWBOT CLIENT: Connected ViewBot ${botId}`);
      return { success: true };
    } catch (error) {
      console.error(`❌ VIEWBOT CLIENT: Failed to connect ${botId}:`, error.message);
      return { success: false, message: error.message };
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
    
    // Ensure bot is connected before starting
    const connectResult = await this.ensureBotConnected(botId);
    if (!connectResult.success) {
      return connectResult;
    }
    
    // CRITICAL: Get bot again after ensuring connection
    // The bot might have been replaced with a real instance during connection
    const connectedBot = this.activeBots.get(botId);
    if (!connectedBot) {
      console.log(`❌ ViewBot ${botId} disappeared after connection`);
      return { success: false, message: `Bot ${botId} not found after connection` };
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
        // Check if it's a real bot with methods, not a placeholder
        if (currentBot && currentBot.streaming && typeof currentBot.stopStreaming === 'function') {
          console.log(`🔄 Stopping current live bot ${this.currentLiveBot} for manual start of ${botId}`);
          await currentBot.stopStreaming();
        } else if (currentBot && currentBot.streaming) {
          console.log(`⚠️ Current bot ${this.currentLiveBot} is a placeholder, marking as not streaming`);
          // Just clear the streaming flag if it's a placeholder
          this.currentLiveBot = null;
        }
      }

      const result = await connectedBot.startStreaming();
      
      if (result.success) {
        // Update rotation system tracking
        if (this.rotationEnabled) {
          this.currentLiveBot = botId;
        this.currentLiveBotSetTime = Date.now();
          // Start rotation check timer for this bot
          connectedBot.startRotationCheckTimer();
          console.log(`🎯 Manual start: Updated current live bot to ${botId} with probability-based rotation`);
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
            const nextBot = this.selectViewBotWithCooldown(availableBots);
            console.log(`🔄 Auto-starting next ViewBot: ${nextBot.botId}`);
            
            // Start the next bot with a short delay
            setTimeout(async () => {
              try {
                await nextBot.startStreaming();
                // Apply cooldown to the bot that just started
                this.applyBotCooldown(nextBot.botId);
                // Start rotation check timer for the next bot
                nextBot.startRotationCheckTimer();
                console.log(`✅ Auto-rotation completed: ${botId} → ${nextBot.botId} (probability-based rotation)`)
                this.currentLiveBot = nextBot.botId;
      this.currentLiveBotSetTime = Date.now();
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
  /**
   * Find botId by socketId
   */
  getBotIdBySocketId(socketId) {
    for (const [botId, bot] of this.activeBots.entries()) {
      if (bot.socket && bot.socket.id === socketId) {
        return botId;
      }
    }
    return null;
  }

  async destroyBot(botId, deleteFromDatabase = true) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: `Bot ${botId} not found` };
    }

    try {
      // Only call destroy if it's a real ViewBotInstance, not a placeholder
      if (bot.destroy && typeof bot.destroy === 'function') {
        await bot.destroy();
      } else if (bot.isPlaceholder) {
        console.log(`🗑️ VIEWBOT CLIENT: Removing placeholder ${botId}`);
      }
      this.activeBots.delete(botId);
      
      // Only remove from database if explicitly requested
      // This preserves viewbot configurations across disconnections
      if (this.dbInitialized && deleteFromDatabase) {
        try {
          await this.dbService.deleteViewBot(botId);
          console.log(`💾 VIEWBOT CLIENT: Removed ViewBot ${botId} from database`);
        } catch (dbError) {
          console.error(`⚠️ VIEWBOT CLIENT: Failed to remove ViewBot ${botId} from database:`, dbError);
        }
      } else if (!deleteFromDatabase) {
        console.log(`📊 VIEWBOT CLIENT: Bot ${botId} disconnected but preserved in database`);
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
      
      // Handle placeholders which don't have getStatus method
      if (bot.isPlaceholder) {
        botsStatus.push({
          botId,
          name: botName || `ViewBot ${botId.split('-').pop()}`,
          isConnected: false,
          streaming: false,
          lastError: null,
          contentType: bot.contentType || bot.config?.contentType || 'unknown',
          connectionType: bot.config?.connectionType || 'unknown'
        });
      } else {
        botsStatus.push({
          botId,
          name: botName || `ViewBot ${botId.split('-').pop()}`,
          ...bot.getStatus()
        });
      }
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
      // Don't delete from database when destroying all bots
      // This is typically used for cleanup/restart, not permanent deletion
      const result = await this.destroyBot(botId, false);
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
      
      // Destroy all bots (this will close individual Puppeteer instances)
      console.log('   Destroying all ViewBot clients...');
      await this.destroyAllBots();
      
      // Kill any orphaned Puppeteer processes
      await this.killOrphanedPuppeteerProcesses();
      
      console.log('✅ ViewBotClientService: Cleanup complete');
    } catch (error) {
      console.error('❌ ViewBotClientService: Error during cleanup:', error);
    }
  }

  /**
   * Kill any orphaned Puppeteer browser processes
   */
  async killOrphanedPuppeteerProcesses() {
    console.log('🧹 ViewBotClientService: Checking for orphaned Puppeteer processes...');
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execPromise = promisify(exec);
    
    try {
      if (process.platform === 'win32') {
        // Windows: Kill Chrome processes launched by Puppeteer
        await execPromise('taskkill /F /IM chrome.exe /FI "COMMANDLINE like *puppeteer*" 2>nul').catch(() => {});
        await execPromise('taskkill /F /IM chromium.exe /FI "COMMANDLINE like *puppeteer*" 2>nul').catch(() => {});
      } else {
        // Unix-like systems: Kill Chrome/Chromium processes with Puppeteer flags
        await execPromise('pkill -f "puppeteer.*chrome" 2>/dev/null').catch(() => {});
        await execPromise('pkill -f "chrome.*--no-sandbox.*--disable-setuid-sandbox" 2>/dev/null').catch(() => {});
      }
      console.log('✅ ViewBotClientService: Orphaned Puppeteer processes cleaned up');
    } catch (error) {
      console.warn('⚠️ ViewBotClientService: Could not clean up Puppeteer processes:', error.message);
    }
  }

  /**
   * Health check for the service
   */
  getHealthStatus() {
    const activeBots = Array.from(this.activeBots.values());
    // Filter out placeholders which don't have these methods
    const realBots = activeBots.filter(bot => !bot.isPlaceholder);
    const streamingBots = realBots.filter(bot => bot.isStreaming && bot.isStreaming());
    const healthyBots = realBots.filter(bot => bot.isHealthy && bot.isHealthy());
    
    // Get next rotation info
    let nextRotationTime = null;
    let timeToNextRotation = null;
    let timeToNextRotationFormatted = null;
    let currentLiveBotName = null;
    
    if (this.rotationEnabled && this.currentLiveBot) {
      const currentBot = this.activeBots.get(this.currentLiveBot);
      if (currentBot) {
        // Get the bot's name
        currentLiveBotName = currentBot.name || `ViewBot ${this.currentLiveBot.split('-').pop()}`;
        
        if (currentBot.isStreaming && currentBot.isStreaming() && currentBot.timeRemaining > 0) {
          nextRotationTime = Date.now() + currentBot.timeRemaining;
          timeToNextRotation = currentBot.timeRemaining;
          timeToNextRotationFormatted = currentBot.formatDuration ? currentBot.formatDuration(Math.max(0, timeToNextRotation)) : null;
        }
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
      currentLiveBotName: currentLiveBotName,
      realStreamerActive: this.realStreamerActive,
      nextRotationTime: nextRotationTime,
      timeToNextRotation: timeToNextRotation,
      timeToNextRotationFormatted: timeToNextRotationFormatted,
      // Total bots available for rotation (all bots, not just connected/idle)
      availableBotsTotal: this.activeBots.size
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
      
      // Stop all rotation check timers when rotation is disabled
      for (const [botId, bot] of this.activeBots.entries()) {
        if (bot.streaming && bot.stopRotationCheckTimer) {
          bot.stopRotationCheckTimer();
          console.log(`⏸️ Stopped rotation checks for ViewBot ${botId} - rotation disabled`);
        }
      }
    } else {
      // Start rotation system
      await this.startViewBotRotation();
      
      // Also ensure presence is maintained
      setTimeout(() => this.maintainViewBotPresence(), 1000);
      
      // CRITICAL: Don't start rotation timers on all bots
      // The rotation timer will be started on the ONE streaming bot when it starts
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
    
    // CRITICAL: Only start ONE bot for rotation
    // Don't connect multiple bots at once
    
    // Check if there's a current live bot that needs to continue
    if (this.currentLiveBot) {
      console.log(`🔄 VIEWBOT CLIENT: Found previous bot: ${this.currentLiveBot}`);
      
      // Get the bot (might be a placeholder)
      let bot = this.activeBots.get(this.currentLiveBot);
      if (!bot) {
        console.log(`🔄 VIEWBOT CLIENT: Previous bot not found, starting fresh`);
        this.currentLiveBot = null;
        await this.startViewBotRotation();
        return;
      }
      
      // Ensure it's connected (converts placeholder to real instance)
      const connectResult = await this.ensureBotConnected(this.currentLiveBot);
      if (!connectResult.success) {
        console.error(`❌ Failed to connect previous bot ${this.currentLiveBot}`);
        this.currentLiveBot = null;
        await this.startViewBotRotation();
        return;
      }
      
      // Get the real bot instance after connection
      bot = this.activeBots.get(this.currentLiveBot);
      
      // CRITICAL: After server restart, we need to handle the case where
      // GStreamer processes are already running from before the restart
      
      // Check if GStreamer processes are already running
      const { execSync } = require('child_process');
      let gstreamerRunning = false;
      try {
        const psOutput = execSync('ps aux | grep -E "gst-launch.*filesrc" | grep -v grep', { encoding: 'utf8' });
        gstreamerRunning = psOutput.trim().length > 0;
        if (gstreamerRunning) {
          console.log(`🎬 VIEWBOT CLIENT: Detected existing GStreamer processes running`);
        }
      } catch (e) {
        // No processes found
        gstreamerRunning = false;
      }
      
      if (gstreamerRunning) {
        // GStreamer is already running - just set up the bot state properly
        console.log(`✅ VIEWBOT CLIENT: Media already streaming - setting up rotation system`);
        
        // Mark bot as streaming
        bot.streaming = true;
        bot.isStartingStream = false;
        
        // Start rotation check timer
        bot.startRotationCheckTimer();
        
        // Set up failsafe timer if video file is configured
        if (bot.config && bot.config.videoFile) {
          await bot.setupDurationBasedRotation(bot.config.videoFile);
        }
        
        console.log(`✅ VIEWBOT CLIENT: Rotation system restored for ${this.currentLiveBot}`);
      } else {
        // No media running - start streaming normally
        try {
          console.log(`🎬 VIEWBOT CLIENT: Starting fresh stream for ${this.currentLiveBot}`);
          const result = await bot.startStreaming();
          
          if (result.success) {
            // Start rotation check timer after successful start
            bot.startRotationCheckTimer();
            console.log(`✅ VIEWBOT CLIENT: Stream started with rotation timer`);
          } else if (!result.success && result.message === 'Already streaming') {
            // Bot thinks it's streaming but GStreamer isn't running - fix the state
            console.log(`🔧 VIEWBOT CLIENT: Fixing inconsistent state - bot thinks it's streaming but it's not`);
            bot.streaming = false;
            bot.isStartingStream = false;
            
            // Try starting again
            const retryResult = await bot.startStreaming();
            if (retryResult.success) {
              bot.startRotationCheckTimer();
              console.log(`✅ VIEWBOT CLIENT: Stream started after state fix`);
            }
          }
        } catch (error) {
          console.error(`❌ VIEWBOT CLIENT: Failed to restart ${this.currentLiveBot}:`, error);
          this.currentLiveBot = null;
          await this.startViewBotRotation();
        }
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
    // CRITICAL: Don't start rotation during initialization
    if (this.initializationInProgress) {
      console.log(`⏳ ViewBot rotation deferred - initialization in progress`);
      return;
    }
    
    // CRITICAL: Prevent concurrent rotation starts
    if (this.currentLiveBot) {
      console.log(`⚠️ ViewBot rotation already active with ${this.currentLiveBot} - skipping`);
      return;
    }
    
    if (this.realStreamerActive) {
      console.log(`🛑 Cannot start ViewBot rotation - real streamer is active`);
      return;
    }

    // Find available ViewBots (including placeholders)
    const availableBots = Array.from(this.activeBots.values()).filter(bot => 
      !bot.streaming && (bot.isConnected || bot.lazyLoad || bot.isPlaceholder)
    );

    if (availableBots.length === 0) {
      console.log(`⚠️ No available ViewBots for rotation`);
      return;
    }

    // No need to reset anything for probability-based rotation

    // Select a ViewBot with weighted probability based on cooldowns
    let firstBot = this.selectViewBotWithCooldown(availableBots);
    
    // Ensure bot is connected (handle placeholders and lazy loading)
    if (!firstBot.isConnected || firstBot.isPlaceholder) {
      console.log(`🔌 Connecting bot ${firstBot.botId} for rotation start...`);
      const connectResult = await this.ensureBotConnected(firstBot.botId);
      if (!connectResult.success) {
        console.error(`❌ Failed to connect bot ${firstBot.botId} for rotation start`);
        return;
      }
      // Get the real bot instance after connection
      firstBot = this.activeBots.get(firstBot.botId);
    }
    
    // Set currentLiveBot BEFORE starting to prevent concurrent starts
    this.currentLiveBot = firstBot.botId;
    this.currentLiveBotSetTime = Date.now(); // Track when it was set
    
    try {
      await firstBot.startStreaming();
      // Apply cooldown to the bot that just started
      this.applyBotCooldown(firstBot.botId);
      // Start rotation check timer for the bot
      firstBot.startRotationCheckTimer();
      console.log(`🔄 ViewBot rotation started with: ${firstBot.botId}`);
    } catch (error) {
      console.error(`❌ Failed to start initial ViewBot rotation:`, error);
      // Clear currentLiveBot on failure
      this.currentLiveBot = null;
    }
  }

  /**
   * Sets the real streamer status (protects from ViewBot takeover)
   */
  setRealStreamerStatus(isActive) {
    const previousStatus = this.realStreamerActive;
    this.realStreamerActive = isActive;
    console.log(`👤 Real streamer status: ${isActive ? 'ACTIVE' : 'INACTIVE'} (was: ${previousStatus ? 'ACTIVE' : 'INACTIVE'})`);
    
    if (isActive) {
      // Clear any pending takeover timer
      if (this.pendingTakeoverTimer) {
        clearTimeout(this.pendingTakeoverTimer);
        this.pendingTakeoverTimer = null;
        console.log(`🚫 Cancelled pending ViewBot takeover - real streamer is active`);
      }
      
      if (this.currentLiveBot) {
        // Stop current ViewBot if a real streamer becomes active
        console.log(`🛑 Real streamer active - stopping ViewBot ${this.currentLiveBot}`);
        this.stopViewBotRotation();
      }
    } else {
      // Real streamer disconnected - schedule ViewBot takeover after delay
      console.log(`🔍 Checking takeover conditions: rotationEnabled=${this.rotationEnabled}, currentLiveBot=${this.currentLiveBot}`);
      
      // Only proceed if status actually changed from true to false
      if (previousStatus === true && isActive === false) {
        console.log(`📉 Real streamer status changed from ACTIVE to INACTIVE`);
        
        if (this.rotationEnabled) {
          if (!this.currentLiveBot) {
            console.log(`✅ No ViewBot currently live - scheduling takeover`);
            this.scheduleViewBotTakeover();
          } else {
            console.log(`ℹ️ ViewBot ${this.currentLiveBot} is already live - no takeover needed`);
          }
        } else {
          console.log(`❌ Rotation is disabled - no ViewBot takeover`);
        }
      } else if (previousStatus === false && isActive === false) {
        console.log(`ℹ️ Real streamer was already inactive - no action needed`);
        // But still check if we need to maintain presence
        setTimeout(() => this.maintainViewBotPresence(), 2000);
      }
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
      
      // CRITICAL: Also check if we need to maintain ViewBot presence
      this.maintainViewBotPresence();
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
   * Ensures a ViewBot is always streaming when rotation is enabled and no real streamer is active
   * This provides proactive presence maintenance rather than just reactive
   */
  async maintainViewBotPresence() {
    // Skip if rotation is disabled
    if (!this.rotationEnabled) {
      return;
    }
    
    // Skip if real streamer is active
    if (this.realStreamerActive) {
      return;
    }
    
    // CRITICAL: Skip if we're already starting an emergency bot
    if (this.isStartingEmergencyBot) {
      console.log('⏳ PRESENCE: Already starting emergency bot, skipping duplicate attempt');
      return;
    }
    
    // Check if any ViewBot is currently live
    if (this.currentLiveBot) {
      // Verify the bot is actually streaming
      const bot = this.activeBots.get(this.currentLiveBot);
      
      // Debug logging to understand the state
      if (!bot) {
        console.log(`🔍 PRESENCE CHECK: currentLiveBot=${this.currentLiveBot} - bot not found in activeBots`);
        console.log(`🔧 PRESENCE: Clearing non-existent currentLiveBot: ${this.currentLiveBot}`);
        this.currentLiveBot = null;
      } else {
        const isStreaming = typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming;
        const isStarting = bot.isStartingStream;
        console.log(`🔍 PRESENCE CHECK: currentLiveBot=${this.currentLiveBot}, streaming=${isStreaming}, isStartingStream=${isStarting}`);
        
        if (isStreaming || isStarting) {
          // All good - ViewBot is live or starting
          console.log(`✅ PRESENCE: Bot ${this.currentLiveBot} is ${isStreaming ? 'streaming' : 'starting'} - no action needed`);
          return;
        } else {
          // Bot exists but not streaming and not starting - check if it was recently selected
          // Give the bot 30 seconds to start streaming before clearing (increased from 10s)
          const now = Date.now();
          if (!this.currentLiveBotSetTime) {
            this.currentLiveBotSetTime = now;
          }
          
          const timeSinceSet = now - this.currentLiveBotSetTime;
          const gracePeriod = 30000; // Increased to 30 seconds
          
          if (timeSinceSet > gracePeriod) {
            console.log(`🔧 PRESENCE: Clearing non-streaming currentLiveBot after ${gracePeriod/1000}s timeout: ${this.currentLiveBot}`);
            this.currentLiveBot = null;
            this.currentLiveBotSetTime = null;
          } else {
            console.log(`⏳ PRESENCE: Bot ${this.currentLiveBot} not streaming yet, waiting ${(gracePeriod - timeSinceSet)/1000}s more`);
            return;
          }
        }
      }
    }
    
    // CRITICAL: Check if rotation is already being processed
    if (this.rotationLock) {
      console.log(`🔒 PRESENCE: Rotation is already being processed - skipping presence maintenance`);
      return;
    }
    
    // Also check if there's a pending rotation in the queue
    if (this.rotationQueue.length > 0) {
      console.log(`📋 PRESENCE: Rotation queue has ${this.rotationQueue.length} pending requests - skipping presence maintenance`);
      return;
    }
    
    // At this point: rotation enabled, no real streamer, no ViewBot streaming
    console.log('⚠️ PRESENCE: No one is streaming but rotation is enabled - need emergency start');
    
    // Check if we have available bots (including lazy-loaded ones)
    const availableBots = Array.from(this.activeBots.values()).filter(bot => {
      const isStreaming = typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming;
      return !isStreaming && (bot.isConnected || bot.lazyLoad);
    });
    
    if (availableBots.length === 0) {
      console.log('❌ PRESENCE: No available ViewBots to start');
      return;
    }
    
    // CRITICAL FIX: Don't bypass rotation system with startViewBotRotation()
    // Instead, pick a random bot and start it directly, then let rotation timers handle switching
    console.log('🚀 PRESENCE: Emergency start - picking a random bot to maintain presence');
    
    // CRITICAL: Only pick one bot and set it as current immediately to prevent duplicates
    const randomBot = availableBots[Math.floor(Math.random() * availableBots.length)];
    
    // Set as current IMMEDIATELY to prevent other presence checks from starting another bot
    this.currentLiveBot = randomBot.botId;
    this.currentLiveBotSetTime = Date.now();
    console.log(`🔒 PRESENCE: Pre-emptively set currentLiveBot to ${randomBot.botId} to prevent duplicates`);
    
    // Set flag to prevent duplicate starts
    this.isStartingEmergencyBot = true;
    
    try {
      // Start the bot streaming using the service method (which handles all the setup)
      console.log(`🎯 PRESENCE: Starting bot ${randomBot.botId} for emergency presence`);
      const result = await this.startBotStreaming(randomBot.botId);
      
      if (result && result.success) {
        console.log(`✅ PRESENCE: Emergency bot ${randomBot.botId} started successfully`);
      } else {
        console.log(`❌ PRESENCE: Failed to start emergency bot ${randomBot.botId}:`, result?.message);
      }
    } finally {
      // Clear the flag after attempt
      this.isStartingEmergencyBot = false;
    }
    
    // The startBotStreaming method already starts the rotation timer when rotation is enabled
    // No need to manually start it here
  }

  /**
   * Queues a rotation request to prevent race conditions
   * This is the new entry point for all rotation requests
   */
  queueRotationRequest(botId, reason) {
    // Check if rotation is enabled first
    if (!this.rotationEnabled) {
      console.log(`🔄 Rotation request from ${botId} ignored - rotation disabled`);
      return { success: false, message: 'Rotation is disabled' };
    }
    
    if (this.realStreamerActive) {
      console.log(`🔄 Rotation request from ${botId} ignored - real streamer active`);
      return { success: false, message: 'Real streamer is active' };
    }
    
    // Check if this bot already has a pending request
    const existingRequest = this.rotationQueue.find(req => req.botId === botId);
    if (existingRequest) {
      console.log(`⏳ ViewBot ${botId}: Rotation request already queued`);
      return { success: false, message: 'Request already queued' };
    }
    
    // Add to queue with timestamp
    const request = {
      botId,
      reason,
      timestamp: Date.now()
    };
    
    this.rotationQueue.push(request);
    console.log(`📥 Queued rotation request from ${botId} (${reason}). Queue size: ${this.rotationQueue.length}`);
    
    // Start processing timer if not already running
    if (!this.rotationProcessTimer) {
      this.rotationProcessTimer = setTimeout(() => {
        this.processRotationQueue();
      }, this.rotationQueueWindow);
    }
    
    return { success: true, message: 'Rotation request queued' };
  }
  
  /**
   * Processes the rotation queue, ensuring only one rotation happens
   */
  async processRotationQueue() {
    // Clear the timer
    this.rotationProcessTimer = null;
    
    // Check if already processing a rotation
    if (this.rotationLock) {
      console.log(`🔒 Rotation processor locked - deferring queue processing`);
      // Reschedule processing
      this.rotationProcessTimer = setTimeout(() => {
        this.processRotationQueue();
      }, this.rotationQueueWindow);
      return;
    }
    
    // Get all pending requests
    const requests = [...this.rotationQueue];
    this.rotationQueue = []; // Clear the queue
    
    if (requests.length === 0) {
      console.log(`📭 Rotation queue empty - nothing to process`);
      return;
    }
    
    console.log(`🔄 Processing ${requests.length} rotation requests`);
    
    // Filter out requests from bots that are no longer streaming
    const validRequests = requests.filter(req => {
      const bot = this.activeBots.get(req.botId);
      return bot && bot.streaming;
    });
    
    if (validRequests.length === 0) {
      console.log(`❌ No valid rotation requests after filtering`);
      return;
    }
    
    // Select ONE request to process (could use various strategies)
    // Strategy: Use the first valid request (FIFO)
    const selectedRequest = validRequests[0];
    
    console.log(`✅ Selected rotation request from ${selectedRequest.botId} (${selectedRequest.reason})`);
    console.log(`⏭️ Discarding ${validRequests.length - 1} other requests`);
    
    // Acquire lock and process the selected rotation
    this.rotationLock = true;
    
    try {
      await this.handleRotationRequest(selectedRequest.botId, selectedRequest.reason);
    } catch (error) {
      console.error(`❌ Rotation processing failed:`, error);
    } finally {
      // Release lock
      this.rotationLock = false;
      console.log(`🔓 Rotation lock released`);
      
      // Check if more requests came in while processing
      if (this.rotationQueue.length > 0 && !this.rotationProcessTimer) {
        console.log(`📬 New requests in queue - scheduling next processing`);
        this.rotationProcessTimer = setTimeout(() => {
          this.processRotationQueue();
        }, this.rotationQueueWindow);
      }
    }
  }
  
  /**
   * Handle rotation request from ViewbotService when video ends
   * This is called by ViewbotService.handleVideoEnd
   */
  handleRotation(botId) {
    console.log(`🎬 ViewBotClientService: Handling rotation for bot ${botId} after video end`);
    
    // Queue the rotation request to go through the normal rotation process
    this.queueRotationRequest(botId, 'video-end');
  }

  /**
   * Handles ViewBot rotation requests (now called only from processRotationQueue)
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
    
    // Clean up any orphaned GStreamer processes before rotation
    try {
      const { execSync } = require('child_process');
      const orphanedCount = execSync('pgrep -f gst-launch | wc -l', { encoding: 'utf8' }).trim();
      if (parseInt(orphanedCount) > 1) {
        console.log(`🧹 Cleaning up ${orphanedCount} orphaned GStreamer processes before rotation`);
        execSync('pkill -9 -f gst-launch 2>/dev/null || true', { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore errors
    }
    
    // Find the next available ViewBot to rotate to
    // Include placeholders and lazy-loaded bots
    const availableBots = Array.from(this.activeBots.values()).filter(bot => 
      bot.botId !== botId && !bot.streaming && (bot.isConnected || bot.lazyLoad || bot.isPlaceholder)
    );

    if (availableBots.length === 0) {
      console.log(`🔄 No available ViewBots for rotation - stopping rotation`);
      this.currentLiveBot = null;
      return { success: false, message: 'No available ViewBots for rotation' };
    }

    // Select a ViewBot with weighted probability based on cooldowns
    let nextBot = this.selectViewBotWithCooldown(availableBots);
    
    // Ensure the selected bot is connected (handle placeholders and lazy loading)
    if (!nextBot.isConnected || nextBot.isPlaceholder) {
      console.log(`🔌 Connecting bot ${nextBot.botId} for rotation...`);
      const connectResult = await this.ensureBotConnected(nextBot.botId);
      if (!connectResult.success) {
        console.error(`❌ Failed to connect bot ${nextBot.botId} for rotation`);
        return { success: false, message: `Failed to connect next bot: ${connectResult.message}` };
      }
      // Get the real bot instance after connection
      nextBot = this.activeBots.get(nextBot.botId);
    }
    
    try {
      // Stop current bot
      const currentBot = this.activeBots.get(botId);
      console.log(`🔄🔄🔄 ROTATION: Stopping current bot ${botId}`, {
        found: !!currentBot,
        isPlaceholder: currentBot?.isPlaceholder,
        hasStopStreaming: !!(currentBot?.stopStreaming),
        hasCleanup: !!(currentBot?.cleanupGStreamerProcesses)
      });
      
      // CRITICAL: Even if it's a placeholder, we need to check for orphaned processes
      if (currentBot) {
        if (!currentBot.isPlaceholder && currentBot.stopStreaming) {
          console.log(`🛑🛑🛑 ROTATION: Calling stopStreaming() on real bot ${botId}...`);
          await currentBot.stopStreaming();
          console.log(`✅ ROTATION: stopStreaming() completed for ${botId}`);
        } else if (currentBot.cleanupGStreamerProcesses) {
          // If it has cleanup method but is a placeholder, still cleanup!
          console.log(`⚠️⚠️⚠️ ROTATION: Bot ${botId} is placeholder but has cleanup method - cleaning up orphaned processes`);
          currentBot.cleanupGStreamerProcesses();
        } else {
          console.log(`❌❌❌ ROTATION: Bot ${botId} is placeholder with no cleanup - ORPHANED PROCESSES LIKELY!`);
        }
        
        // CRITICAL: Disconnect the bot to free resources
        // This prevents accumulation of connected bots
        if (currentBot.socket) {
          console.log(`🔌 Disconnecting ViewBot ${botId} after rotation`);
          currentBot.socket.disconnect();
          currentBot.isConnected = false;
        }
      } else {
        console.log(`⚠️ ROTATION: Current bot ${botId} is placeholder or not found, skipping stop`);
      }

      // Add delay to ensure MediaSoup cleanup completes
      console.log(`⏳ ViewBot rotation: Waiting for cleanup before starting next bot...`);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start next bot with probability-based rotation
      await nextBot.startStreaming();
      // Apply cooldown to the bot that just started
      this.applyBotCooldown(nextBot.botId);
      nextBot.startRotationCheckTimer();
      
      this.currentLiveBot = nextBot.botId;
      this.currentLiveBotSetTime = Date.now();
      
      console.log(`🔄 ViewBot rotation completed: ${botId} → ${nextBot.botId}`);
      
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
      // CRITICAL: Clear the current live bot reference
      const wasLiveBot = this.currentLiveBot;
      this.currentLiveBot = null;
      console.log(`🛑 Stopped ViewBot rotation - cleared currentLiveBot: ${wasLiveBot}`);
    }

    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  /**
   * Manually trigger ViewBot takeover (admin function)
   */
  async manualTriggerTakeover() {
    console.log(`🎮 MANUAL: Triggering ViewBot takeover`);
    
    // Check conditions
    if (!this.rotationEnabled) {
      return { success: false, message: 'Rotation is disabled' };
    }
    
    if (this.realStreamerActive) {
      return { success: false, message: 'Real streamer is active' };
    }
    
    if (this.currentLiveBot) {
      return { success: false, message: `ViewBot ${this.currentLiveBot} is already live` };
    }
    
    // Start a ViewBot
    await this.startViewBotRotation();
    
    return { 
      success: true, 
      message: 'ViewBot takeover triggered',
      currentLiveBot: this.currentLiveBot 
    };
  }

  /**
   * Gets rotation system status
   */
  getRotationStatus() {
    // For probability-based system, we don't have a fixed "next rotation time"
    // Instead, show the probability and check interval
    
    return {
      rotationEnabled: this.rotationEnabled,
      currentLiveBot: this.currentLiveBot,
      realStreamerActive: this.realStreamerActive,
      availableBots: Array.from(this.activeBots.values()).filter(bot => 
        bot.isConnected && !bot.streaming
      ).length,
      totalBots: this.activeBots.size,
      rotationProbability: this.rotationProbability,
      rotationProbabilityPercent: (this.rotationProbability * 100).toFixed(1) + '%',
      checkIntervalRange: `${this.rotationCheckIntervalMin/1000}-${this.rotationCheckIntervalMax/1000}s`,
      rotationCheckIntervalMin: this.rotationCheckIntervalMin,
      rotationCheckIntervalMax: this.rotationCheckIntervalMax,
      // Legacy fields for UI compatibility
      timeToNextRotation: null,
      timeToNextRotationFormatted: 'Probability-based'
    };
  }
  
  /**
   * Updates the rotation probability (admin control)
   */
  updateRotationProbability(probability) {
    if (probability < 0 || probability > 1) {
      return { success: false, message: 'Probability must be between 0 and 1' };
    }
    
    this.rotationProbability = probability;
    console.log(`🎲 Updated rotation probability to ${(probability * 100).toFixed(1)}%`);
    
    // Update all streaming bots with new probability
    for (const [botId, bot] of this.activeBots.entries()) {
      if (bot.streaming && bot.rotationCheckTimer) {
        bot.updateRotationProbability(probability);
      }
    }
    
    // Save the new probability to config file and database
    this.saveRotationConfig();
    this.saveSystemState();
    
    return { success: true, probability: this.rotationProbability };
  }
  
  /**
   * Updates the rotation check interval (admin control)
   */
  updateRotationInterval(minInterval, maxInterval) {
    // Validate inputs
    if (!minInterval || !maxInterval) {
      return { success: false, message: 'Both minInterval and maxInterval are required' };
    }
    
    if (minInterval < 1000 || maxInterval > 300000) {
      return { success: false, message: 'Intervals must be between 1 second and 5 minutes' };
    }
    
    if (minInterval > maxInterval) {
      return { success: false, message: 'Min interval must be less than or equal to max interval' };
    }
    
    this.rotationCheckIntervalMin = minInterval;
    this.rotationCheckIntervalMax = maxInterval;
    
    console.log(`⏱️ Updated rotation check interval to ${minInterval/1000}-${maxInterval/1000} seconds`);
    
    // Update all streaming bots with new intervals
    for (const [botId, bot] of this.activeBots.entries()) {
      if (bot.streaming && bot.rotationCheckTimer) {
        bot.updateRotationInterval(minInterval, maxInterval);
      }
    }
    
    // Save the new intervals to config file and database
    this.saveRotationConfig();
    this.saveSystemState();
    
    return { 
      success: true, 
      minInterval: this.rotationCheckIntervalMin,
      maxInterval: this.rotationCheckIntervalMax
    };
  }
  
  /**
   * Schedules a ViewBot takeover after real streamer disconnects
   */
  scheduleViewBotTakeover() {
    // Clear any existing timer
    if (this.pendingTakeoverTimer) {
      clearTimeout(this.pendingTakeoverTimer);
    }
    
    // Random delay between 5-10 seconds
    const delay = Math.floor(Math.random() * 5000) + 5000;
    
    console.log(`⏱️ Scheduling ViewBot takeover in ${delay/1000} seconds...`);
    
    this.pendingTakeoverTimer = setTimeout(async () => {
      this.pendingTakeoverTimer = null;
      
      // Double-check that no real streamer started in the meantime
      if (!this.realStreamerActive && this.rotationEnabled && !this.currentLiveBot) {
        console.log(`🚀 Executing ViewBot takeover after real streamer disconnect`);
        await this.startViewBotRotation();
      } else {
        console.log(`🚫 ViewBot takeover cancelled - conditions changed`);
      }
    }, delay);
  }
  
  /**
   * Start cooldown cleanup timer to reset old cooldowns
   */
  startCooldownCleanup() {
    // Check every 30 minutes for expired cooldowns
    setInterval(() => {
      const now = Date.now();
      const expiredBots = [];
      
      for (const [botId, cooldown] of this.botCooldowns.entries()) {
        if (now - cooldown.lastPlayed.getTime() > this.cooldownWindowMs) {
          expiredBots.push(botId);
        }
      }
      
      // Remove expired cooldowns
      for (const botId of expiredBots) {
        this.botCooldowns.delete(botId);
        console.log(`🔄 COOLDOWN: Reset cooldown for ViewBot ${botId} after 2-hour window`);
      }
      
      if (expiredBots.length > 0) {
        console.log(`🧹 COOLDOWN: Cleared ${expiredBots.length} expired cooldowns`);
      }
    }, 30 * 60 * 1000); // Every 30 minutes
  }
  
  /**
   * Apply cooldown to a bot that just played
   */
  applyBotCooldown(botId) {
    const existing = this.botCooldowns.get(botId);
    
    if (existing) {
      // Increment play count if within window
      const now = Date.now();
      if (now - existing.lastPlayed.getTime() <= this.cooldownWindowMs) {
        existing.count++;
        existing.lastPlayed = new Date();
        console.log(`📉 COOLDOWN: ViewBot ${botId} played ${existing.count} times in window`);
      } else {
        // Reset if outside window
        this.botCooldowns.set(botId, {
          count: 1,
          lastPlayed: new Date()
        });
        console.log(`🔄 COOLDOWN: Reset and applied cooldown for ViewBot ${botId}`);
      }
    } else {
      // First play in window
      this.botCooldowns.set(botId, {
        count: 1,
        lastPlayed: new Date()
      });
      console.log(`📝 COOLDOWN: Applied first cooldown for ViewBot ${botId}`);
    }
  }
  
  /**
   * Get probability multiplier for a bot based on cooldown
   */
  getBotProbabilityMultiplier(botId) {
    const cooldown = this.botCooldowns.get(botId);
    
    if (!cooldown) {
      return 1.0; // No cooldown, full probability
    }
    
    const now = Date.now();
    if (now - cooldown.lastPlayed.getTime() > this.cooldownWindowMs) {
      // Cooldown expired
      this.botCooldowns.delete(botId);
      return 1.0;
    }
    
    // Calculate multiplier based on play count
    const multiplier = Math.max(
      this.minProbability,
      Math.pow(this.cooldownMultiplier, cooldown.count)
    );
    
    return multiplier;
  }
  
  /**
   * Select a ViewBot with weighted probability based on cooldowns
   */
  selectViewBotWithCooldown(availableBots) {
    if (availableBots.length === 0) {
      return null;
    }
    
    if (availableBots.length === 1) {
      return availableBots[0];
    }
    
    // Calculate weights for each bot
    const weights = availableBots.map(bot => ({
      bot,
      weight: this.getBotProbabilityMultiplier(bot.botId)
    }));
    
    // Log the weights for debugging
    console.log(`🎲 COOLDOWN: Bot selection weights:`, weights.map(w => 
      `${w.bot.botId.split('-').pop()}: ${(w.weight * 100).toFixed(0)}%`
    ).join(', '));
    
    // Calculate total weight
    const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
    
    // Select random value
    let random = Math.random() * totalWeight;
    
    // Find the selected bot
    for (const { bot, weight } of weights) {
      random -= weight;
      if (random <= 0) {
        return bot;
      }
    }
    
    // Fallback (shouldn't happen)
    return availableBots[0];
  }
  
  /**
   * Handles video end event from a ViewBot
   */
  async handleVideoEnd(botId) {
    console.log(`🎬 ViewBot ${botId}: Video file ended`);
    
    const bot = this.activeBots.get(botId);
    if (!bot || !bot.streaming) {
      return;
    }
    
    // Stop the current bot first and ensure cleanup
    console.log(`🧹 ViewBot ${botId}: Stopping and cleaning up before rotation`);
    await bot.stopStreaming();
    
    // Clear current live bot immediately
    if (this.currentLiveBot === botId) {
      this.currentLiveBot = null;
    }
    
    if (this.rotationEnabled && !this.realStreamerActive) {
      // CRITICAL: Wait for GStreamer cleanup to fully complete (2.5s for SIGKILL + reference clearing)
      const cleanupDelay = 3000; // 3 second delay to ensure processes are killed and references cleared
      console.log(`⏳ Waiting ${cleanupDelay}ms for complete cleanup before rotation...`);
      
      setTimeout(async () => {
        // Double-check conditions after delay
        if (this.rotationEnabled && !this.realStreamerActive && !this.currentLiveBot) {
          console.log(`🔄 Starting rotation after video end cleanup delay`);
          
          // Find any available bot to start (queue will handle selection)
          const availableBots = Array.from(this.activeBots.values()).filter(b => 
            b.isConnected && !b.streaming
          );
          
          if (availableBots.length > 0) {
            console.log(`🎯 Starting new viewbot after video end`);
            
            try {
              // Just start the rotation system - it will pick the best bot
              await this.startViewBotRotation();
              console.log(`✅ Post-video rotation started`);
              
              // Rotation will be recorded by startViewBotRotation
            } catch (error) {
              console.error(`❌ Failed to rotate after video end:`, error);
            }
          } else {
            console.log(`⚠️ No available bots for rotation after video end`);
          }
        } else {
          console.log(`⏸️ Rotation cancelled after delay (conditions changed)`);
        }
      }, cleanupDelay);
    } else {
      // Just stop streaming
      console.log(`⏹️ ViewBot stopped after video end (rotation disabled or real streamer active)`);
    }
  }
  
  /**
   * Force rotation (admin command)
   */
  async forceRotation() {
    if (!this.rotationEnabled) {
      return { success: false, message: 'Rotation is disabled' };
    }
    
    if (!this.currentLiveBot) {
      return { success: false, message: 'No ViewBot currently streaming' };
    }
    
    console.log(`💪 Force rotation requested`);
    
    // Use the queue to prevent race conditions
    const result = this.queueRotationRequest(this.currentLiveBot, 'forced');
    
    return result;
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
    
    // ViewBot rotation system - probability-based
    this.rotationCheckTimer = null;
    this.rotationProbability = parentService ? parentService.rotationProbability : 0.31;
    this.checkIntervalMin = parentService ? parentService.rotationCheckIntervalMin : 5000;
    this.checkIntervalMax = parentService ? parentService.rotationCheckIntervalMax : 10000;
    this.nextCheckTime = null;
    
    // Database session tracking
    this.currentSessionId = null;
    this.sessionStartTime = null;
    
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
      // CRITICAL: Always use the correct server URL from environment
      // This ensures ViewBots connect to the right server even after restarts
      const protocol = 'https';
      const port = process.env.HTTPS_PORT || 8443;
      const host = process.env.SERVER_HOST || 'onestreamer.live';
      const correctServerUrl = process.env.VIEWBOT_SERVER_URL || `${protocol}://${host}:${port}`;
      
      // Update the serverUrl if it's different
      if (this.serverUrl !== correctServerUrl) {
        console.log(`🔄 ViewBot ${this.botId}: Updating server URL from ${this.serverUrl} to ${correctServerUrl}`);
        this.serverUrl = correctServerUrl;
      }
      
      console.log(`🔌 ViewBot ${this.botId}: Connecting to server ${this.serverUrl}`);
      
      // For HTTPS connections with self-signed certificates, we need a custom agent
      const https = require('https');
      const agent = new https.Agent({
        rejectUnauthorized: false // Accept self-signed certificates
      });
      
      // Connect to the server via Socket.IO
      // Start with polling for better HTTPS compatibility, then upgrade to websocket
      this.socket = io(this.serverUrl, {
        transports: ['polling', 'websocket'], // Start with polling
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 3,
        reconnectionDelay: 1000,
        // For HTTPS with self-signed certificates - CRITICAL for ViewBot connections
        rejectUnauthorized: false,
        secure: true,
        // Use custom HTTPS agent for self-signed certificates
        agent: agent,
        // Allow transport upgrades
        upgrade: true,
        // Force new connection
        forceNew: true
      });
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error(`❌ ViewBot ${this.botId}: Connection timeout after 10 seconds to ${this.serverUrl}`);
          reject(new Error('Connection timeout'));
        }, 10000);
        
        this.socket.on('connect', () => {
          clearTimeout(timeout);
          this.isConnected = true;
          // Clear any previous connection errors
          if (this.lastError && (this.lastError.includes('Socket') || this.lastError.includes('Connection'))) {
            this.lastError = null;
          }
          console.log(`✅ ViewBot ${this.botId}: Connected to server`);
          console.log(`📡 ViewBot ${this.botId}: My socket ID is: ${this.socket.id}`);
          console.log(`📡 ViewBot ${this.botId}: Socket connected: ${this.socket.connected}`);
          resolve();
        });
        
        this.socket.on('connect_error', (error) => {
          clearTimeout(timeout);
          console.error(`❌ ViewBot ${this.botId}: Connection error:`, error.message, error.type);
          console.error(`❌ ViewBot ${this.botId}: Failed to connect to ${this.serverUrl}`);
          reject(error);
        });
      });
      
      // Set up socket event handlers BEFORE resolving the connection promise
      // This ensures handlers are ready before any events are sent
      this.setupSocketHandlers();
      
      // Wait for handlers to be fully registered
      await new Promise(resolve => setTimeout(resolve, 100));
      
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
    console.log(`🔧 ViewBot ${this.botId}: Setting up socket handlers, socket ID: ${this.socket.id}, connected: ${this.socket.connected}`);
    
    this.socket.on('disconnect', () => {
      console.log(`🔌 ViewBot ${this.botId}: Disconnected from server`);
      this.isConnected = false;
      this.streaming = false;
    });

    this.socket.on('error', (error) => {
      console.error(`❌ ViewBot ${this.botId}: Socket error:`, error);
      this.lastError = error.message || 'Socket error';
    });

    // CRITICAL: Set up streaming-approved handler with detailed logging
    this.socket.on('streaming-approved', () => {
      console.log(`🎉🎉🎉 ViewBot ${this.botId}: RECEIVED streaming-approved event!`);
      console.log(`📡 ViewBot ${this.botId}: Socket ID: ${this.socket.id}, Connected: ${this.socket.connected}`);
      
      // Clear approval timeout if it exists
      if (this.approvalTimeout) {
        clearTimeout(this.approvalTimeout);
        this.approvalTimeout = null;
      }
      
      // The bot is now the official streamer, trigger viewer notifications
      this.streaming = true;
      this.isStartingStream = false; // Clear the starting flag
      
      // CRITICAL: Update parent service to track this bot as live
      if (this.parentService) {
        this.parentService.currentLiveBot = this.botId;
        this.parentService.currentLiveBotSetTime = Date.now();
        console.log(`✅ ViewBot ${this.botId}: Updated parent service - now tracked as currentLiveBot`);
      }
      
      // Start rotation check timer now that we're approved
      this.startRotationCheckTimer();
      
      // Initialize media pipeline
      this.onStreamingApproved().catch(error => {
        console.error(`❌ ViewBot ${this.botId}: Failed to handle streaming approval:`, error);
        this.streaming = false; // Reset streaming flag on error
        this.isStartingStream = false; // Clear the starting flag
      });
    });
    
    // Handle streaming approval with acknowledgment (for debugging)
    this.socket.on('streaming-approved-ack', (data, callback) => {
      console.log(`🔔 ViewBot ${this.botId}: Received streaming-approved-ack, sending acknowledgment`);
      if (callback) {
        callback(true); // Send acknowledgment back to server
      }
    });
    
    // Alternative ViewBot streaming approval event
    this.socket.on('viewbot-stream-approved', (data) => {
      console.log(`🎯 ViewBot ${this.botId}: Received viewbot-stream-approved!`);
      
      // Clear approval timeout if it exists
      if (this.approvalTimeout) {
        clearTimeout(this.approvalTimeout);
        this.approvalTimeout = null;
      }
      
      // The bot is now the official streamer
      this.streaming = true;
      this.isStartingStream = false; // Clear the starting flag
      
      // CRITICAL: Update parent service to track this bot as live
      if (this.parentService) {
        this.parentService.currentLiveBot = this.botId;
        this.parentService.currentLiveBotSetTime = Date.now();
        console.log(`✅ ViewBot ${this.botId}: Updated parent service - now tracked as currentLiveBot`);
      }
      
      // Start rotation check timer now that we're approved
      this.startRotationCheckTimer();
      
      // Initialize media pipeline
      this.onStreamingApproved().catch(error => {
        console.error(`❌ ViewBot ${this.botId}: Failed to handle streaming approval:`, error);
        this.streaming = false;
      });
    });
    
    // Debug: Log all events received
    this.socket.onAny((eventName, ...args) => {
      if (eventName !== 'stream-status' && eventName !== 'viewer-count' && !eventName.includes('buff')) {
        console.log(`🔔 ViewBot ${this.botId}: Received event '${eventName}'`);
      }
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
   * Start polling for approval status (workaround for Socket.IO event issues)
   */
  startApprovalPolling() {
    let pollCount = 0;
    const maxPolls = 50; // Poll for up to 5 seconds (100ms intervals)
    
    const pollInterval = setInterval(async () => {
      pollCount++;
      
      // Check if we're the current streamer via HTTP API
      try {
        const response = await fetch(`${this.serverUrl}/api/stream-status`);
        const status = await response.json();
        
        if (status.isLive && status.streamerId === this.socket?.id) {
          console.log(`✅ ViewBot ${this.botId}: Confirmed as active streamer via polling!`);
          clearInterval(pollInterval);
          
          // Clear timeout if exists
          if (this.approvalTimeout) {
            clearTimeout(this.approvalTimeout);
            this.approvalTimeout = null;
          }
          
          // We're approved! Start media pipeline
          this.streaming = true;
          this.isStartingStream = false; // Clear the starting flag
          this.startRotationCheckTimer();
          this.onStreamingApproved().catch(error => {
            console.error(`❌ ViewBot ${this.botId}: Failed to start media pipeline:`, error);
            this.streaming = false;
          });
          
          return;
        }
      } catch (error) {
        // API might not be available, continue polling
      }
      
      if (pollCount >= maxPolls) {
        console.log(`⏰ ViewBot ${this.botId}: Polling timeout - NOT auto-approving to prevent multiple streams`);
        clearInterval(pollInterval);
        
        // DON'T automatically start - this causes multiple bots to stream
        // The rotation system should handle starting the right bot
        this.isStartingStream = false; // Clear the starting flag
        this.streaming = false;
        
        // If this was the intended bot to stream, rotation system will retry
        console.log(`⚠️ ViewBot ${this.botId}: Stream request timed out without approval`);
      }
    }, 100);
  }
  
  /**
   * Called when server approves streaming - start producing media
   */
  async onStreamingApproved() {
    console.log(`🎬 ViewBot ${this.botId}: Now officially streaming, starting media production`);
    console.log(`🎬 ViewBot ${this.botId}: Socket connected: ${this.isConnected}, Socket ID: ${this.socket?.id}`);
    
    // Clear any previous errors on successful streaming approval
    this.lastError = null;
    
    // Use state manager for tracking but still create real media streams
    if (stateManager.simplifiedMode) {
      console.log(`🎯 ViewBot ${this.botId}: Using state manager with real media pipeline`);
      
      // Register with state manager
      stateManager.registerBot(this.botId);
      
      // Transition through states
      stateManager.transition(this.botId, 'approved');
      
      // State manager will handle the transition to streaming
      await stateManager.approveStreaming(this.botId);
    }
    
    try {
      // Original media pipeline code (currently failing)
      if (this.config.contentType === 'videoFile' && this.config.videoFile) {
        console.log(`🎬 ViewBot ${this.botId}: Starting GStreamer video pipeline: ${this.config.videoFile}`);
        await this.startGStreamerVideoFileStreaming();
      } else {
        console.log(`🎬 ViewBot ${this.botId}: Content type ${this.config.contentType} - starting media generation`);
        await this.initializeMediaGeneration();
      }
      
      // Confirm streaming is active
      this.streaming = true;
      this.isStartingStream = false; // Clear the starting flag
      
      console.log(`✅ ViewBot ${this.botId}: Media pipeline active, streaming to MediaSoup`);
      
      // CRITICAL: Start rotation timer for this bot
      this.startRotationCheckTimer();
      console.log(`🔄 ViewBot ${this.botId}: Started rotation check timer`);
      
      // Notify viewers immediately
      this.notifyViewersOfReadyStream();
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to start media streaming:`, error);
      this.lastError = error.message;
      
      // CRITICAL FIX: Keep streaming=true to prevent presence system from restarting every 30s
      // The bot is "streaming" even if the media pipeline has issues
      this.streaming = true;
      this.isStartingStream = false;
      
      console.log(`⚠️ ViewBot ${this.botId}: Maintaining streaming=true despite media pipeline error to preserve rotation system`);
      
      // CRITICAL: Start rotation timer even if media pipeline failed
      this.startRotationCheckTimer();
      console.log(`🔄 ViewBot ${this.botId}: Started rotation check timer (despite media error)`);
      
      // Still notify viewers that stream is ready (even if degraded)
      this.notifyViewersOfReadyStream();
      
      // Notify server of error but don't fail the stream
      if (this.socket) {
        this.socket.emit('streaming-warning', {
          botId: this.botId,
          warning: 'Media pipeline error but maintaining stream',
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
      // No loop - allow video to end naturally
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.videoRtpPort}`,
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.audioRtpPort}`
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
      // No loop - allow video to end naturally
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.videoRtpPort}|rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.audioRtpPort}`
    ];
    
    // Optimized approach: Use filter_complex with synchronized timestamp processing
    const syncedArgs = [
      '-re',
      // No loop - allow video to end naturally 
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.videoRtpPort}`,
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.audioRtpPort}`
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
        
        // Handle video end when FFmpeg exits normally for video files
        if (code === 0 && this.config.contentType === 'videoFile' && this.streaming && !this.handlingVideoEnd) {
          console.log(`🎬 ViewBot ${this.botId}: Video file reached end (FFmpeg exit code 0)`);
          this.handleVideoEnd();
        }
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
      // No loop - allow video to end naturally
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${videoRtpPort}?rtcpport=${videoRtcpPort}`,
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${audioRtpPort}?rtcpport=${audioRtcpPort}`
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
        
        // Handle video end when FFmpeg exits normally for video files
        if (code === 0 && this.config.contentType === 'videoFile' && this.streaming && !this.handlingVideoEnd) {
          console.log(`🎬 ViewBot ${this.botId}: Video file reached end (FFmpeg exit code 0)`);
          this.handleVideoEnd();
        }
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
    
    // Check common installation path based on OS
    const gstreamerPath = process.platform === 'win32'
      ? 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe'
      : '/usr/bin/gst-launch-1.0';
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
    // CRITICAL: Prevent multiple calls
    if (this.gstreamerStarting || this.gstreamerVideoProcess || this.gstreamerAudioProcess) {
      console.log(`⚠️ ViewBot ${this.botId}: GStreamer already starting/running - skipping duplicate call`);
      console.log(`   Starting: ${this.gstreamerStarting}, Video PID: ${this.gstreamerVideoProcess?.pid}, Audio PID: ${this.gstreamerAudioProcess?.pid}`);
      return;
    }
    this.gstreamerStarting = true;
    
    console.log(`🎬 ViewBot ${this.botId}: Starting GStreamer-based video file streaming (ENHANCED)`);
    console.log(`📂 Video file: ${this.config.videoFile}`);
    console.log(`🔍 STACK TRACE:`, new Error().stack.split('\n').slice(1, 5).join('\n'));
    
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
    
    // Get video duration using ffprobe for fallback timer
    await this.getVideoDuration(this.config.videoFile);
    
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
      
      // Clear the starting flag
      this.gstreamerStarting = false;
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: GStreamer launch failed:`, error.message);
      console.error(`   Full error:`, error);
      
      // Clear the starting flag
      this.gstreamerStarting = false;
      
      // Clean up any started processes
      this.cleanupGStreamerProcesses();
      
      // Fallback to FFmpeg if GStreamer fails
      console.log(`⚠️ ViewBot ${this.botId}: Falling back to FFmpeg method`);
      this.config.useGStreamer = false;
      
      if (typeof this.startFFmpegVideoFileStreaming === 'function') {
        await this.startFFmpegVideoFileStreaming();
        // Clear the error if FFmpeg works as fallback
        this.lastError = null;
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
      '!', 'queue', 'max-size-buffers=200', 'max-size-time=2000000000', 'max-size-bytes=10485760',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', `video/x-raw,width=${width},height=${height}`,
      '!', 'videorate',
      '!', `video/x-raw,framerate=${frameRate}/1`,
      '!', 'vp8enc', 'deadline=1', 'cpu-used=4', 'error-resilient=1', 'target-bitrate=1500000', 'keyframe-max-dist=30', 'threads=2',
      '!', 'rtpvp8pay', `ssrc=${this.videoSSRC}`, 'pt=96', 'mtu=1200', 'picture-id-mode=2',
      '!', 'udpsink', 'host=127.0.0.1', `port=${this.videoRtpPort}`, 'sync=true', 'async=false'
    ];
    
    // Audio pipeline - direct RTP without rtpbin
    const audioPipeline = [
      '-e',  // Force EOS on shutdown
      '-v',  // Verbose for debugging
      'filesrc', `location=${videoFile}`,
      '!', 'decodebin',
      '!', 'queue', 'max-size-buffers=200', 'max-size-time=2000000000', 'max-size-bytes=10485760',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc', 'bitrate=128000', 'frame-size=20',
      '!', 'rtpopuspay', `ssrc=${this.audioSSRC}`, 'pt=111', 'mtu=1200',
      '!', 'udpsink', 'host=127.0.0.1', `port=${this.audioRtpPort}`, 'sync=true', 'async=false'
    ];
    
    // Use the correct GStreamer path based on the operating system
    const isWindows = process.platform === 'win32';
    const gstreamerPath = isWindows 
      ? 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe'
      : 'gst-launch-1.0';
    
    console.log(`🎥 ViewBot ${this.botId}: Starting video pipeline (no rtpbin)`);
    console.log(`🎥 ViewBot ${this.botId}: GStreamer path: ${gstreamerPath}`);
    console.log(`🎥 ViewBot ${this.botId}: Video file: ${videoFile}`);
    console.log(`🎥 ViewBot ${this.botId}: Pipeline args count: ${videoPipeline.length}`);
    
    // Debug: Log the actual command being run
    console.log(`🎥 ViewBot ${this.botId}: Full command: ${gstreamerPath} ${videoPipeline.join(' ')}`);
    
    // CRITICAL: Ensure clean state before starting
    await processManager.prepareForStreaming(this.botId);
    
    // Only use shell: true on Windows, it breaks argument parsing on Linux
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      shell: isWindows,  // Only required for Windows
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows  // CRITICAL: Create new process group on Linux for proper cleanup
    });
    
    // Check if process started
    if (!this.gstreamerVideoProcess || !this.gstreamerVideoProcess.pid) {
      console.error(`❌ ViewBot ${this.botId}: Failed to spawn video process`);
      throw new Error('Failed to spawn GStreamer video process');
    }
    
    console.log(`🎥 ViewBot ${this.botId}: Video process started, PID: ${this.gstreamerVideoProcess.pid}`);
    
    // Register with ProcessManager
    processManager.registerProcess(this.botId, 'video', this.gstreamerVideoProcess.pid);
    
    console.log(`🔊 ViewBot ${this.botId}: Starting audio pipeline (no rtpbin)`);
    
    // Only use shell: true on Windows, it breaks argument parsing on Linux
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      shell: isWindows,  // Only required for Windows
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows  // CRITICAL: Create new process group on Linux for proper cleanup
    });
    
    // Check if process started
    if (!this.gstreamerAudioProcess || !this.gstreamerAudioProcess.pid) {
      console.error(`❌ ViewBot ${this.botId}: Failed to spawn audio process`);
      throw new Error('Failed to spawn GStreamer audio process');
    }
    
    // Register with ProcessManager
    processManager.registerProcess(this.botId, 'audio', this.gstreamerAudioProcess.pid);
    
    console.log(`🔊 ViewBot ${this.botId}: Audio process started, PID: ${this.gstreamerAudioProcess.pid}`);
    
    // Set up duration-based failsafe rotation
    await this.setupDurationBasedRotation(videoFile);
    
    let videoStarted = false;
    let audioStarted = false;
    let videoEOS = false;
    let audioEOS = false;
    let videoError = '';
    let audioError = '';
    
    // Monitor video pipeline stderr for state changes and errors
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Log first few messages for debugging
      if (!videoStarted) {
        console.log(`📹 ViewBot ${this.botId}: Video stderr: ${output.substring(0, 200)}`);
      }
      
      if (output.includes('ERROR')) {
        videoError = output.substring(0, 200);
        console.error(`❌ ViewBot ${this.botId}: Video pipeline error`);
        console.error(output);
      } else if (output.includes('PLAYING') || output.includes('Setting pipeline to PLAYING')) {
        if (!videoStarted) {
          videoStarted = true;
          console.log(`▶️ ViewBot ${this.botId}: Video pipeline playing`);
        }
      } else if (output.includes('EOS') || output.includes('end-of-stream') || 
                 output.includes('Got EOS from element') || output.includes('Posting EOS') ||
                 output.includes('EOS received') || output.includes('Execution ended')) {
        if (!videoEOS) {
          videoEOS = true;
          console.log(`🏁 ViewBot ${this.botId}: Video EOS detected - cleaning up first!`);
          console.log(`   EOS Message: ${output.substring(0, 100)}`);
          
          // First cleanup the processes to ensure resources are freed
          console.log(`🧹 ViewBot ${this.botId}: Cleaning up GStreamer processes immediately`);
          this.cleanupGStreamerProcesses();
          
          // Then trigger video end handling after cleanup to avoid conflicts
          setTimeout(() => {
            if (!this.stopping && !this.handlingVideoEnd) {
              console.log(`🔄 ViewBot ${this.botId}: Triggering rotation after cleanup`);
              this.handleVideoEnd();
            }
          }, 200); // Small delay to ensure cleanup completes
        }
      } else if (output.includes('Setting pipeline to NULL')) {
        console.log(`🔧 ViewBot ${this.botId}: Video pipeline shutting down`);
      } else if (output.includes('Setting pipeline')) {
        console.log(`🔧 ViewBot ${this.botId}: Video pipeline state change`);
      } else if (output.includes('caps = video/')) {
        console.log(`📹 ViewBot ${this.botId}: Video stream detected`);
      } else if (output.includes('Freeing pipeline')) {
        console.log(`🧹 ViewBot ${this.botId}: Video pipeline freed`);
      }
    });
    
    // Also monitor stdout (GStreamer may output to stdout instead of stderr)
    this.gstreamerVideoProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Log for debugging
      if (!videoStarted) {
        console.log(`📹 ViewBot ${this.botId}: Video stdout: ${output.substring(0, 200)}`);
      }
      
      if (output.includes('Setting pipeline') || output.includes('PLAYING')) {
        console.log(`🔧 ViewBot ${this.botId}: Video pipeline state: ${output.trim()}`);
        if (!videoStarted && (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED'))) {
          videoStarted = true;
          console.log(`▶️ ViewBot ${this.botId}: Video pipeline playing (from stdout)`);
        }
      }
    });
    
    // Monitor audio pipeline stderr for state changes and errors
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        audioError = output.substring(0, 200);
        console.error(`❌ ViewBot ${this.botId}: Audio pipeline error`);
        console.error(output);
      } else if (output.includes('PLAYING') || output.includes('Setting pipeline to PLAYING')) {
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
    
    // Also monitor stdout (GStreamer may output to stdout instead of stderr)
    this.gstreamerAudioProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Log for debugging
      if (!audioStarted) {
        console.log(`🔊 ViewBot ${this.botId}: Audio stdout: ${output.substring(0, 200)}`);
      }
      
      if (output.includes('Setting pipeline') || output.includes('PLAYING')) {
        console.log(`🔧 ViewBot ${this.botId}: Audio pipeline state: ${output.trim()}`);
        if (!audioStarted && (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED'))) {
          audioStarted = true;
          console.log(`▶️ ViewBot ${this.botId}: Audio pipeline playing (from stdout)`);
        }
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
      
      // Handle video end - trigger rotation after ensuring cleanup
      if (!this.stopping && !this.handlingVideoEnd && (videoEOS || code === 0)) {
        console.log(`🎬 ViewBot ${this.botId}: Video file reached end (GStreamer EOS: ${videoEOS}, Exit code: ${code})`);
        // Ensure cleanup then trigger rotation
        setTimeout(() => {
          if (!this.stopping && !this.handlingVideoEnd) {
            this.handleVideoEnd();
          }
        }, 500); // Small delay to ensure process cleanup
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
      // Check if processes are actually running even without PLAYING message
      const checkProcesses = () => {
        const videoRunning = this.gstreamerVideoProcess && this.gstreamerVideoProcess.pid && !this.gstreamerVideoProcess.killed;
        const audioRunning = this.gstreamerAudioProcess && this.gstreamerAudioProcess.pid && !this.gstreamerAudioProcess.killed;
        return { videoRunning, audioRunning };
      };
      
      const timeout = setTimeout(() => {
        const { videoRunning, audioRunning } = checkProcesses();
        
        // If processes are running with PIDs, consider them started even without PLAYING message
        if (videoRunning || audioRunning) {
          console.log(`⚠️ ViewBot ${this.botId}: Processes running without PLAYING confirmation (Video PID: ${this.gstreamerVideoProcess?.pid}, Audio PID: ${this.gstreamerAudioProcess?.pid})`);
          videoStarted = videoStarted || videoRunning;
          audioStarted = audioStarted || audioRunning;
          resolve();
        } else if (!videoStarted && !audioStarted) {
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
  /**
   * Set up duration-based rotation as a failsafe
   */
  async setupDurationBasedRotation(videoFile) {
    try {
      const { execSync } = require('child_process');
      const duration = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoFile}"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      const durationSeconds = parseFloat(duration);
      if (durationSeconds > 0 && !isNaN(durationSeconds)) {
        // Add 5 second buffer for processing delays
        const rotationDelay = (durationSeconds + 5) * 1000;
        
        console.log(`⏰ ViewBot ${this.botId}: Video duration is ${durationSeconds}s, setting failsafe rotation timer for ${rotationDelay}ms`);
        
        this.videoDurationTimer = setTimeout(() => {
          console.log(`⚠️ ViewBot ${this.botId}: Duration-based failsafe triggered - video should have ended by now`);
          if (!this.handlingVideoEnd && this.streaming) {
            console.log(`🆘 ViewBot ${this.botId}: EOS not detected, forcing cleanup then rotation`);
            
            // First force cleanup to free resources
            this.cleanupGStreamerProcesses();
            
            // Then trigger rotation after cleanup
            setTimeout(() => {
              if (!this.handlingVideoEnd) {
                this.handleVideoEnd();
              }
            }, 200);
          }
        }, rotationDelay);
      } else {
        console.warn(`⚠️ ViewBot ${this.botId}: Could not determine video duration for failsafe`);
      }
    } catch (error) {
      console.warn(`⚠️ ViewBot ${this.botId}: Failed to set up duration-based rotation:`, error.message);
    }
  }
  
  cleanupGStreamerProcesses() {
    console.log(`🧹🧹🧹 CLEANUP CALLED - ViewBot ${this.botId}: Cleaning up GStreamer processes...`);
    console.log(`   📊 Current process references:`, {
      video: this.gstreamerVideoProcess ? `PID ${this.gstreamerVideoProcess.pid}` : 'NULL',
      audio: this.gstreamerAudioProcess ? `PID ${this.gstreamerAudioProcess.pid}` : 'NULL',
      gstreamer: this.gstreamerProcess ? `PID ${this.gstreamerProcess.pid}` : 'NULL'
    });
    
    // Clear duration timer if set
    if (this.videoDurationTimer) {
      clearTimeout(this.videoDurationTimer);
      this.videoDurationTimer = null;
    }
    
    // Clear health check timer if set
    if (this.pipelineHealthCheckTimer) {
      clearInterval(this.pipelineHealthCheckTimer);
      this.pipelineHealthCheckTimer = null;
    }
    
    // Clear recovery timer if set
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    
    // Store references for delayed cleanup
    const processesToKill = [];
    
    // CRITICAL: Kill entire process group to prevent orphaned processes
    const killProcess = (proc, name) => {
      if (proc && proc.pid) {
        const pid = proc.pid;
        console.log(`   💀💀💀 KILLING ${name} process group (PID: ${pid})`);
        
        try {
          // CRITICAL: Use negative PID to kill entire process group on Linux
          // This ensures all child processes spawned by GStreamer are killed
          if (process.platform !== 'win32') {
            // On Linux, kill the entire process group
            const { execSync } = require('child_process');
            try {
              // Use pkill to kill all processes in the process group
              console.log(`   🔫 Executing: kill -9 -${pid} (kill process group)`);
              execSync(`kill -9 -${pid}`, { stdio: 'ignore' });
              console.log(`   ✅✅✅ ${name} process group KILLED (PID: -${pid})`);
            } catch (killError) {
              // If group kill fails, try to kill the single process
              console.log(`   ⚠️ Group kill failed, trying single process kill`);
              try {
                proc.kill('SIGKILL');
                console.log(`   ✅ ${name} single process killed (PID: ${pid})`);
              } catch (e) {
                console.log(`   ❌ Failed to kill ${name}: ${e.message}`);
              }
            }
          } else {
            // On Windows, just kill the process normally
            proc.kill('SIGKILL');
            console.log(`   ✅ ${name} process killed (PID: ${pid})`);
          }
        } catch (error) {
          // Process might already be dead
          if (error.code !== 'ESRCH') {
            console.log(`   ❌❌❌ ERROR killing ${name}: ${error.message}`);
          } else {
            console.log(`   ⚠️ ${name} process already dead (ESRCH)`);
          }
        }
      } else {
        console.log(`   ⚠️⚠️⚠️ No ${name} process reference to kill!`);
      }
    };
    
    // Kill all processes
    killProcess(this.gstreamerVideoProcess, 'video');
    killProcess(this.gstreamerAudioProcess, 'audio');
    killProcess(this.gstreamerProcess, 'gstreamer');
    
    // No longer needed - process group killing handles all child processes
    
    // Clear references immediately - processes are being killed
    this.gstreamerVideoProcess = null;
    this.gstreamerAudioProcess = null;
    this.gstreamerProcess = null;
    // CRITICAL: Clear the starting flag to allow future starts
    this.gstreamerStarting = false;
    console.log(`   🧹 Process references and flags cleared`);
    
    console.log(`   ✅ Cleanup completed - all processes killed`);
  }
  
  /**
   * Start health monitoring for GStreamer pipelines
   * Checks pipeline status every 5 seconds and recovers if needed
   */
  startPipelineHealthCheck() {
    if (this.pipelineHealthCheckTimer) {
      clearInterval(this.pipelineHealthCheckTimer);
    }
    
    console.log(`🏥 ViewBot ${this.botId}: Starting pipeline health monitoring`);
    
    // Initial health check after 10 seconds
    setTimeout(() => this.checkPipelineHealth(), 10000);
    
    // Regular health checks every 5 seconds
    this.pipelineHealthCheckTimer = setInterval(() => {
      this.checkPipelineHealth();
    }, 5000);
  }
  
  /**
   * Check if GStreamer pipelines are healthy and recover if needed
   */
  async checkPipelineHealth() {
    // Skip if we're stopping or handling video end
    if (this.stopping || this.handlingVideoEnd || !this.streaming) {
      return;
    }
    
    const videoPid = this.gstreamerVideoProcess?.pid;
    const audioPid = this.gstreamerAudioProcess?.pid;
    
    // Check if processes exist
    const videoAlive = this.isProcessAlive(videoPid);
    const audioAlive = this.isProcessAlive(audioPid);
    
    if (!videoAlive && !audioAlive) {
      console.error(`💀 ViewBot ${this.botId}: Both pipelines are dead!`);
      this.handlePipelineCrash('both');
    } else if (!videoAlive) {
      console.error(`💀 ViewBot ${this.botId}: Video pipeline is dead (PID ${videoPid})`);
      this.handlePipelineCrash('video');
    } else if (!audioAlive) {
      console.error(`💀 ViewBot ${this.botId}: Audio pipeline is dead (PID ${audioPid})`);
      this.handlePipelineCrash('audio');
    } else {
      // Both alive, check for stuck pipelines
      this.checkPipelineActivity();
    }
  }
  
  /**
   * Check if a process is still alive
   */
  isProcessAlive(pid) {
    if (!pid) return false;
    
    try {
      // Sending signal 0 tests if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // Process doesn't exist
      return false;
    }
  }
  
  /**
   * Check if pipelines are producing data (not stuck)
   */
  checkPipelineActivity() {
    // Track frame counts
    const currentTime = Date.now();
    
    if (!this.lastHealthCheck) {
      this.lastHealthCheck = {
        time: currentTime,
        videoFrames: 0,
        audioFrames: 0
      };
      return;
    }
    
    const timeDiff = currentTime - this.lastHealthCheck.time;
    
    // If more than 10 seconds without activity, pipeline might be stuck
    if (timeDiff > 10000) {
      console.warn(`⚠️ ViewBot ${this.botId}: No pipeline activity for ${timeDiff/1000}s`);
      
      // Check if we should recover
      if (timeDiff > 15000) {
        console.error(`🔄 ViewBot ${this.botId}: Pipelines appear stuck, recovering...`);
        this.handlePipelineCrash('stuck');
      }
    }
  }
  
  /**
   * Handle pipeline crash and attempt recovery
   */
  async handlePipelineCrash(type) {
    // Prevent multiple recovery attempts
    if (this.recovering || this.stopping || this.handlingVideoEnd) {
      console.log(`🔄 ViewBot ${this.botId}: Recovery blocked (recovering=${this.recovering}, stopping=${this.stopping})`);
      return;
    }
    
    // Rate limit recovery attempts
    const now = Date.now();
    const timeSinceLastRecovery = now - (this.pipelineHealth?.lastRecovery || 0);
    if (timeSinceLastRecovery < 5000) {
      console.log(`⏳ ViewBot ${this.botId}: Delaying recovery (only ${timeSinceLastRecovery}ms since last)`);
      return;
    }
    
    this.recovering = true;
    this.recoveryAttempts = (this.recoveryAttempts || 0) + 1;
    
    if (this.pipelineHealth) {
      this.pipelineHealth.lastRecovery = now;
    }
    
    console.log(`🚨 ViewBot ${this.botId}: Pipeline crash detected (${type}), attempt ${this.recoveryAttempts}/3`);
    
    // If too many recovery attempts or consecutive failures, rotate to next video
    if (this.recoveryAttempts > 3 || (this.pipelineHealth?.consecutiveFailures > 5)) {
      console.error(`❌ ViewBot ${this.botId}: Too many failures, forcing rotation`);
      this.recoveryAttempts = 0;
      this.recovering = false;
      
      // Force cleanup and rotation
      await this.killAllProcesses();
      
      if (!this.handlingVideoEnd) {
        await this.handleVideoEnd();
      }
      return;
    }
    
    try {
      // Kill all processes forcefully first
      console.log(`🛑 ViewBot ${this.botId}: Force stopping all pipelines...`);
      await this.killAllProcesses();
      
      // Wait for processes to die
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Clean up resources
      console.log(`🧹 ViewBot ${this.botId}: Cleaning up resources...`);
      this.cleanupGStreamerProcesses();
      
      // Check if we should still recover
      if (this.stopping || this.handlingVideoEnd) {
        console.log(`🚫 ViewBot ${this.botId}: Aborting recovery - bot is stopping`);
        this.recovering = false;
        return;
      }
      
      // Restart pipelines with exponential backoff
      const backoffDelay = Math.min(1000 * Math.pow(1.5, this.recoveryAttempts - 1), 10000);
      console.log(`⏰ ViewBot ${this.botId}: Waiting ${backoffDelay/1000}s before restart...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
      
      console.log(`🔄 ViewBot ${this.botId}: Restarting pipelines...`);
      
      if (this.config.videoFile) {
        const { width = 1280, height = 720, frameRate = 30 } = this.config;
        const videoFile = this.config.videoFile.replace(/\\/g, '/');
        
        // Mark stream start time
        this.streamStartTime = Date.now();
        
        await this.startDirectRTPPipelines(videoFile, width, height, frameRate);
        
        // Reset recovery counter on success
        this.recoveryAttempts = 0;
        
        // Start health monitoring again
        this.startPipelineHealthCheck();
        
        console.log(`✅ ViewBot ${this.botId}: Pipeline recovery successful`);
      }
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Pipeline recovery failed:`, error.message);
      
      // Exponential backoff for retries
      const retryDelay = Math.min(3000 * Math.pow(2, this.recoveryAttempts - 1), 30000);
      console.log(`⏰ ViewBot ${this.botId}: Retrying recovery in ${retryDelay/1000}s`);
      
      this.recoveryTimer = setTimeout(() => {
        this.recovering = false;
        this.handlePipelineCrash(type);
      }, retryDelay);
    } finally {
      this.recovering = false;
    }
  }
  
  /**
   * Kill all pipeline processes forcefully
   */
  async killAllProcesses() {
    const processes = [
      { proc: this.gstreamerVideoProcess, name: 'video' },
      { proc: this.gstreamerAudioProcess, name: 'audio' },
      { proc: this.ffmpegProcess, name: 'ffmpeg' }
    ];
    
    for (const { proc, name } of processes) {
      if (proc && proc.pid) {
        try {
          console.log(`💀 Killing ${name} process (PID: ${proc.pid})`);
          proc.kill('SIGKILL');
        } catch (error) {
          // Process might already be dead
        }
      }
    }
    
    // Also kill any orphaned gst-launch processes
    try {
      const { execSync } = require('child_process');
      execSync(`pkill -f "gst-launch.*${this.videoRtpPort}" || true`, { encoding: 'utf8' });
      execSync(`pkill -f "gst-launch.*${this.audioRtpPort}" || true`, { encoding: 'utf8' });
    } catch (error) {
      // Ignore errors
    }
    
    // Clear references
    this.gstreamerVideoProcess = null;
    this.gstreamerAudioProcess = null;
    this.ffmpegProcess = null;
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
    
    // Use the correct GStreamer path based on the operating system
    const gstreamerPath = process.platform === 'win32'
      ? 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe'
      : 'gst-launch-1.0';
    
    console.log(`🔊 ViewBot ${this.botId}: Starting GStreamer audio pipeline on port ${this.audioRtpPort}`);
    
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'  // CRITICAL: Create new process group on Linux for proper cleanup
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
        // No loop - allow video to end naturally
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
      '-vf', `scale=${width}:${height},format=yuv420p,setpts=PTS-STARTPTS`, // Scale, ensure format, and reset PTS
      '-r', frameRate.toString(), // Set frame rate
      '-vsync', 'cfr', // Constant frame rate for consistent timing
      // Video codec settings for VP8 with better parameters
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-error-resilient', '1',
      '-auto-alt-ref', '0',
      '-cpu-used', '8', // Faster encoding for real-time
      '-b:v', '800k',
      '-minrate', '400k',
      '-maxrate', '1200k',
      '-bufsize', '1600k',
      '-g', '10', // Keyframe every 10 frames for faster start
      '-keyint_min', '10', // Minimum keyframe interval
      '-quality', 'realtime',
      '-static-thresh', '0', // Disable static area detection
      '-max-intra-rate', '0', // No limit on intra frames
      '-lag-in-frames', '0', // No frame lookahead
      '-pix_fmt', 'yuv420p',
      // RTP output settings with fixed SSRC
      '-an', // No audio in video stream
      '-f', 'rtp',
      '-ssrc', String(ssrc),
      '-payload_type', '96',
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.videoRtpPort}`
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
   * Creates FFmpeg arguments for H.264 video generation (alternative to VP8)
   */
  createH264VideoFFmpegArgs() {
    if (!this.videoRtpPort) {
      throw new Error('Video RTP port not allocated by server');
    }
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    
    // Generate test pattern
    const videoInput = `testsrc2=size=${width}x${height}:rate=${frameRate}:duration=3600`;
    
    const args = [
      '-re',
      '-f', 'lavfi',
      '-i', videoInput,
      '-vf', `scale=${width}:${height}`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast', // Fastest encoding
      '-tune', 'zerolatency', // Minimize latency
      '-profile:v', 'baseline', // Most compatible profile
      '-level', '3.1',
      '-b:v', '1000k',
      '-maxrate', '1500k',
      '-bufsize', '2000k',
      '-g', '10', // Keyframe every 10 frames
      '-keyint_min', '10',
      '-sc_threshold', '0', // Disable scene change detection
      '-pix_fmt', 'yuv420p',
      '-an',
      '-f', 'rtp',
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.videoRtpPort}`
    ];
    
    console.log(`🎬 ViewBot ${this.botId}: Using H.264 codec for video`);
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
        // No loop - allow video to end naturally
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
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${this.audioRtpPort}`
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
      
      // Handle video end when FFmpeg exits normally for video files
      if (kind === 'video' && code === 0 && this.config.contentType === 'videoFile' && this.streaming && !this.handlingVideoEnd) {
        console.log(`🎬 ViewBot ${this.botId}: Video file reached end (FFmpeg ${kind} exit)`);
        this.handleVideoEnd();
      }
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
      // No loop - allow video to end naturally
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
    
    // CRITICAL: Check if another bot is already streaming
    const parentService = this.getParentService();
    if (parentService && parentService.currentLiveBot && parentService.currentLiveBot !== this.botId) {
      console.log(`❌❌❌ ViewBot ${this.botId}: BLOCKED - Another bot is already streaming: ${parentService.currentLiveBot}`);
      return { success: false, message: `Another bot is already streaming: ${parentService.currentLiveBot}` };
    }
    
    // Set flag to indicate we're starting
    this.isStartingStream = true;

    if (!this.isConnected) {
      console.log(`❌ ViewBot ${this.botId}: Not connected to server, cannot start streaming`);
      console.log(`💡 ViewBot ${this.botId}: Socket connection status: ${this.socket ? 'exists' : 'missing'}`);
      this.isStartingStream = false;
      return { success: false, message: 'Not connected to server' };
    }
    
    console.log(`✅ ViewBot ${this.botId}: Pre-flight checks passed, proceeding with stream start`);
    
    // CRITICAL: Reset the handlingVideoEnd flag when starting a new stream
    // This ensures the bot can properly handle the next video end
    this.handlingVideoEnd = false;
    
    // SAFETY CHECK: Double-check real streamer protection before attempting to stream
    if (this.parentService && this.parentService.realStreamerActive) {
      console.log(`🚫 ViewBot ${this.botId}: Cannot start - real streamer is active (safety check)`);
      this.isStartingStream = false; // Clear the flag
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
        // Log socket state before emitting
        console.log(`📡 ViewBot ${this.botId}: Socket state before request-to-stream:`);
        console.log(`   - Socket ID: ${this.socket.id}`);
        console.log(`   - Connected: ${this.socket.connected}`);
        console.log(`   - Transport: ${this.socket.io?.engine?.transport?.name || 'unknown'}`);
        
        // Add a small delay to ensure socket is fully ready
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Double-check connection before emitting
        if (!this.socket.connected) {
          console.error(`❌ ViewBot ${this.botId}: Socket not connected, cannot request streaming`);
          throw new Error('Socket not connected');
        }
        
        // CRITICAL FIX: Ensure event is actually sent
        const requestData = {
          streamType: 'viewbot',
          isViewBot: true,
          botId: this.botId,
          username: `ViewBot-${this.botId}`,
          streamConfig: this.config,
          useNewViewBotSystem: true // Flag to indicate using ViewBotClientService
        };
        
        console.log(`📨 ViewBot ${this.botId}: Emitting request-to-stream from socket ${this.socket.id}`);
        console.log(`📨 ViewBot ${this.botId}: Request data:`, JSON.stringify(requestData));
        
        this.socket.emit('request-to-stream', requestData, (ack) => {
          if (ack) {
            console.log(`✅ ViewBot ${this.botId}: Server acknowledged request-to-stream`);
          }
        });
        
        console.log(`📨 ViewBot ${this.botId}: Emitted request-to-stream, waiting for server approval...`);
      }
      
      // REDESIGNED: Since Socket.IO events are broken, use polling to check approval
      // Start polling for approval status
      this.startApprovalPolling();
      
      // Set up stream handling (no real media stream needed)
      this.mediaStream = null; // ViewBots don't need real media streams
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
      
      // Wait for streaming approval with timeout
      const approvalTimeout = setTimeout(() => {
        if (!this.streaming) {
          console.error(`⏰ ViewBot ${this.botId}: Timeout waiting for streaming-approved after 5 seconds`);
          console.error(`📡 ViewBot ${this.botId}: Socket state at timeout:`);
          console.error(`   - Socket ID: ${this.socket?.id}`);
          console.error(`   - Connected: ${this.socket?.connected}`);
          this.lastError = 'Timeout waiting for streaming approval';
        }
      }, 5000);
      
      // Store timeout so we can clear it when approved
      this.approvalTimeout = approvalTimeout;
      
      console.log(`✅ ViewBot ${this.botId}: Streaming request sent via request-to-stream`);
      
      return {
        success: true,
        message: `ViewBot ${this.botId} requested streaming, waiting for approval`,
        streamId: this.botId,
        startTime: this.startTime
      };
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to start streaming:`, error);
      this.lastError = error.message;
      this.isStartingStream = false; // Clear the flag on error
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
    // Update state manager if in simplified mode
    if (stateManager.simplifiedMode && stateManager.getState(this.botId)) {
      stateManager.stopStreaming(this.botId);
    }
    
    if (!this.streaming) {
      return { success: false, message: 'Not currently streaming' };
    }
    
    // Notify ProcessManager that we're stopping
    await processManager.onBotStopped(this.botId);

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
      this.stopRotationCheckTimer(); // Stop the rotation checks
      
      // CRITICAL: Reset the handlingVideoEnd flag when stopping
      // This prevents the bot from being stuck when it rotates back
      this.handlingVideoEnd = false;
      
      // Clear video end timer if it exists
      if (this.videoEndTimer) {
        clearTimeout(this.videoEndTimer);
        this.videoEndTimer = null;
        console.log(`⏱️ ViewBot ${this.botId}: Cleared video end timer`);
      }
      
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
      
      // CRITICAL: Use ProcessManager for guaranteed cleanup
      await processManager.killBotProcesses(this.botId);
      
      // CRITICAL: Clear the GStreamer starting flag to allow next bot to start
      this.gstreamerStarting = false;
      
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
    
    // Clean up Puppeteer resources first (if they exist)
    if (this.page) {
      console.log(`🌐 ViewBot ${this.botId}: Closing Puppeteer page`);
      try {
        await this.page.close();
      } catch (error) {
        console.warn(`⚠️ ViewBot ${this.botId}: Error closing page:`, error.message);
      }
      this.page = null;
    }
    
    if (this.browser) {
      console.log(`🌐 ViewBot ${this.botId}: Closing Puppeteer browser`);
      try {
        // Get all pages and close them first
        const pages = await this.browser.pages();
        await Promise.all(pages.map(page => page.close().catch(() => {})));
        
        // Close the browser
        await this.browser.close();
        
        // Additional cleanup - kill the browser process if it's still running
        if (this.browser.process() && !this.browser.process().killed) {
          this.browser.process().kill('SIGKILL');
        }
      } catch (error) {
        console.warn(`⚠️ ViewBot ${this.botId}: Error closing browser:`, error.message);
        // Force kill the browser process if normal close failed
        try {
          if (this.browser.process() && !this.browser.process().killed) {
            this.browser.process().kill('SIGKILL');
          }
        } catch (killError) {
          console.warn(`⚠️ ViewBot ${this.botId}: Could not force kill browser:`, killError.message);
        }
      }
      this.browser = null;
    }
    
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
    
    // Original cleanup for single process with aggressive killing
    if (this.gstreamerProcess) {
      const pid = this.gstreamerProcess.pid;
      console.log(`🛑 ViewBot ${this.botId}: Killing GStreamer process (PID: ${pid})`);
      
      try {
        // First try SIGTERM
        this.gstreamerProcess.kill('SIGTERM');
        
        // Set timeout for SIGKILL if process doesn't die
        setTimeout(() => {
          if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
            console.log(`⚠️ ViewBot ${this.botId}: Force killing GStreamer with SIGKILL`);
            this.gstreamerProcess.kill('SIGKILL');
            // Also try to kill the process group
            try {
              process.kill(-pid, 'SIGKILL');
            } catch (e) {
              // Process may already be dead
            }
          }
        }, 2000);
      } catch (error) {
        console.log(`⚠️ ViewBot ${this.botId}: Error killing GStreamer:`, error.message);
      }
      
      this.gstreamerProcess = null;
      this.useGStreamer = false;
    }
    
    // Kill any orphaned gst-launch processes for this bot
    try {
      const { execSync } = require('child_process');
      // Kill any gst-launch processes that might be orphaned
      execSync(`pkill -f "gst-launch.*${this.mediaFile}" 2>/dev/null || true`, { stdio: 'ignore' });
    } catch (e) {
      // Ignore errors - process might not exist
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
      // ViewBot rotation info - probability-based
      rotationProbability: this.rotationProbability,
      checkIntervalMin: this.checkIntervalMin,
      checkIntervalMax: this.checkIntervalMax,
      sessionStartTime: this.sessionStartTime
    };
  }

  /**
   * Checks if the bot is streaming
   */
  isStreaming() {
    // Check state manager first if in simplified mode
    if (stateManager.simplifiedMode && stateManager.getState(this.botId)) {
      return stateManager.isStreaming(this.botId) || this.streaming;
    }
    return this.streaming;
  }

  /**
   * Checks if the bot is healthy
   */
  isHealthy() {
    return this.isConnected && !this.lastError;
  }

  /**
   * Start video file playback
   */
  async startVideoPlayback() {
    try {
      const videoPath = this.config.videoFile.startsWith('/') 
        ? this.config.videoFile 
        : path.join('/root/onestreamer/server/videos', this.config.videoFile);
      
      const fs = require('fs');
      if (!fs.existsSync(videoPath)) {
        console.error(`❌ ViewBot ${this.botId}: Video not found: ${videoPath}`);
        return;
      }
      
      console.log(`🎥 ViewBot ${this.botId}: Playing video: ${videoPath}`);
      
      // For now, just log that we're "playing" the video
      // The important part is that we're registered as a streamer
      this.videoPlaying = true;
      
    } catch (error) {
      console.error(`❌ ViewBot ${this.botId}: Failed to start video:`, error);
      this.lastError = error.message;
    }
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
   * Starts rotation check timer with random intervals and probability checks
   */
  startRotationCheckTimer() {
    // Stop any existing timer
    this.stopRotationCheckTimer();
    
    // Check if rotation is enabled through the parent service
    const parentService = this.getParentService();
    if (!parentService || !parentService.rotationEnabled) {
      console.log(`⏸️ ViewBot ${this.botId}: Rotation disabled - no checks will be performed`);
      return;
    }
    
    // Schedule the next check
    this.scheduleNextRotationCheck();
  }
  
  /**
   * Schedules the next rotation probability check
   */
  scheduleNextRotationCheck() {
    const parentService = this.getParentService();
    if (!parentService) return;
    
    // Get intervals from parent service (which loads from config)
    const minInterval = parentService.rotationCheckIntervalMin || 65000;
    const maxInterval = parentService.rotationCheckIntervalMax || 65000;
    
    // Random interval between min and max
    const interval = Math.floor(Math.random() * (maxInterval - minInterval + 1)) + minInterval;
    
    console.log(`⏱️ ViewBot ${this.botId}: Next rotation check in ${interval/1000} seconds (using ${minInterval/1000}-${maxInterval/1000}s range)`);
    
    this.rotationCheckTimer = setTimeout(() => {
      this.performRotationCheck();
    }, interval);
  }
  
  /**
   * Performs a rotation probability check
   */
  performRotationCheck() {
    const parentService = this.getParentService();
    
    // Safety checks
    if (!parentService || !parentService.rotationEnabled || !this.streaming) {
      console.log(`🚫 ViewBot ${this.botId}: Rotation check skipped - conditions not met`);
      return;
    }
    
    // Get probability from parent service (which loads from config)
    const rotationProbability = parentService.rotationProbability || 0.31;
    
    // Roll the dice
    const roll = Math.random();
    console.log(`🎲 ViewBot ${this.botId}: Rotation check - rolled ${(roll * 100).toFixed(2)}% vs ${(rotationProbability * 100).toFixed(2)}% threshold`);
    
    if (roll < rotationProbability) {
      console.log(`✅ ViewBot ${this.botId}: Rotation triggered! Requesting rotation...`);
      this.requestRotation();
    } else {
      console.log(`⏭️ ViewBot ${this.botId}: No rotation this time, scheduling next check`);
      this.scheduleNextRotationCheck();
    }
  }
  
  /**
   * Stops the rotation check timer
   */
  stopRotationCheckTimer() {
    if (this.rotationCheckTimer) {
      clearTimeout(this.rotationCheckTimer);
      this.rotationCheckTimer = null;
      console.log(`⏹️ ViewBot ${this.botId}: Stopped rotation check timer`);
    }
  }
  
  /**
   * Updates the rotation probability
   */
  updateRotationProbability(probability) {
    // Bot now uses parent service values directly, just log the update
    const parentService = this.getParentService();
    if (parentService) {
      console.log(`🎲 ViewBot ${this.botId}: Parent service rotation probability updated to ${(parentService.rotationProbability * 100).toFixed(1)}%`);
    }
  }
  
  /**
   * Updates the rotation check interval
   */
  updateRotationInterval(minInterval, maxInterval) {
    // Bot now uses parent service values directly, restart timer with new intervals
    const parentService = this.getParentService();
    if (parentService) {
      console.log(`⏱️ ViewBot ${this.botId}: Parent service rotation interval updated to ${parentService.rotationCheckIntervalMin/1000}-${parentService.rotationCheckIntervalMax/1000} seconds`);
    }
    
    // If currently streaming, restart the rotation timer with new interval from parent
    if (this.streaming && this.rotationCheckTimer) {
      this.stopRotationCheckTimer();
      this.scheduleNextRotationCheck();
    }
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
   * Gets reference to parent ViewBotClientService
   * CRITICAL FIX: Needed to check rotation enabled status
   */
  getParentService() {
    return this.parentService;
  }

  /**
   * Requests rotation to another ViewBot (used when probability check succeeds)
   */
  requestRotation() {
    this.stopRotationCheckTimer();
    
    // Check if rotation is enabled before requesting rotation
    const parentService = this.getParentService();
    if (!parentService || !parentService.rotationEnabled) {
      console.log(`🚫 ViewBot ${this.botId}: Rotation request ignored - rotation system disabled, continuing to stream`);
      return;
    }
    
    // Use the queue system to prevent race conditions
    console.log(`🔄 ViewBot ${this.botId}: Probability check passed, queueing rotation request`);
    
    if (parentService && parentService.queueRotationRequest) {
      // Queue the rotation request instead of calling directly
      const result = parentService.queueRotationRequest(this.botId, 'probability-triggered');
      
      if (result.success) {
        console.log(`✅ ViewBot ${this.botId}: Rotation request queued successfully`);
      } else {
        console.log(`⚠️ ViewBot ${this.botId}: Rotation request rejected: ${result.message}`);
        // Schedule next check if request was rejected
        if (this.streaming) {
          this.scheduleNextRotationCheck();
        }
      }
    } else {
      console.error(`❌ ViewBot ${this.botId}: Cannot queue rotation - parent service handler not available`);
      // Continue streaming and schedule next check
      if (this.streaming) {
        this.scheduleNextRotationCheck();
      }
    }
  }
  
  /**
   * Gets video duration using ffprobe
   */
  async getVideoDuration(videoPath) {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ]);
      
      let duration = '';
      ffprobe.stdout.on('data', (data) => {
        duration += data.toString();
      });
      
      ffprobe.on('close', (code) => {
        if (code === 0 && duration) {
          const durationSeconds = parseFloat(duration.trim());
          console.log(`⏱️ ViewBot ${this.botId}: Video duration: ${durationSeconds} seconds`);
          this.videoDuration = durationSeconds;
          
          // Set up a fallback timer for video end
          if (durationSeconds > 0 && !isNaN(durationSeconds)) {
            this.videoEndTimer = setTimeout(() => {
              console.log(`⏰ ViewBot ${this.botId}: Video duration timer expired, triggering rotation`);
              this.handleVideoEnd();
            }, (durationSeconds * 1000) + 2000); // Add 2 second buffer
          }
        } else {
          console.warn(`⚠️ ViewBot ${this.botId}: Could not determine video duration`);
        }
        resolve();
      });
      
      ffprobe.on('error', (error) => {
        console.error(`❌ ViewBot ${this.botId}: ffprobe error:`, error);
        resolve();
      });
    });
  }
  
  /**
   * Handles video end event (for video file streaming)
   */
  async handleVideoEnd() {
    // Prevent multiple calls
    if (this.handlingVideoEnd || this.stopping) {
      console.log(`⚠️ ViewBot ${this.botId}: Already handling video end or stopping`);
      return;
    }
    this.handlingVideoEnd = true;
    
    console.log(`🎬 ViewBot ${this.botId}: Video file has ended - triggering rotation`);
    
    // First, clean up all running processes to prevent crashes
    console.log(`🧹 ViewBot ${this.botId}: Cleaning up before rotation...`);
    
    // Clear all timers
    if (this.videoEndTimer) {
      clearTimeout(this.videoEndTimer);
      this.videoEndTimer = null;
    }
    
    if (this.pipelineHealthCheckTimer) {
      clearInterval(this.pipelineHealthCheckTimer);
      this.pipelineHealthCheckTimer = null;
    }
    
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    
    if (this.videoDurationTimer) {
      clearTimeout(this.videoDurationTimer);
      this.videoDurationTimer = null;
    }
    
    // CRITICAL: Only call cleanup once - killAllProcesses is redundant
    // cleanupGStreamerProcesses already handles killing with SIGTERM then SIGKILL
    this.cleanupGStreamerProcesses();
    
    // Wait for cleanup to complete (2.5s for SIGKILL + reference clearing)
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const parentService = this.getParentService();
    if (parentService && parentService.handleVideoEnd) {
      console.log(`🔄 ViewBot ${this.botId}: Requesting rotation from parent service`);
      parentService.handleVideoEnd(this.botId);
    } else {
      console.warn(`⚠️ ViewBot ${this.botId}: No parent service, attempting direct rotation`);
      // Try to trigger rotation directly
      if (parentService && parentService.requestRotation) {
        parentService.requestRotation();
      } else {
        // Last resort: stop streaming
        await this.stopStreaming();
      }
    }
    
    // Reset flag after a delay to allow next rotation
    setTimeout(() => {
      this.handlingVideoEnd = false;
    }, 2000);
  }
}

module.exports = ViewBotClientService;

