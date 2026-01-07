/**
 * RandomStreamRotationService.js - Auto-rotate random Twitch streams
 *
 * This service:
 * - Finds random live Twitch streamers
 * - Connects them through the URL relay
 * - Assigns random animal names
 * - Rotates to new streamers every 5-10 minutes
 * - Disables viewbots while active
 */

const EventEmitter = require('events');
const TwitchRandomService = require('./TwitchRandomService');
const KickRandomService = require('./KickRandomService');
const https = require('https');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Persistence file for enabled state
const STATE_FILE = path.join(__dirname, '../data/random-rotation-state.json');

// Random animal names for display
const ANIMALS = [
  'Aardvark', 'Albatross', 'Alligator', 'Alpaca', 'Ant', 'Anteater', 'Antelope', 'Armadillo',
  'Badger', 'Bat', 'Bear', 'Beaver', 'Bee', 'Bison', 'Boar', 'Buffalo', 'Butterfly',
  'Camel', 'Capybara', 'Caribou', 'Cat', 'Caterpillar', 'Cheetah', 'Chicken', 'Chimpanzee', 'Chinchilla', 'Cobra', 'Cougar', 'Coyote', 'Crab', 'Crane', 'Crocodile', 'Crow',
  'Deer', 'Dingo', 'Dog', 'Dolphin', 'Donkey', 'Dove', 'Dragonfly', 'Duck',
  'Eagle', 'Echidna', 'Eel', 'Elephant', 'Elk', 'Emu',
  'Falcon', 'Ferret', 'Finch', 'Flamingo', 'Fox', 'Frog',
  'Gazelle', 'Gecko', 'Gerbil', 'Giraffe', 'Goat', 'Goose', 'Gopher', 'Gorilla', 'Grasshopper', 'Grizzly',
  'Hamster', 'Hare', 'Hawk', 'Hedgehog', 'Heron', 'Hippo', 'Hornet', 'Horse', 'Hummingbird', 'Hyena',
  'Iguana', 'Impala',
  'Jackal', 'Jaguar', 'Jellyfish',
  'Kangaroo', 'Koala', 'Kiwi', 'Kookaburra',
  'Lemur', 'Leopard', 'Lion', 'Lizard', 'Llama', 'Lobster', 'Lynx',
  'Manatee', 'Mandrill', 'Meerkat', 'Mink', 'Mole', 'Mongoose', 'Monkey', 'Moose', 'Moth', 'Mouse',
  'Narwhal', 'Newt', 'Nightingale',
  'Ocelot', 'Octopus', 'Opossum', 'Orangutan', 'Orca', 'Ostrich', 'Otter', 'Owl', 'Ox', 'Oyster',
  'Panda', 'Panther', 'Parrot', 'Peacock', 'Pelican', 'Penguin', 'Pheasant', 'Pig', 'Pigeon', 'Platypus', 'Polar Bear', 'Porcupine', 'Porpoise', 'Possum', 'Puma',
  'Quail', 'Quokka',
  'Rabbit', 'Raccoon', 'Ram', 'Raven', 'Reindeer', 'Rhino', 'Robin', 'Rooster',
  'Salamander', 'Salmon', 'Scorpion', 'Sea Lion', 'Seahorse', 'Seal', 'Shark', 'Sheep', 'Shrimp', 'Skunk', 'Sloth', 'Snail', 'Snake', 'Sparrow', 'Spider', 'Squid', 'Squirrel', 'Starfish', 'Stingray', 'Stork', 'Swan',
  'Tapir', 'Tiger', 'Toad', 'Toucan', 'Turkey', 'Turtle',
  'Vulture',
  'Wallaby', 'Walrus', 'Warthog', 'Wasp', 'Weasel', 'Whale', 'Wolf', 'Wolverine', 'Wombat', 'Woodpecker',
  'Yak',
  'Zebra'
];

