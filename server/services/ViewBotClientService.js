const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const io = require('socket.io-client');
const ViewBotDatabaseService = require('./ViewBotDatabaseService');
const ViewBotGStreamerService = require('./ViewBotGStreamerService');
const processManager = require('./ProcessManager');
const stateManager = require('./ViewBotStateManager');
const ViewBotInstance = require('./viewbot/ViewBotInstance');
const { selectWeightedBot } = require('./viewbot/botSelection');
const BotCooldownTracker = require('./viewbot/BotCooldownTracker');

const logger = require('../bootstrap/logger').child({ svc: 'ViewBotClientService' });

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
    
    logger.debug(`🤖 VIEWBOT CLIENT: Service initialized with server URL: ${this.serverUrl}`);
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
    this.rotationEnabled = false; // SimpleViewBotRotation handles rotation centrally; this client doesn't drive its own loop
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
    
    // Cooldown system for variety in rotation (encapsulated in BotCooldownTracker)
    this.cooldownTracker = new BotCooldownTracker({
      windowMs: 2 * 60 * 60 * 1000, // 2 hours
      decayFactor: 0.5,             // reduce probability 50% per play in window
      minProbability: 0.1,          // floor at 10% of original
      logger,
    });

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
    
    logger.debug('🤖 VIEWBOT CLIENT: Service initialized with cooldown system and rotation queue');
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
        logger.debug(`📄 Loaded rotation config: ${(this.rotationProbability * 100).toFixed(1)}% probability, ${this.rotationCheckIntervalMin/1000}-${this.rotationCheckIntervalMax/1000}s intervals`);
      }
    } catch (error) {
      logger.debug('⚠️ Could not load rotation config, using defaults:', error.message);
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
      logger.debug(`💾 Saved rotation config to file`);
    } catch (error) {
      logger.error('❌ Could not save rotation config:', error.message);
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
    
    logger.debug(`🔄 Updated rotation settings: ${(this.rotationProbability * 100).toFixed(1)}% probability, ${this.rotationCheckIntervalMin/1000}-${this.rotationCheckIntervalMax/1000}s intervals`);
    
    // Save to config file
    this.saveRotationConfig();
    
    // Restart rotation timers with new intervals if any bots are active.
    // `this.activeBots` is the canonical map (PR 11.1's split surfaced three
    // typos here: the previous `this.viewBots` lookup TypeError'd, masking
    // both the broken `this.startRotationCheckTimer(bot.botId)` call below
    // — that method lives on ViewBotInstance and takes no args — and a
    // truthy-function-reference filter `bot.isStreaming` that never invoked
    // the method. `activeBots` can also contain placeholder objects from
    // `restoreViewBots`, hence the `typeof === 'function'` guard matching
    // the dominant pattern at lines 1514/1562 below.
    const activeBots = Array.from(this.activeBots.values()).filter(
      (bot) => (typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming)
    );
    if (activeBots.length > 0) {
      logger.debug('🔄 Restarting rotation timers with new settings...');
      activeBots.forEach(bot => {
        if (bot.rotationCheckTimer) {
          clearTimeout(bot.rotationCheckTimer);
          bot.startRotationCheckTimer();
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
        logger.debug('🔍 VIEWBOT CLIENT: Initial presence check...');
        // Clear initialization flag
        this.initializationInProgress = false;
        // Only maintain presence if no bot is currently live
        if (!this.currentLiveBot) {
          this.maintainViewBotPresence();
        } else {
          logger.debug(`ℹ️ VIEWBOT CLIENT: Skipping presence check - ${this.currentLiveBot} is already live`);
        }
      }, 10000); // 10 second delay for bots to initialize
      
      logger.debug('✅ VIEWBOT CLIENT: Service fully initialized with database persistence');
    } catch (error) {
      logger.error('❌ VIEWBOT CLIENT: Failed to initialize with database:', error);
      logger.debug('⚠️ VIEWBOT CLIENT: Continuing without persistence (memory-only mode)');
    }
  }

  /**
   * Detect the correct FFmpeg path for this system
   */
  async detectFFmpegPath() {
    const ffmpegCheck = await ViewBotClientService.checkFFmpegAvailability();
    if (ffmpegCheck.available) {
      this.ffmpegPath = ffmpegCheck.path;
      logger.debug(`✅ VIEWBOT CLIENT: Detected FFmpeg at ${this.ffmpegPath}`);
    } else {
      logger.error(`❌ VIEWBOT CLIENT: FFmpeg not found - ViewBot streaming will not work`);
      logger.error(`📋 VIEWBOT CLIENT: Please install FFmpeg and add it to PATH`);
    }
  }

  /**
   * Restore system state from database
   */
  async restoreSystemState() {
    if (!this.dbInitialized) {
      logger.debug('⚠️ VIEWBOT CLIENT: Database not initialized, skipping system state restore');
      return;
    }
    
    try {
      logger.debug('📊 VIEWBOT CLIENT: Loading system state from database...');
      const state = await this.dbService.loadSystemState();
      logger.debug('📊 VIEWBOT CLIENT: Loaded state:', state);
      
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
      
      logger.debug(`🔄 VIEWBOT CLIENT: Restored system state - rotation: ${this.rotationEnabled}, live bot: ${this.currentLiveBot}`);
      
      // CRITICAL FIX: Don't restart rotation here - let restoreViewBots handle it
      // This prevents race conditions during startup
      
      // Start periodic error cleanup
      setInterval(() => {
        this.cleanupStaleErrors();
      }, 60000); // Clean up every 60 seconds
      
    } catch (error) {
      logger.error('❌ VIEWBOT CLIENT: Failed to restore system state:', error);
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
          logger.debug(`🧹 Clearing stale error for ViewBot ${botId}: ${bot.lastError}`);
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
      logger.debug(`📊 VIEWBOT CLIENT: Loading ${storedBots.length} ViewBot configurations from database...`);
      
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
      
      logger.debug(`✅ VIEWBOT CLIENT: Restored ${this.activeBots.size} ViewBots from database`);
      
      // CRITICAL: Start rotation AFTER all bots are restored
      // This prevents race conditions where multiple bots try to stream
      if (this.rotationEnabled && !this.realStreamerActive) {
        logger.debug(`🔄 VIEWBOT CLIENT: Starting rotation system after ViewBot restoration`);
        // Give bots time to fully initialize their connections
        setTimeout(() => {
          // Clear initialization flag before starting rotation
          this.initializationInProgress = false;
          this.restartRotationAfterRestore();
        }, 3000);
      }
    } catch (error) {
      logger.error('❌ VIEWBOT CLIENT: Failed to restore ViewBots:', error);
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
      logger.error('❌ VIEWBOT CLIENT: Failed to save system state:', error);
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
          logger.debug(`✅ VIEWBOT CLIENT: Found FFmpeg at ${ffmpegPath}`);
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
    logger.debug(`📊 VIEWBOT CLIENT: Current active bots: ${this.activeBots.size}`);
    
    // Optional: Add a reasonable limit to prevent resource exhaustion
    const MAX_BOTS = 100; // Configurable limit
    if (this.activeBots.size >= MAX_BOTS) {
      logger.error(`❌ VIEWBOT CLIENT: Maximum number of bots (${MAX_BOTS}) reached`);
      return {
        success: false,
        message: `Maximum number of ViewBots (${MAX_BOTS}) reached. Please remove some bots before creating new ones.`
      };
    }

    // Check if FFmpeg is available before creating ViewBot
    const ffmpegCheck = await ViewBotClientService.checkFFmpegAvailability();
    if (!ffmpegCheck.available) {
      logger.error(`❌ VIEWBOT CLIENT: FFmpeg not available: ${ffmpegCheck.error}`);
      if (ffmpegCheck.instructions) {
        logger.error(`📋 VIEWBOT CLIENT: Installation instructions:`);
        ffmpegCheck.instructions.forEach(instruction => {
          logger.error(`   ${instruction}`);
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
        logger.debug(`🎬 VIEWBOT CLIENT: Using GSTREAMER for video file streaming (default)`);
      } else {
        logger.debug(`🎬 VIEWBOT CLIENT: Using FFMPEG for video file streaming (explicitly requested)`);
      }
    }
    
    // Convert streamDuration (minutes) to timeAllotment (milliseconds) if provided
    if (config.streamDuration && config.streamDuration > 0) {
      botConfig.timeAllotment = config.streamDuration * 60 * 1000; // Convert minutes to milliseconds
      logger.debug(`⏱️ VIEWBOT CLIENT: Setting time allotment to ${config.streamDuration} minutes`);
    }

    try {
      logger.debug(`🤖 VIEWBOT CLIENT: Creating bot ${botId} with config:`, botConfig);
      
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
          logger.debug(`💾 VIEWBOT CLIENT: Saved ViewBot ${botId} to database`);
        } catch (dbError) {
          logger.error(`⚠️ VIEWBOT CLIENT: Failed to save ViewBot ${botId} to database:`, dbError);
          // Continue without database - bot is still created in memory
        }
      }
      
      logger.debug(`✅ VIEWBOT CLIENT: Bot ${botId} created successfully`);
      
      return {
        success: true,
        message: `ViewBot ${botId} created`,
        botId,
        config: botConfig,
        status: bot.getStatus()
      };
    } catch (error) {
      logger.error(`❌ VIEWBOT CLIENT: Failed to create bot ${botId}:`, error);
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
      logger.debug(`🔄 VIEWBOT CLIENT: Creating real instance for placeholder ${botId}...`);
      
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
      
      logger.debug(`✅ VIEWBOT CLIENT: Created real instance for ${botId}`);
    }
    
    // If already connected, return success
    if (bot.isConnected) {
      return { success: true };
    }
    
    // Initialize connection
    logger.debug(`🔌 VIEWBOT CLIENT: Connecting ${botId}...`);
    try {
      await bot.initialize();
      logger.debug(`✅ VIEWBOT CLIENT: Connected ViewBot ${botId}`);
      return { success: true };
    } catch (error) {
      logger.error(`❌ VIEWBOT CLIENT: Failed to connect ${botId}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Starts streaming for a specific bot (integrates with rotation system)
   */
  async startBotStreaming(botId) {
    logger.debug(`🎯 Starting ViewBot streaming for: ${botId.substring(0, 12)}...`);
    
    const bot = this.activeBots.get(botId);
    if (!bot) {
      logger.debug(`❌ ViewBot ${botId} not found in activeBots map`);
      logger.debug(`📊 Available bots: ${Array.from(this.activeBots.keys()).map(id => id.substring(0, 12)).join(', ')}`);
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
      logger.debug(`❌ ViewBot ${botId} disappeared after connection`);
      return { success: false, message: `Bot ${botId} not found after connection` };
    }

    // Validate real streamer status first
    logger.debug(`🔍 Validating real streamer status before starting ViewBot...`);
    this.validateRealStreamerStatus();
    
    // Check if real streamer protection is active
    if (this.realStreamerActive) {
      logger.debug(`🚫 ViewBot ${botId}: Blocked by real streamer protection`);
      return { success: false, message: 'Cannot start ViewBot - real streamer is active' };
    }
    
    logger.debug(`✅ ViewBot ${botId}: Real streamer check passed, proceeding with start`);

    try {
      // If rotation is enabled, stop current live bot first
      if (this.rotationEnabled && this.currentLiveBot && this.currentLiveBot !== botId) {
        const currentBot = this.activeBots.get(this.currentLiveBot);
        // Check if it's a real bot with methods, not a placeholder
        if (currentBot && currentBot.streaming && typeof currentBot.stopStreaming === 'function') {
          logger.debug(`🔄 Stopping current live bot ${this.currentLiveBot} for manual start of ${botId}`);
          await currentBot.stopStreaming();
        } else if (currentBot && currentBot.streaming) {
          logger.debug(`⚠️ Current bot ${this.currentLiveBot} is a placeholder, marking as not streaming`);
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
          logger.debug(`🎯 Manual start: Updated current live bot to ${botId} with probability-based rotation`);
        } else {
          logger.debug(`⏸️ Manual start: ViewBot ${botId} started with rotation disabled - will stream indefinitely`);
        }
        
        logger.debug(`🎬 VIEWBOT CLIENT: Bot ${botId} streaming started manually`);
      }
      
      return result;
    } catch (error) {
      logger.error(`❌ VIEWBOT CLIENT: Failed to start streaming for bot ${botId}:`, error);
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
          logger.debug(`🔄 Manual stop: Clearing current live bot ${botId}`);
          this.currentLiveBot = null;
          
          // If rotation is enabled, try to start another ViewBot automatically
          const availableBots = Array.from(this.activeBots.values()).filter(b => 
            b.botId !== botId && b.isConnected && !b.streaming
          );
          
          if (availableBots.length > 0) {
            const nextBot = this.selectViewBotWithCooldown(availableBots);
            logger.debug(`🔄 Auto-starting next ViewBot: ${nextBot.botId}`);
            
            // Start the next bot with a short delay
            setTimeout(async () => {
              try {
                await nextBot.startStreaming();
                // Apply cooldown to the bot that just started
                this.applyBotCooldown(nextBot.botId);
                // Start rotation check timer for the next bot
                nextBot.startRotationCheckTimer();
                logger.debug(`✅ Auto-rotation completed: ${botId} → ${nextBot.botId} (probability-based rotation)`)
                this.currentLiveBot = nextBot.botId;
      this.currentLiveBotSetTime = Date.now();
              } catch (error) {
                logger.error(`❌ Auto-rotation failed:`, error);
              }
            }, 1000);
          }
        }
        
        // Clear streamer if this bot was the active one
        const currentStreamer = this.streamService.getCurrentStreamer();
        if (currentStreamer === botId) {
          this.streamService.clearStreamer();
          logger.debug(`🎬 VIEWBOT CLIENT: Bot ${botId} stepped down as active streamer`);
        }
      }
      
      return result;
    } catch (error) {
      logger.error(`❌ VIEWBOT CLIENT: Failed to stop streaming for bot ${botId}:`, error);
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
        logger.debug(`🗑️ VIEWBOT CLIENT: Removing placeholder ${botId}`);
      }
      this.activeBots.delete(botId);
      
      // Only remove from database if explicitly requested
      // This preserves viewbot configurations across disconnections
      if (this.dbInitialized && deleteFromDatabase) {
        try {
          await this.dbService.deleteViewBot(botId);
          logger.debug(`💾 VIEWBOT CLIENT: Removed ViewBot ${botId} from database`);
        } catch (dbError) {
          logger.error(`⚠️ VIEWBOT CLIENT: Failed to remove ViewBot ${botId} from database:`, dbError);
        }
      } else if (!deleteFromDatabase) {
        logger.debug(`📊 VIEWBOT CLIENT: Bot ${botId} disconnected but preserved in database`);
      }
      
      // Clear streamer if this bot was the active one
      const currentStreamer = this.streamService.getCurrentStreamer();
      if (currentStreamer === botId) {
        this.streamService.clearStreamer();
      }
      
      logger.debug(`🗑️ VIEWBOT CLIENT: Bot ${botId} destroyed`);
      
      return {
        success: true,
        message: `Bot ${botId} destroyed`
      };
    } catch (error) {
      logger.error(`❌ VIEWBOT CLIENT: Failed to destroy bot ${botId}:`, error);
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
      logger.error(`❌ VIEWBOT CLIENT: Failed to update config for bot ${botId}:`, error);
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
            logger.debug(`💾 VIEWBOT CLIENT: Saved ViewBot ${botId} to database with name "${name}"`);
          } else {
            logger.debug(`💾 VIEWBOT CLIENT: Updated name for ViewBot ${botId} in database`);
          }
        } catch (dbError) {
          logger.error(`⚠️ VIEWBOT CLIENT: Failed to update ViewBot name in database:`, dbError);
        }
      }

      return {
        success: true,
        message: `Bot ${botId} renamed to "${name}"`,
        name
      };
    } catch (error) {
      logger.error(`❌ VIEWBOT CLIENT: Failed to update name for bot ${botId}:`, error);
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

  // Lifecycle entry point — uniform name across services for the bootstrap
  // shutdown loop (PR 1.2). Delegates to the existing teardown.
  async stop() {
    await this.cleanup();
  }

  /**
   * Complete cleanup for server shutdown
   */
  async cleanup() {
    logger.debug('🧹 ViewBotClientService: Starting complete cleanup...');
    
    try {
      // Stop rotation timer
      this.stopViewBotRotation();
      
      // Stop auto-validation
      this.stopAutoValidation();
      
      // Stop all GStreamer processes
      if (this.gstreamerService) {
        logger.debug('   Stopping GStreamer service...');
        await this.gstreamerService.stopAll();
      }
      
      // Destroy all bots (this will close individual Puppeteer instances)
      logger.debug('   Destroying all ViewBot clients...');
      await this.destroyAllBots();
      
      // Kill any orphaned Puppeteer processes
      await this.killOrphanedPuppeteerProcesses();
      
      logger.debug('✅ ViewBotClientService: Cleanup complete');
    } catch (error) {
      logger.error('❌ ViewBotClientService: Error during cleanup:', error);
    }
  }

  /**
   * Kill any orphaned Puppeteer browser processes
   */
  async killOrphanedPuppeteerProcesses() {
    logger.debug('🧹 ViewBotClientService: Checking for orphaned Puppeteer processes...');
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
      logger.debug('✅ ViewBotClientService: Orphaned Puppeteer processes cleaned up');
    } catch (error) {
      logger.warn('⚠️ ViewBotClientService: Could not clean up Puppeteer processes:', error.message);
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
    logger.debug(`🔄 ViewBot rotation system ${enabled ? 'ENABLED' : 'DISABLED'}`);
    
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
          logger.debug(`⏸️ Stopped rotation checks for ViewBot ${botId} - rotation disabled`);
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
    logger.debug(`🔄 VIEWBOT CLIENT: Checking rotation restart conditions`);
    
    // CRITICAL: Only start ONE bot for rotation
    // Don't connect multiple bots at once
    
    // Check if there's a current live bot that needs to continue
    if (this.currentLiveBot) {
      logger.debug(`🔄 VIEWBOT CLIENT: Found previous bot: ${this.currentLiveBot}`);
      
      // Get the bot (might be a placeholder)
      let bot = this.activeBots.get(this.currentLiveBot);
      if (!bot) {
        logger.debug(`🔄 VIEWBOT CLIENT: Previous bot not found, starting fresh`);
        this.currentLiveBot = null;
        await this.startViewBotRotation();
        return;
      }
      
      // Ensure it's connected (converts placeholder to real instance)
      const connectResult = await this.ensureBotConnected(this.currentLiveBot);
      if (!connectResult.success) {
        logger.error(`❌ Failed to connect previous bot ${this.currentLiveBot}`);
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
          logger.debug(`🎬 VIEWBOT CLIENT: Detected existing GStreamer processes running`);
        }
      } catch (e) {
        // No processes found
        gstreamerRunning = false;
      }
      
      if (gstreamerRunning) {
        // GStreamer is already running - just set up the bot state properly
        logger.debug(`✅ VIEWBOT CLIENT: Media already streaming - setting up rotation system`);
        
        // Mark bot as streaming
        bot.streaming = true;
        bot.isStartingStream = false;
        
        // Start rotation check timer
        bot.startRotationCheckTimer();
        
        // Set up failsafe timer if video file is configured
        if (bot.config && bot.config.videoFile) {
          await bot.setupDurationBasedRotation(bot.config.videoFile);
        }
        
        logger.debug(`✅ VIEWBOT CLIENT: Rotation system restored for ${this.currentLiveBot}`);
      } else {
        // No media running - start streaming normally
        try {
          logger.debug(`🎬 VIEWBOT CLIENT: Starting fresh stream for ${this.currentLiveBot}`);
          const result = await bot.startStreaming();
          
          if (result.success) {
            // Start rotation check timer after successful start
            bot.startRotationCheckTimer();
            logger.debug(`✅ VIEWBOT CLIENT: Stream started with rotation timer`);
          } else if (!result.success && result.message === 'Already streaming') {
            // Bot thinks it's streaming but GStreamer isn't running - fix the state
            logger.debug(`🔧 VIEWBOT CLIENT: Fixing inconsistent state - bot thinks it's streaming but it's not`);
            bot.streaming = false;
            bot.isStartingStream = false;
            
            // Try starting again
            const retryResult = await bot.startStreaming();
            if (retryResult.success) {
              bot.startRotationCheckTimer();
              logger.debug(`✅ VIEWBOT CLIENT: Stream started after state fix`);
            }
          }
        } catch (error) {
          logger.error(`❌ VIEWBOT CLIENT: Failed to restart ${this.currentLiveBot}:`, error);
          this.currentLiveBot = null;
          await this.startViewBotRotation();
        }
      }
    } else {
      logger.debug(`🔄 VIEWBOT CLIENT: No previous bot, starting fresh rotation`);
      await this.startViewBotRotation();
    }
  }

  /**
   * Starts the ViewBot rotation system by selecting and starting the first ViewBot
   */
  async startViewBotRotation() {
    // CRITICAL: Don't start rotation during initialization
    if (this.initializationInProgress) {
      logger.debug(`⏳ ViewBot rotation deferred - initialization in progress`);
      return;
    }
    
    // CRITICAL: Prevent concurrent rotation starts
    if (this.currentLiveBot) {
      logger.debug(`⚠️ ViewBot rotation already active with ${this.currentLiveBot} - skipping`);
      return;
    }
    
    if (this.realStreamerActive) {
      logger.debug(`🛑 Cannot start ViewBot rotation - real streamer is active`);
      return;
    }

    // Find available ViewBots (including placeholders)
    const availableBots = Array.from(this.activeBots.values()).filter(bot => 
      !bot.streaming && (bot.isConnected || bot.lazyLoad || bot.isPlaceholder)
    );

    if (availableBots.length === 0) {
      logger.debug(`⚠️ No available ViewBots for rotation`);
      return;
    }

    // No need to reset anything for probability-based rotation

    // Select a ViewBot with weighted probability based on cooldowns
    let firstBot = this.selectViewBotWithCooldown(availableBots);
    
    // Ensure bot is connected (handle placeholders and lazy loading)
    if (!firstBot.isConnected || firstBot.isPlaceholder) {
      logger.debug(`🔌 Connecting bot ${firstBot.botId} for rotation start...`);
      const connectResult = await this.ensureBotConnected(firstBot.botId);
      if (!connectResult.success) {
        logger.error(`❌ Failed to connect bot ${firstBot.botId} for rotation start`);
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
      logger.debug(`🔄 ViewBot rotation started with: ${firstBot.botId}`);
    } catch (error) {
      logger.error(`❌ Failed to start initial ViewBot rotation:`, error);
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
    logger.debug(`👤 Real streamer status: ${isActive ? 'ACTIVE' : 'INACTIVE'} (was: ${previousStatus ? 'ACTIVE' : 'INACTIVE'})`);
    
    if (isActive) {
      // Clear any pending takeover timer
      if (this.pendingTakeoverTimer) {
        clearTimeout(this.pendingTakeoverTimer);
        this.pendingTakeoverTimer = null;
        logger.debug(`🚫 Cancelled pending ViewBot takeover - real streamer is active`);
      }
      
      if (this.currentLiveBot) {
        // Stop current ViewBot if a real streamer becomes active
        logger.debug(`🛑 Real streamer active - stopping ViewBot ${this.currentLiveBot}`);
        this.stopViewBotRotation();
      }
    } else {
      // Real streamer disconnected - schedule ViewBot takeover after delay
      logger.debug(`🔍 Checking takeover conditions: rotationEnabled=${this.rotationEnabled}, currentLiveBot=${this.currentLiveBot}`);
      
      // Only proceed if status actually changed from true to false
      if (previousStatus === true && isActive === false) {
        logger.debug(`📉 Real streamer status changed from ACTIVE to INACTIVE`);
        
        if (this.rotationEnabled) {
          if (!this.currentLiveBot) {
            logger.debug(`✅ No ViewBot currently live - scheduling takeover`);
            this.scheduleViewBotTakeover();
          } else {
            logger.debug(`ℹ️ ViewBot ${this.currentLiveBot} is already live - no takeover needed`);
          }
        } else {
          logger.debug(`❌ Rotation is disabled - no ViewBot takeover`);
        }
      } else if (previousStatus === false && isActive === false) {
        logger.debug(`ℹ️ Real streamer was already inactive - no action needed`);
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
      logger.debug(`🔍 VALIDATION: No active streamer found, clearing real streamer flag`);
      this.realStreamerActive = false;
      return;
    }

    // Check if current streamer is a ViewBot
    const isViewbot = this.viewbotService ? this.viewbotService.isViewbotStream(currentStreamer) : 
                     currentStreamer.includes('viewbot-') || currentStreamer.includes('bot-');
    
    if (isViewbot && this.realStreamerActive) {
      // Current streamer is a ViewBot but real streamer flag is active - this is inconsistent
      logger.debug(`🔍 VALIDATION: Current streamer ${currentStreamer} is ViewBot, clearing real streamer flag`);
      this.realStreamerActive = false;
      return;
    }

    // If we get here and realStreamerActive is true, there should be a real user streaming
    logger.debug(`🔍 VALIDATION: Real streamer flag validated - current streamer: ${currentStreamer.substring(0, 12)}...`);
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
    
    logger.debug(`🔍 VALIDATION: Auto-validation started (30s intervals)`);
  }

  /**
   * Stop auto-validation timer
   */
  stopAutoValidation() {
    if (this.validationTimer) {
      clearInterval(this.validationTimer);
      this.validationTimer = null;
      logger.debug(`🔍 VALIDATION: Auto-validation stopped`);
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
      logger.debug('⏳ PRESENCE: Already starting emergency bot, skipping duplicate attempt');
      return;
    }
    
    // Check if any ViewBot is currently live
    if (this.currentLiveBot) {
      // Verify the bot is actually streaming
      const bot = this.activeBots.get(this.currentLiveBot);
      
      // Debug logging to understand the state
      if (!bot) {
        logger.debug(`🔍 PRESENCE CHECK: currentLiveBot=${this.currentLiveBot} - bot not found in activeBots`);
        logger.debug(`🔧 PRESENCE: Clearing non-existent currentLiveBot: ${this.currentLiveBot}`);
        this.currentLiveBot = null;
      } else {
        const isStreaming = typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming;
        const isStarting = bot.isStartingStream;
        logger.debug(`🔍 PRESENCE CHECK: currentLiveBot=${this.currentLiveBot}, streaming=${isStreaming}, isStartingStream=${isStarting}`);
        
        if (isStreaming || isStarting) {
          // All good - ViewBot is live or starting
          logger.debug(`✅ PRESENCE: Bot ${this.currentLiveBot} is ${isStreaming ? 'streaming' : 'starting'} - no action needed`);
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
            logger.debug(`🔧 PRESENCE: Clearing non-streaming currentLiveBot after ${gracePeriod/1000}s timeout: ${this.currentLiveBot}`);
            this.currentLiveBot = null;
            this.currentLiveBotSetTime = null;
          } else {
            logger.debug(`⏳ PRESENCE: Bot ${this.currentLiveBot} not streaming yet, waiting ${(gracePeriod - timeSinceSet)/1000}s more`);
            return;
          }
        }
      }
    }
    
    // CRITICAL: Check if rotation is already being processed
    if (this.rotationLock) {
      logger.debug(`🔒 PRESENCE: Rotation is already being processed - skipping presence maintenance`);
      return;
    }
    
    // Also check if there's a pending rotation in the queue
    if (this.rotationQueue.length > 0) {
      logger.debug(`📋 PRESENCE: Rotation queue has ${this.rotationQueue.length} pending requests - skipping presence maintenance`);
      return;
    }
    
    // At this point: rotation enabled, no real streamer, no ViewBot streaming
    logger.debug('⚠️ PRESENCE: No one is streaming but rotation is enabled - need emergency start');
    
    // Check if we have available bots (including lazy-loaded ones)
    const availableBots = Array.from(this.activeBots.values()).filter(bot => {
      const isStreaming = typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming;
      return !isStreaming && (bot.isConnected || bot.lazyLoad);
    });
    
    if (availableBots.length === 0) {
      logger.debug('❌ PRESENCE: No available ViewBots to start');
      return;
    }
    
    // CRITICAL FIX: Don't bypass rotation system with startViewBotRotation()
    // Instead, pick a random bot and start it directly, then let rotation timers handle switching
    logger.debug('🚀 PRESENCE: Emergency start - picking a random bot to maintain presence');
    
    // CRITICAL: Only pick one bot and set it as current immediately to prevent duplicates
    const randomBot = availableBots[Math.floor(Math.random() * availableBots.length)];
    
    // Set as current IMMEDIATELY to prevent other presence checks from starting another bot
    this.currentLiveBot = randomBot.botId;
    this.currentLiveBotSetTime = Date.now();
    logger.debug(`🔒 PRESENCE: Pre-emptively set currentLiveBot to ${randomBot.botId} to prevent duplicates`);
    
    // Set flag to prevent duplicate starts
    this.isStartingEmergencyBot = true;
    
    try {
      // Start the bot streaming using the service method (which handles all the setup)
      logger.debug(`🎯 PRESENCE: Starting bot ${randomBot.botId} for emergency presence`);
      const result = await this.startBotStreaming(randomBot.botId);
      
      if (result && result.success) {
        logger.debug(`✅ PRESENCE: Emergency bot ${randomBot.botId} started successfully`);
      } else {
        logger.debug(`❌ PRESENCE: Failed to start emergency bot ${randomBot.botId}:`, result?.message);
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
      logger.debug(`🔄 Rotation request from ${botId} ignored - rotation disabled`);
      return { success: false, message: 'Rotation is disabled' };
    }
    
    if (this.realStreamerActive) {
      logger.debug(`🔄 Rotation request from ${botId} ignored - real streamer active`);
      return { success: false, message: 'Real streamer is active' };
    }
    
    // Check if this bot already has a pending request
    const existingRequest = this.rotationQueue.find(req => req.botId === botId);
    if (existingRequest) {
      logger.debug(`⏳ ViewBot ${botId}: Rotation request already queued`);
      return { success: false, message: 'Request already queued' };
    }
    
    // Add to queue with timestamp
    const request = {
      botId,
      reason,
      timestamp: Date.now()
    };
    
    this.rotationQueue.push(request);
    logger.debug(`📥 Queued rotation request from ${botId} (${reason}). Queue size: ${this.rotationQueue.length}`);
    
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
      logger.debug(`🔒 Rotation processor locked - deferring queue processing`);
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
      logger.debug(`📭 Rotation queue empty - nothing to process`);
      return;
    }
    
    logger.debug(`🔄 Processing ${requests.length} rotation requests`);
    
    // Filter out requests from bots that are no longer streaming
    const validRequests = requests.filter(req => {
      const bot = this.activeBots.get(req.botId);
      return bot && bot.streaming;
    });
    
    if (validRequests.length === 0) {
      logger.debug(`❌ No valid rotation requests after filtering`);
      return;
    }
    
    // Select ONE request to process (could use various strategies)
    // Strategy: Use the first valid request (FIFO)
    const selectedRequest = validRequests[0];
    
    logger.debug(`✅ Selected rotation request from ${selectedRequest.botId} (${selectedRequest.reason})`);
    logger.debug(`⏭️ Discarding ${validRequests.length - 1} other requests`);
    
    // Acquire lock and process the selected rotation
    this.rotationLock = true;
    
    try {
      await this.handleRotationRequest(selectedRequest.botId, selectedRequest.reason);
    } catch (error) {
      logger.error(`❌ Rotation processing failed:`, error);
    } finally {
      // Release lock
      this.rotationLock = false;
      logger.debug(`🔓 Rotation lock released`);
      
      // Check if more requests came in while processing
      if (this.rotationQueue.length > 0 && !this.rotationProcessTimer) {
        logger.debug(`📬 New requests in queue - scheduling next processing`);
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
    logger.debug(`🎬 ViewBotClientService: Handling rotation for bot ${botId} after video end`);
    
    // Queue the rotation request to go through the normal rotation process
    this.queueRotationRequest(botId, 'video-end');
  }

  /**
   * Handles ViewBot rotation requests (now called only from processRotationQueue)
   */
  async handleRotationRequest(botId, reason) {
    if (!this.rotationEnabled) {
      logger.debug(`🔄 Rotation request from ${botId} ignored - rotation disabled`);
      return { success: false, message: 'Rotation is disabled' };
    }

    if (this.realStreamerActive) {
      logger.debug(`🔄 Rotation request from ${botId} ignored - real streamer active`);
      return { success: false, message: 'Real streamer is active' };
    }

    logger.debug(`🔄 Processing rotation request from ${botId} (reason: ${reason})`);
    
    // Clean up any orphaned GStreamer processes before rotation
    try {
      const { execSync } = require('child_process');
      const orphanedCount = execSync('pgrep -f gst-launch | wc -l', { encoding: 'utf8' }).trim();
      if (parseInt(orphanedCount) > 1) {
        logger.debug(`🧹 Cleaning up ${orphanedCount} orphaned GStreamer processes before rotation`);
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
      logger.debug(`🔄 No available ViewBots for rotation - stopping rotation`);
      this.currentLiveBot = null;
      return { success: false, message: 'No available ViewBots for rotation' };
    }

    // Select a ViewBot with weighted probability based on cooldowns
    let nextBot = this.selectViewBotWithCooldown(availableBots);
    
    // Ensure the selected bot is connected (handle placeholders and lazy loading)
    if (!nextBot.isConnected || nextBot.isPlaceholder) {
      logger.debug(`🔌 Connecting bot ${nextBot.botId} for rotation...`);
      const connectResult = await this.ensureBotConnected(nextBot.botId);
      if (!connectResult.success) {
        logger.error(`❌ Failed to connect bot ${nextBot.botId} for rotation`);
        return { success: false, message: `Failed to connect next bot: ${connectResult.message}` };
      }
      // Get the real bot instance after connection
      nextBot = this.activeBots.get(nextBot.botId);
    }
    
    try {
      // Stop current bot
      const currentBot = this.activeBots.get(botId);
      logger.debug(`🔄🔄🔄 ROTATION: Stopping current bot ${botId}`, {
        found: !!currentBot,
        isPlaceholder: currentBot?.isPlaceholder,
        hasStopStreaming: !!(currentBot?.stopStreaming),
        hasCleanup: !!(currentBot?.cleanupGStreamerProcesses)
      });
      
      // CRITICAL: Even if it's a placeholder, we need to check for orphaned processes
      if (currentBot) {
        if (!currentBot.isPlaceholder && currentBot.stopStreaming) {
          logger.debug(`🛑🛑🛑 ROTATION: Calling stopStreaming() on real bot ${botId}...`);
          await currentBot.stopStreaming();
          logger.debug(`✅ ROTATION: stopStreaming() completed for ${botId}`);
        } else if (currentBot.cleanupGStreamerProcesses) {
          // If it has cleanup method but is a placeholder, still cleanup!
          logger.debug(`⚠️⚠️⚠️ ROTATION: Bot ${botId} is placeholder but has cleanup method - cleaning up orphaned processes`);
          currentBot.cleanupGStreamerProcesses();
        } else {
          logger.debug(`❌❌❌ ROTATION: Bot ${botId} is placeholder with no cleanup - ORPHANED PROCESSES LIKELY!`);
        }
        
        // CRITICAL: Disconnect the bot to free resources
        // This prevents accumulation of connected bots
        if (currentBot.socket) {
          logger.debug(`🔌 Disconnecting ViewBot ${botId} after rotation`);
          currentBot.socket.disconnect();
          currentBot.isConnected = false;
        }
      } else {
        logger.debug(`⚠️ ROTATION: Current bot ${botId} is placeholder or not found, skipping stop`);
      }

      // Add delay to ensure MediaSoup cleanup completes
      logger.debug(`⏳ ViewBot rotation: Waiting for cleanup before starting next bot...`);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start next bot with probability-based rotation
      await nextBot.startStreaming();
      // Apply cooldown to the bot that just started
      this.applyBotCooldown(nextBot.botId);
      nextBot.startRotationCheckTimer();
      
      this.currentLiveBot = nextBot.botId;
      this.currentLiveBotSetTime = Date.now();
      
      logger.debug(`🔄 ViewBot rotation completed: ${botId} → ${nextBot.botId}`);
      
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
          logger.error('⚠️ VIEWBOT CLIENT: Failed to record rotation in database:', dbError);
        }
      }
      
      return { 
        success: true, 
        previousBot: botId,
        newBot: nextBot.botId,
        reason: reason
      };
    } catch (error) {
      logger.error(`❌ ViewBot rotation failed:`, error);
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
      logger.debug(`🛑 Stopped ViewBot rotation - cleared currentLiveBot: ${wasLiveBot}`);
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
    logger.debug(`🎮 MANUAL: Triggering ViewBot takeover`);
    
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
    logger.debug(`🎲 Updated rotation probability to ${(probability * 100).toFixed(1)}%`);
    
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
    
    logger.debug(`⏱️ Updated rotation check interval to ${minInterval/1000}-${maxInterval/1000} seconds`);
    
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
    
    logger.debug(`⏱️ Scheduling ViewBot takeover in ${delay/1000} seconds...`);
    
    this.pendingTakeoverTimer = setTimeout(async () => {
      this.pendingTakeoverTimer = null;
      
      // Double-check that no real streamer started in the meantime
      if (!this.realStreamerActive && this.rotationEnabled && !this.currentLiveBot) {
        logger.debug(`🚀 Executing ViewBot takeover after real streamer disconnect`);
        await this.startViewBotRotation();
      } else {
        logger.debug(`🚫 ViewBot takeover cancelled - conditions changed`);
      }
    }, delay);
  }
  
  /**
   * Start cooldown cleanup timer to reset old cooldowns
   */
  startCooldownCleanup() {
    // Check every 30 minutes for expired cooldowns
    setInterval(() => {
      const expiredBots = this.cooldownTracker.sweepExpired();
      for (const botId of expiredBots) {
        logger.debug(`🔄 COOLDOWN: Reset cooldown for ViewBot ${botId} after 2-hour window`);
      }
      if (expiredBots.length > 0) {
        logger.debug(`🧹 COOLDOWN: Cleared ${expiredBots.length} expired cooldowns`);
      }
    }, 30 * 60 * 1000); // Every 30 minutes
  }
  
  /**
   * Apply cooldown to a bot that just played
   */
  applyBotCooldown(botId) {
    this.cooldownTracker.record(botId);
  }
  
  /**
   * Get probability multiplier for a bot based on cooldown
   */
  getBotProbabilityMultiplier(botId) {
    return this.cooldownTracker.getMultiplier(botId);
  }
  
  /**
   * Select a ViewBot with weighted probability based on cooldowns
   */
  selectViewBotWithCooldown(availableBots) {
    return selectWeightedBot(
      availableBots,
      (botId) => this.getBotProbabilityMultiplier(botId),
      { logger }
    );
  }
  
  /**
   * Handles video end event from a ViewBot
   */
  async handleVideoEnd(botId) {
    logger.debug(`🎬 ViewBot ${botId}: Video file ended`);
    
    const bot = this.activeBots.get(botId);
    if (!bot || !bot.streaming) {
      return;
    }
    
    // Stop the current bot first and ensure cleanup
    logger.debug(`🧹 ViewBot ${botId}: Stopping and cleaning up before rotation`);
    await bot.stopStreaming();
    
    // Clear current live bot immediately
    if (this.currentLiveBot === botId) {
      this.currentLiveBot = null;
    }
    
    if (this.rotationEnabled && !this.realStreamerActive) {
      // CRITICAL: Wait for GStreamer cleanup to fully complete (2.5s for SIGKILL + reference clearing)
      const cleanupDelay = 3000; // 3 second delay to ensure processes are killed and references cleared
      logger.debug(`⏳ Waiting ${cleanupDelay}ms for complete cleanup before rotation...`);
      
      setTimeout(async () => {
        // Double-check conditions after delay
        if (this.rotationEnabled && !this.realStreamerActive && !this.currentLiveBot) {
          logger.debug(`🔄 Starting rotation after video end cleanup delay`);
          
          // Find any available bot to start (queue will handle selection)
          const availableBots = Array.from(this.activeBots.values()).filter(b => 
            b.isConnected && !b.streaming
          );
          
          if (availableBots.length > 0) {
            logger.debug(`🎯 Starting new viewbot after video end`);
            
            try {
              // Just start the rotation system - it will pick the best bot
              await this.startViewBotRotation();
              logger.debug(`✅ Post-video rotation started`);
              
              // Rotation will be recorded by startViewBotRotation
            } catch (error) {
              logger.error(`❌ Failed to rotate after video end:`, error);
            }
          } else {
            logger.debug(`⚠️ No available bots for rotation after video end`);
          }
        } else {
          logger.debug(`⏸️ Rotation cancelled after delay (conditions changed)`);
        }
      }, cleanupDelay);
    } else {
      // Just stop streaming
      logger.debug(`⏹️ ViewBot stopped after video end (rotation disabled or real streamer active)`);
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
    
    logger.debug(`💪 Force rotation requested`);
    
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
        logger.warn('⚠️ GStreamer is not installed. Install GStreamer for this method to work.');
        logger.warn('   ViewBots will fall back to FFmpeg when GStreamer fails.');
      }
    }

    const previousMethod = this.globalStreamingMethod;
    this.globalStreamingMethod = method;
    
    // Update config for all existing bots
    for (const [botId, bot] of this.activeBots) {
      bot.config.useGStreamer = (method === 'gstreamer');
    }
    
    logger.debug(`🎬 Global streaming method changed from ${previousMethod} to ${method}`);
    
    // Save to database if available
    if (this.dbInitialized) {
      try {
        await this.saveSystemState();
      } catch (error) {
        logger.error('Failed to save streaming method to database:', error);
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

module.exports = ViewBotClientService;
