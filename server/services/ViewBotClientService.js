const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ViewBotDatabaseService = require('./ViewBotDatabaseService');
const processManager = require('./ProcessManager');
const ViewBotInstance = require('./viewbot/ViewBotInstance');
const { selectWeightedBot } = require('./viewbot/botSelection');
const BotCooldownTracker = require('./viewbot/BotCooldownTracker');
const RotationRequestQueue = require('./viewbot/RotationRequestQueue');
const RotationConfigStore = require('./viewbot/RotationConfigStore');
const RealStreamerGuard = require('./viewbot/RealStreamerGuard');
const RotationController = require('./viewbot/RotationController');

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

    // Rotation-settings + real-streamer-protection collaborators (own state stays
    // on this instance; collaborators mutate owner.<field> as the single source of truth)
    this.rotationConfigStore = new RotationConfigStore({ owner: this });
    this.realStreamerGuard = new RealStreamerGuard({
      streamService: this.streamService,
      mediasoupService: this.mediasoupService,
      viewbotService: this.viewbotService,
      owner: this
    });

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
    this.globalStreamingMethod = 'ffmpeg'; // ffmpeg is the only supported method
    
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
    
    // Rotation queue management for preventing race conditions.
    // Request storage + admission live in RotationRequestQueue; the processing
    // lock/timer stay here (they drive handleRotationRequest execution).
    this.rotationRequestQueue = new RotationRequestQueue({ logger });
    this.rotationLock = false;
    this.rotationProcessTimer = null;
    this.rotationQueueWindow = 500; // Process queue every 500ms

    // Rotation state machine collaborator. Holds NO state of its own — all
    // rotation state stays on this service (the owner) and the controller
    // mutates owner.<field> as the single source of truth. Constructed after
    // the rotation fields/collaborators it references exist.
    this.rotationController = new RotationController({ owner: this });

    // Flag to prevent viewbots from starting during initialization
    this.initializationInProgress = true;
    
    // Initialize database and restore state
    this.initialize();
    
    logger.debug('🤖 VIEWBOT CLIENT: Service initialized with cooldown system and rotation queue');
  }

  /**
   * Load rotation configuration from file (delegates to RotationConfigStore)
   */
  loadRotationConfig() {
    return this.rotationConfigStore.loadRotationConfig();
  }

  /**
   * Save rotation configuration to file (delegates to RotationConfigStore)
   */
  saveRotationConfig() {
    return this.rotationConfigStore.saveRotationConfig();
  }

  /**
   * Get current rotation settings (delegates to RotationConfigStore)
   */
  getRotationSettings() {
    return this.rotationConfigStore.getRotationSettings();
  }

  /**
   * Update rotation settings (delegates to RotationConfigStore)
   */
  updateRotationSettings(settings) {
    return this.rotationConfigStore.updateRotationSettings(settings);
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
    return this.rotationController.restartRotationAfterRestore();
  }

  /**
   * Starts the ViewBot rotation system by selecting and starting the first ViewBot
   */
  async startViewBotRotation() {
    return this.rotationController.startViewBotRotation();
  }

  /**
   * Sets the real streamer status (delegates to RealStreamerGuard)
   */
  setRealStreamerStatus(isActive) {
    return this.realStreamerGuard.setRealStreamerStatus(isActive);
  }

  /**
   * Validates and auto-corrects real streamer status (delegates to RealStreamerGuard)
   */
  validateRealStreamerStatus() {
    return this.realStreamerGuard.validateRealStreamerStatus();
  }

  /**
   * Auto-validation that runs periodically (delegates to RealStreamerGuard)
   */
  startAutoValidation() {
    return this.realStreamerGuard.startAutoValidation();
  }

  /**
   * Stop auto-validation timer (delegates to RealStreamerGuard)
   */
  stopAutoValidation() {
    return this.realStreamerGuard.stopAutoValidation();
  }
  
  /**
   * Ensures a ViewBot is always streaming when rotation is enabled and no real streamer is active
   * This provides proactive presence maintenance rather than just reactive
   */
  async maintainViewBotPresence() {
    return this.rotationController.maintainViewBotPresence();
  }

  /**
   * Queues a rotation request to prevent race conditions
   * This is the new entry point for all rotation requests
   */
  queueRotationRequest(botId, reason) {
    return this.rotationController.queueRotationRequest(botId, reason);
  }
  
  /**
   * Processes the rotation queue, ensuring only one rotation happens
   */
  async processRotationQueue() {
    return this.rotationController.processRotationQueue();
  }
  
  /**
   * Handle rotation request from ViewbotService when video ends
   * This is called by ViewbotService.handleVideoEnd
   */
  handleRotation(botId) {
    return this.rotationController.handleRotation(botId);
  }

  /**
   * Handles ViewBot rotation requests (now called only from processRotationQueue)
   */
  async handleRotationRequest(botId, reason) {
    return this.rotationController.handleRotationRequest(botId, reason);
  }

  /**
   * Stops ViewBot rotation system
   */
  stopViewBotRotation() {
    return this.rotationController.stopViewBotRotation();
  }

  /**
   * Manually trigger ViewBot takeover (admin function)
   */
  async manualTriggerTakeover() {
    return this.rotationController.manualTriggerTakeover();
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
   * Updates the rotation probability (delegates to RotationConfigStore)
   */
  updateRotationProbability(probability) {
    return this.rotationConfigStore.updateRotationProbability(probability);
  }

  /**
   * Updates the rotation check interval (delegates to RotationConfigStore)
   */
  updateRotationInterval(minInterval, maxInterval) {
    return this.rotationConfigStore.updateRotationInterval(minInterval, maxInterval);
  }
  
  /**
   * Schedules a ViewBot takeover after real streamer disconnects
   */
  scheduleViewBotTakeover() {
    return this.rotationController.scheduleViewBotTakeover();
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
    return this.rotationController.handleVideoEnd(botId);
  }
  
  /**
   * Force rotation (admin command)
   */
  async forceRotation() {
    return this.rotationController.forceRotation();
  }

  /**
   * Gets the current global streaming method setting
   */
  getStreamingMethod() {
    return {
      method: this.globalStreamingMethod,
      supported: ['ffmpeg']
    };
  }

  /**
   * Sets the global streaming method for all ViewBots
   * @param {string} method - only 'ffmpeg' is supported
   */
  async setStreamingMethod(method) {
    if (method !== 'ffmpeg') {
      throw new Error(`Invalid streaming method: ${method}. Must be 'ffmpeg'`);
    }

    const previousMethod = this.globalStreamingMethod;
    this.globalStreamingMethod = 'ffmpeg';

    logger.debug(`🎬 Global streaming method set to ${method}`);

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
      newMethod: 'ffmpeg',
      message: `Streaming method changed to FFMPEG for all ViewBots`
    };
  }
}

module.exports = ViewBotClientService;