// Adjectives for more unique names
const ADJECTIVES = [
  'Swift', 'Brave', 'Clever', 'Mighty', 'Gentle', 'Wild', 'Silent', 'Noble',
  'Fierce', 'Calm', 'Lucky', 'Happy', 'Sneaky', 'Fluffy', 'Tiny', 'Giant',
  'Golden', 'Silver', 'Crimson', 'Azure', 'Emerald', 'Amber', 'Violet', 'Scarlet',
  'Northern', 'Southern', 'Eastern', 'Western', 'Arctic', 'Tropical',
  'Royal', 'Cosmic', 'Electric', 'Mystic', 'Shadow', 'Storm', 'Thunder', 'Crystal'
];

// Goading messages to encourage users to go live (placeholders: {STREAMER}, {PLATFORM}, {URL}, {GAME})
const ROTATION_MESSAGES = [
  "📺 Looks like no one is going live... Changing the channel to: {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "🎬 Since nobody's streaming, we're tuning into: {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "😴 Empty streams? Let's watch {STREAMER} play {GAME} on {PLATFORM} instead! | {URL}",
  "🔄 No streamers? Fine, we'll watch {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "📡 Switching to: {STREAMER} ({GAME}) on {PLATFORM}. Someone go live already! | {URL}",
  "🎮 Nobody streaming? {STREAMER} is live playing {GAME} on {PLATFORM}! | {URL}",
  "🌟 While waiting for a real streamer, here's {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "📻 Channel surfing... landed on {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "🎪 The show must go on! Now watching: {STREAMER} play {GAME} on {PLATFORM} | {URL}",
  "🦥 Is anyone awake? Tuning into {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "🎯 Random channel acquired: {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "📺 *changes channel* Now showing: {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "🎲 Rolled the dice and got: {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "🔮 The stream gods have chosen: {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "⚡ Zapping to: {STREAMER} playing {GAME} on {PLATFORM} - come on, someone go live! | {URL}"
];

class RandomStreamRotationService extends EventEmitter {
  constructor() {
    super();

    // Services
    this.twitchService = new TwitchRandomService();
    this.kickService = new KickRandomService();
    this.viewBotURLService = null;
    this.viewBotRotation = null;
    this.io = null;

    // State
    this.isEnabled = false;
    this.currentStream = null;
    this.rotationTimer = null;
    this.usedAnimalNames = new Set();

    // Settings
    this.settings = {
      minRotationMinutes: 1,
      maxRotationMinutes: 11,
      language: 'en',
      minViewers: 1,
      maxViewers: 999999,
      blockedCategories: ['ASMR', 'Pools, Hot Tubs, and Beaches'],
      platforms: ['twitch', 'kick'], // Which platforms to use: 'twitch', 'kick', or both
      platformWeight: { twitch: 50, kick: 50 } // Percentage weight for each platform
    };

    // Statistics
    this.stats = {
      totalRotations: 0,
      startedAt: null,
      streamHistory: []
    };

    // Flag to track if we should auto-restart after a real streamer ends
    this.shouldAutoRestart = false;
    // Flag to prevent restart loops
    this.isRestarting = false;

    console.log('🎲 RandomStreamRotationService initialized');

    // Load persisted state
    this._loadState();
  }

  /**
   * Save enabled state to file for persistence across restarts
   */
  _saveState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const state = {
        enabled: this.isEnabled || this.shouldAutoRestart,
        settings: this.settings,
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`💾 Random rotation state saved (enabled: ${state.enabled})`);
    } catch (error) {
      console.error('❌ Failed to save rotation state:', error.message);
    }
  }

  /**
   * Load persisted state from file
   */
  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        const state = JSON.parse(data);
        if (state.enabled) {
          this.shouldAutoRestart = true;
          console.log('📂 Random rotation state loaded - will auto-start when ready');
        }
        if (state.settings) {
          this.settings = { ...this.settings, ...state.settings };
          console.log('📂 Random rotation settings restored');
        }
      }
    } catch (error) {
      console.error('❌ Failed to load rotation state:', error.message);
    }
  }

  /**
   * Auto-start if persisted state says we should be enabled
   * Called after all dependencies are set
   */
  async autoStartIfEnabled() {
    if (this.shouldAutoRestart && !this.isEnabled && !this.isRestarting) {
      console.log('🔄 Auto-starting random rotation (persisted state)');
      this.isRestarting = true;
      try {
        await this.start();
      } finally {
        this.isRestarting = false;
      }
    }
  }

  /**
   * Check if random rotation should be active (for viewbot priority)
   */
  isRandomRotationActive() {
    return this.isEnabled || this.shouldAutoRestart;
  }

  /**
   * Set dependencies
   */
  setViewBotURLService(service) {
    this.viewBotURLService = service;
    console.log('✅ ViewBotURLService registered with RandomStreamRotation');
  }

  setViewBotRotation(rotation) {
    this.viewBotRotation = rotation;
    console.log('✅ ViewBotRotation registered with RandomStreamRotation');
  }

  setSocketIO(io) {
    this.io = io;
    console.log('✅ Socket.IO registered with RandomStreamRotation');

    // Listen for stream-ended events to auto-restart rotation
    if (io) {
      // Use a separate handler that checks if we should auto-restart
      this._setupStreamEndedListener();
    }
  }

  /**
   * Setup listener for stream-ended events to auto-restart rotation
   */
  _setupStreamEndedListener() {
    // Listen on the io instance for when any stream ends
    // We'll hook into the global streamService instead
    if (global.streamService) {
      // Poll periodically to check if stream ended and we should restart
      this._startAutoRestartMonitor();
    }
  }

  /**
   * Monitor for stream ending to auto-restart rotation
   */
  _startAutoRestartMonitor() {
    // Check every 5 seconds if we should restart
    if (this.autoRestartMonitor) {
      clearInterval(this.autoRestartMonitor);
    }

    this.autoRestartMonitor = setInterval(async () => {
      // If we should auto-restart but we're not currently running
      if (this.shouldAutoRestart && !this.isEnabled && !this.isRestarting) {
        // Check if there's currently a real streamer
        const hasRealStreamer = this._hasRealStreamer();

        if (!hasRealStreamer) {
          console.log('🔄 No active streamer detected, auto-restarting random rotation...');
          this.isRestarting = true;
          try {
            await this.start();
          } catch (error) {
            console.error('❌ Auto-restart failed:', error.message);
          } finally {
            this.isRestarting = false;
          }
        }
      }
    }, 5000);

    console.log('👁️ Auto-restart monitor started');
  }

  /**
   * Check if there's a real (non-viewbot, non-url-stream) streamer active
   */
  _hasRealStreamer() {
    if (!global.streamService) return false;

    const currentStreamer = global.streamService.getCurrentStreamer();
    if (!currentStreamer) return false;

    // URL streams and viewbots are not "real" streamers
    if (currentStreamer.startsWith('url-stream-')) return false;
    if (currentStreamer.startsWith('viewbot-')) return false;
    if (currentStreamer.includes('viewbot')) return false;

    // There's a real streamer
    return true;
  }

  /**
   * Send an announcement to chat via StreamBot
   */
  async sendChatAnnouncement(message) {
    try {
      const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';
      const agent = new https.Agent({ rejectUnauthorized: false });

      await axios.post(
        `${chatServiceUrl}/api/system-message`,
        {
          message: message,
          username: '🤖 StreamBot'
        },
        {
          httpsAgent: agent,
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000
        }
      );

      console.log('📢 Rotation announcement sent to chat');
    } catch (error) {
      console.error('❌ Failed to send rotation announcement:', error.message);
    }
  }

  /**
   * Generate a random rotation announcement message
   */
  generateRotationAnnouncement(streamer) {
    const template = ROTATION_MESSAGES[Math.floor(Math.random() * ROTATION_MESSAGES.length)];
    const platformName = streamer.platform === 'kick' ? 'Kick' : 'Twitch';

    return template
      .replace('{STREAMER}', streamer.displayName || streamer.username)
      .replace('{PLATFORM}', platformName)
      .replace('{URL}', streamer.url)
      .replace('{GAME}', streamer.game || 'Unknown');
  }

  /**
   * Generate a random animal name
   */
  generateAnimalName() {
    let name;
    let attempts = 0;
    const maxAttempts = 100;

    do {
      const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
      const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
      name = `${adjective} ${animal}`;
      attempts++;

      // If we've used too many, clear the used set
      if (attempts >= maxAttempts) {
        console.log('🔄 Clearing used animal names cache');
        this.usedAnimalNames.clear();
        break;
      }
    } while (this.usedAnimalNames.has(name));

    this.usedAnimalNames.add(name);
    return name;
  }

  /**
   * Get random rotation interval (in ms)
   */
  getRandomInterval() {
    const minMs = this.settings.minRotationMinutes * 60 * 1000;
    const maxMs = this.settings.maxRotationMinutes * 60 * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Check if service is ready to run
   */
  isReady() {
    const enabledPlatforms = this.settings.platforms || ['twitch'];

    // Check if at least one enabled platform is available
    const availablePlatforms = [];

    if (enabledPlatforms.includes('twitch') && this.twitchService.isConfigured()) {
      availablePlatforms.push('twitch');
    }
    if (enabledPlatforms.includes('kick')) {
      availablePlatforms.push('kick'); // Kick doesn't need API keys
    }

    if (availablePlatforms.length === 0) {
      if (enabledPlatforms.includes('twitch') && !this.twitchService.isConfigured()) {
        return { ready: false, error: 'Twitch API not configured and Kick not enabled' };
      }
      return { ready: false, error: 'No platforms enabled' };
    }

    if (!this.viewBotURLService) {
      return { ready: false, error: 'ViewBotURLService not set' };
    }

    return { ready: true, availablePlatforms };
  }

  /**
   * Select a random platform based on weights
   */
  selectRandomPlatform() {
    const enabledPlatforms = this.settings.platforms || ['twitch'];
    const availablePlatforms = [];

    // Only include platforms that are actually available
    if (enabledPlatforms.includes('twitch') && this.twitchService.isConfigured()) {
      availablePlatforms.push('twitch');
    }
    if (enabledPlatforms.includes('kick')) {
      availablePlatforms.push('kick');
    }

    if (availablePlatforms.length === 0) {
      return null;
    }

    if (availablePlatforms.length === 1) {
      return availablePlatforms[0];
    }

    // Use weighted random selection
    const weights = this.settings.platformWeight || { twitch: 50, kick: 50 };
    const totalWeight = availablePlatforms.reduce((sum, p) => sum + (weights[p] || 50), 0);
    let random = Math.random() * totalWeight;

    for (const platform of availablePlatforms) {
      random -= (weights[platform] || 50);
      if (random <= 0) {
        return platform;
      }
    }

    return availablePlatforms[0];
  }

  /**
   * Start the random stream rotation
   */
  async start() {
    const readyCheck = this.isReady();
    if (!readyCheck.ready) {
      throw new Error(readyCheck.error);
    }

    if (this.isEnabled) {
      console.log('⚠️ Random rotation already running');
      return { success: false, error: 'Already running' };
    }

    console.log('🎬 Starting random stream rotation...');

    this.isEnabled = true;
    this.shouldAutoRestart = true; // Enable auto-restart on stream end
    this.stats.startedAt = Date.now();

    // Save state for persistence across restarts
    this._saveState();

    // Start auto-restart monitor if not already running
    this._startAutoRestartMonitor();

    // CRITICAL: Perform comprehensive viewbot cleanup before starting
    await this._cleanupAllViewbots();

    // Start first stream
    const result = await this._rotateToNewStream();

    if (!result.success) {
      this.isEnabled = false;
      return result;
    }

    // Schedule next rotation
    this._scheduleNextRotation();

    // Emit status
    this.emit('rotation-started', {
      stream: this.currentStream
    });

    if (this.io) {
      this.io.emit('random-rotation-status', {
        enabled: true,
        currentStream: this.currentStream
      });

      // Emit stream-started event for any listeners
      this.io.emit('stream-started', {
        streamerId: this.currentStream.urlId,
        streamerName: this.currentStream.displayName,
        isRandomRotation: true,
        platform: this.currentStream.platform
      });
    }

    return { success: true, stream: this.currentStream };
  }

  /**
   * Comprehensive viewbot cleanup
   * Stops all viewbot systems to ensure clean slate for random rotation
   */
  async _cleanupAllViewbots() {
    console.log('🧹 Performing comprehensive viewbot cleanup...');

    // 1. Stop SimpleViewBotRotation (primary viewbot system)
    if (this.viewBotRotation) {
      console.log('🛑 Stopping SimpleViewBotRotation...');
      // Disable the rotation to prevent auto-restart
      this.viewBotRotation.settings.enabled = false;
      // Stop and wait for cleanup
      await this.viewBotRotation.stopRotation();
      console.log('✅ SimpleViewBotRotation stopped and disabled');
    }

    // 2. Stop ViewBotManager if it exists (alternative viewbot system)
    if (global.viewBotManager) {
      console.log('🛑 Stopping ViewBotManager...');
      try {
        // Stop rotation first
        global.viewBotManager.stopRotation();
        // Then cleanup all bots
        await global.viewBotManager.cleanup();
        console.log('✅ ViewBotManager cleaned up');
      } catch (error) {
        console.error('⚠️ Error cleaning up ViewBotManager:', error.message);
      }
    }

    // 3. CRITICAL: Stop all LiveKit viewbots and remove them from the room
    if (global.viewBotLiveKitService) {
      console.log('🛑 Stopping all LiveKit viewbots...');
      try {
        await global.viewBotLiveKitService.stopAllViewBots();
        console.log('✅ All LiveKit viewbots stopped');
      } catch (error) {
        console.error('⚠️ Error stopping LiveKit viewbots:', error.message);
      }
    }

    // 4. Clear current streamer from StreamService (viewbot was the current streamer)
    if (global.streamService) {
      const currentStreamer = global.streamService.getCurrentStreamer();
      if (currentStreamer && (currentStreamer.startsWith('viewbot-') || currentStreamer.includes('viewbot'))) {
        console.log(`🧹 Clearing viewbot streamer: ${currentStreamer}`);
        global.streamService.clearStreamer();
      }
    }

    // 5. Clear MediasoupService/WebRTCAdapter currentStreamer
    if (global.mediasoupService && global.mediasoupService.currentStreamer) {
      const current = global.mediasoupService.currentStreamer;
      if (current.startsWith('viewbot-') || current.includes('viewbot')) {
        console.log(`🧹 Clearing MediaSoup viewbot streamer: ${current}`);
        global.mediasoupService.currentStreamer = null;
      }
    }

    // 6. Emit stream-ended to notify viewers the current content is ending
    if (this.io) {
      console.log('📢 Broadcasting stream-ended to prepare for rotation...');
      this.io.emit('stream-ended', {
        reason: 'random_rotation_starting',
        isRandomRotation: true
      });
    }

    // Brief pause to allow cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('✅ Viewbot cleanup complete');
  }

  /**
   * Stop the random stream rotation
   */
  async stop() {
    if (!this.isEnabled && !this.shouldAutoRestart) {
      console.log('⚠️ Random rotation not running');
      return { success: false, error: 'Not running' };
    }

    console.log('⏹️ Stopping random stream rotation...');

    const stoppingStream = this.currentStream;
    this.isEnabled = false;
    this.shouldAutoRestart = false; // Disable auto-restart

    // Stop auto-restart monitor
    if (this.autoRestartMonitor) {
      clearInterval(this.autoRestartMonitor);
      this.autoRestartMonitor = null;
      console.log('🛑 Auto-restart monitor stopped');
    }

    // Save state for persistence
    this._saveState();

    // Clear rotation timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Stop current URL stream
    if (this.currentStream && this.viewBotURLService) {
      // Emit stream-ending event before stopping
      if (this.io) {
        this.io.emit('stream-ending', {
          reason: 'random_rotation_stopped',
          streamerId: this.currentStream.urlId,
          displayName: this.currentStream.displayName
        });
      }

      await this.viewBotURLService.stopURLStream(this.currentStream.urlId);
    }

    this.currentStream = null;

    // Re-enable viewbot rotation if it was active before
    if (this.viewBotRotation) {
      console.log('▶️ Re-enabling viewbot rotation');
      this.viewBotRotation.updateSettings({ enabled: true });
      await this.viewBotRotation.startRotation();
    }

    // Emit status
    this.emit('rotation-stopped');

    if (this.io) {
      this.io.emit('random-rotation-status', {
        enabled: false,
        currentStream: null
      });

      // Emit stream-ended event
      this.io.emit('stream-ended', {
        reason: 'random_rotation_stopped',
        streamerId: stoppingStream?.urlId,
        isRandomRotation: true
      });
    }

    console.log('✅ Random stream rotation stopped');
    return { success: true };
  }

  /**
   * Pause rotation (when a real streamer takes over)
   * Keeps auto-restart enabled so it resumes when the real streamer stops
   */
  async pause() {
    if (!this.isEnabled) {
      console.log('⚠️ Random rotation not running, nothing to pause');
      return { success: false, error: 'Not running' };
    }

    console.log('⏸️ Pausing random stream rotation (real streamer taking over)...');

    this.isEnabled = false;
    // Keep shouldAutoRestart = true so we resume after the real streamer stops

    // Clear rotation timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Stop current URL stream
    if (this.currentStream && this.viewBotURLService) {
      await this.viewBotURLService.stopURLStream(this.currentStream.urlId);
    }

    this.currentStream = null;

    // Emit status (paused but will auto-restart)
    if (this.io) {
      this.io.emit('random-rotation-status', {
        enabled: false,
        paused: true,
        willAutoRestart: this.shouldAutoRestart,
        currentStream: null
      });
    }

    console.log('✅ Random stream rotation paused (will auto-restart when streamer ends)');
    return { success: true };
  }

  /**
   * Force rotate to next stream immediately
   */
  async forceRotate() {
    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    console.log('🔄 Force rotating to new stream...');

    // Emit force-rotate event
    if (this.io) {
      this.io.emit('random-rotation-force', {
        previousStream: this.currentStream ? {
          displayName: this.currentStream.displayName,
          platform: this.currentStream.platform
        } : null
      });
    }

    // Clear current timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Rotate
    const result = await this._rotateToNewStream();

    if (result.success) {
      this._scheduleNextRotation();
    }

    return result;
  }

  /**
   * Internal: Rotate to a new random stream
   */
  async _rotateToNewStream() {
    try {
      const previousStream = this.currentStream;

      // Stop current stream if any
      if (this.currentStream && this.viewBotURLService) {
        console.log(`⏹️ Stopping current stream: ${this.currentStream.displayName}`);

        // Emit stream-switching event BEFORE stopping (viewers can prepare for transition)
        if (this.io) {
          this.io.emit('stream-switching', {
            previousStream: {
              displayName: this.currentStream.displayName,
              platform: this.currentStream.platform,
              streamerUsername: this.currentStream.streamerUsername
            },
            reason: 'rotation'
          });
        }

        await this.viewBotURLService.stopURLStream(this.currentStream.urlId);
      }

      // Select platform and find random streamer
      const platform = this.selectRandomPlatform();
      if (!platform) {
        return { success: false, error: 'No platforms available' };
      }

      console.log(`🎲 Selected platform: ${platform}`);

      let streamer = null;

      if (platform === 'twitch') {
        streamer = await this.twitchService.findRandomStreamer({
          language: this.settings.language,
          minViewers: this.settings.minViewers,
          maxViewers: this.settings.maxViewers
        });
      } else if (platform === 'kick') {
        streamer = await this.kickService.findRandomStreamer({
          minViewers: this.settings.minViewers,
          maxViewers: this.settings.maxViewers
        });
      }

      if (!streamer) {
        // If selected platform fails, try the other one
        console.log(`⚠️ No streamer found on ${platform}, trying other platform...`);

        const otherPlatform = platform === 'twitch' ? 'kick' : 'twitch';
        const enabledPlatforms = this.settings.platforms || ['twitch'];

        if (enabledPlatforms.includes(otherPlatform)) {
          if (otherPlatform === 'twitch' && this.twitchService.isConfigured()) {
            streamer = await this.twitchService.findRandomStreamer({
              language: this.settings.language,
              minViewers: this.settings.minViewers,
              maxViewers: this.settings.maxViewers
            });
          } else if (otherPlatform === 'kick') {
            streamer = await this.kickService.findRandomStreamer({
              minViewers: this.settings.minViewers,
              maxViewers: this.settings.maxViewers
            });
          }
        }
      }

      if (!streamer) {
        return { success: false, error: 'No suitable streamer found on any platform' };
      }

      // Generate random animal name
      const animalName = this.generateAnimalName();

      const platformIcon = streamer.platform === 'kick' ? '🟢' : '🟣';
      console.log(`${platformIcon} Connecting to: ${streamer.displayName} (${streamer.game}) on ${streamer.platform} as "${animalName}"`);

      // For Kick streams, use the direct HLS playback URL if available
      // (streamlink doesn't support Kick, so we need the direct URL)
      const streamUrl = streamer.playbackUrl || streamer.url;
      if (streamer.platform === 'kick' && streamer.playbackUrl) {
        console.log(`🟢 Using direct Kick HLS URL: ${streamer.playbackUrl}`);
      }

      // Start URL stream
      const result = await this.viewBotURLService.startURLStream(streamUrl, {
        quality: 'best',
        displayName: animalName,
        autoReconnect: true
      });

      if (!result.success) {
        console.error(`❌ Failed to start stream: ${result.error}`);
        return result;
      }

      // Update state AFTER stream successfully starts
      this.currentStream = {
        urlId: result.urlId,
        displayName: animalName,
        platform: streamer.platform || 'twitch',
        streamerUsername: streamer.username,
        streamerDisplayName: streamer.displayName,
        game: streamer.game,
        title: streamer.title,
        viewers: streamer.viewers,
        url: streamer.url,
        startedAt: Date.now()
      };

      // Track stats
      this.stats.totalRotations++;
      this.stats.streamHistory.push({
        ...this.currentStream,
        endedAt: null
      });

      // Keep only last 20 in history
      if (this.stats.streamHistory.length > 20) {
        this.stats.streamHistory.shift();
      }

      // Emit internal event
      this.emit('stream-rotated', {
        stream: this.currentStream
      });

      if (this.io) {
        // Emit rotation status update - this updates the header name
        this.io.emit('random-rotation-status', {
          enabled: true,
          currentStream: this.currentStream
        });

        // Emit new-streamer event for viewers to switch
        // Note: ViewBotURLService also emits this via _notifyViewersWhenReady
        this.io.emit('new-streamer', {
          streamer: {
            odyseeId: this.currentStream.urlId,
            odysee_username: this.currentStream.displayName,
            userId: this.currentStream.urlId,
            isUrlStream: true,
            isRandomRotation: true,
            platform: this.currentStream.platform,
            game: this.currentStream.game,
            originalStreamer: this.currentStream.streamerDisplayName
          }
        });

        // Emit stream-switched event to confirm the switch completed
        this.io.emit('stream-switched', {
          newStream: {
            urlId: this.currentStream.urlId,
            displayName: this.currentStream.displayName,
            platform: this.currentStream.platform,
            streamerUsername: this.currentStream.streamerUsername,
            game: this.currentStream.game
          },
          isRandomRotation: true,
          rotationNumber: this.stats.totalRotations
        });
      }

      console.log(`✅ Now streaming: "${animalName}" (${streamer.displayName} playing ${streamer.game} on ${streamer.platform})`);

      // Send announcement to chat
      const announcement = this.generateRotationAnnouncement(streamer);
      this.sendChatAnnouncement(announcement);

      return { success: true, stream: this.currentStream };

    } catch (error) {
      console.error('❌ Error rotating stream:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Internal: Schedule the next rotation
   */
  _scheduleNextRotation() {
    const interval = this.getRandomInterval();
    const minutes = Math.round(interval / 60000 * 10) / 10;

    console.log(`⏱️ Next rotation in ${minutes} minutes`);

    this.rotationTimer = setTimeout(async () => {
      if (!this.isEnabled) return;

      const result = await this._rotateToNewStream();

      if (result.success) {
        this._scheduleNextRotation();
      } else {
        // Try again after a short delay
        console.log('⚠️ Rotation failed, retrying in 30 seconds...');
        this.rotationTimer = setTimeout(() => {
          if (this.isEnabled) {
            this._rotateToNewStream().then(r => {
              if (r.success) this._scheduleNextRotation();
            });
          }
        }, 30000);
      }
    }, interval);
  }

  /**
   * Get current status
   */
  getStatus() {
    const nextRotation = this.rotationTimer ? {
      // Timer doesn't expose remaining time, so we estimate
      estimated: 'In progress'
    } : null;

    return {
      enabled: this.isEnabled,
      currentStream: this.currentStream,
      stats: {
        ...this.stats,
        uptime: this.stats.startedAt ? Date.now() - this.stats.startedAt : 0
      },
      settings: this.settings,
      twitchConfigured: this.twitchService.isConfigured(),
      kickConfigured: true, // Kick doesn't need API keys
      availablePlatforms: this._getAvailablePlatforms()
    };
  }

  /**
   * Get list of available platforms
   */
  _getAvailablePlatforms() {
    const available = [];
    if (this.twitchService.isConfigured()) {
      available.push({ id: 'twitch', name: 'Twitch', icon: '🟣' });
    }
    available.push({ id: 'kick', name: 'Kick', icon: '🟢' });
    return available;
  }

  /**
   * Update settings
   */
  updateSettings(newSettings) {
    this.settings = {
      ...this.settings,
      ...newSettings
    };

    // Update Twitch service settings
    if (newSettings.minViewers !== undefined || newSettings.maxViewers !== undefined) {
      this.twitchService.setViewerRange(
        this.settings.minViewers,
        this.settings.maxViewers
      );
      this.kickService.setViewerRange(
        this.settings.minViewers,
        this.settings.maxViewers
      );
    }

    if (newSettings.blockedCategories) {
      // Clear and re-add blocked categories for Twitch
      for (const cat of this.twitchService.getBlockedCategories()) {
        this.twitchService.unblockCategory(cat);
      }
      for (const cat of newSettings.blockedCategories) {
        this.twitchService.blockCategory(cat);
      }

      // Clear and re-add blocked categories for Kick
      for (const cat of this.kickService.getBlockedCategories()) {
        this.kickService.unblockCategory(cat);
      }
      for (const cat of newSettings.blockedCategories) {
        this.kickService.blockCategory(cat);
      }
    }

    console.log('⚙️ Settings updated:', this.settings);
    return this.settings;
  }

  /**
   * Get stream history
   */
  getHistory() {
    return this.stats.streamHistory;
  }

  /**
   * Clear statistics
   */
  clearStats() {
    this.stats = {
      totalRotations: 0,
      startedAt: null,
      streamHistory: []
    };
    this.usedAnimalNames.clear();
    console.log('🧹 Stats cleared');
  }
}

module.exports = RandomStreamRotationService;
