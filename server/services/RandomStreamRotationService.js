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
    this.nextRotationAt = null; // Timestamp of next scheduled rotation
    this.currentRotationDuration = null; // Duration of current rotation interval in ms
    this.countdownAnnouncementTimers = []; // Timers for periodic countdown announcements

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

    // Retry configuration for robust failure recovery
    this.retryConfig = {
      maxRetries: 5,              // Maximum consecutive retries before giving up temporarily
      baseDelayMs: 1500,          // Base delay (1.5 seconds) - fast retry for source unavailable errors
      maxDelayMs: 60000,          // Max delay (1 minute)
      backoffMultiplier: 2,       // Exponential backoff multiplier
      resetAfterSuccessMs: 60000  // Reset retry count after 1 minute of success
    };

    // Retry state tracking
    this.retryState = {
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      currentRetryTimer: null
    };

    // Extend state tracking
    this.lastExtendTime = null; // Timestamp of last successful extend
    this.extendCooldownMs = 5 * 60 * 1000; // 5 minute cooldown between extends
    this.extendMinutes = 4; // Default extend time (3-5 minutes range, using 4)

    // Lock state - when locked, rotation timer is frozen
    this.isLocked = false;
    this.lockedAt = null;
    this.remainingTimeWhenLocked = null; // Store remaining time when locked

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
   * Calculate retry delay with exponential backoff
   */
  _calculateRetryDelay() {
    const { baseDelayMs, maxDelayMs, backoffMultiplier } = this.retryConfig;
    const failures = this.retryState.consecutiveFailures;
    const delay = Math.min(baseDelayMs * Math.pow(backoffMultiplier, failures), maxDelayMs);
    return delay;
  }

  /**
   * Record a successful operation - resets retry state
   */
  _recordSuccess() {
    this.retryState.consecutiveFailures = 0;
    this.retryState.lastSuccessTime = Date.now();
    this.retryState.lastFailureTime = null;

    // Clear any pending retry timer
    if (this.retryState.currentRetryTimer) {
      clearTimeout(this.retryState.currentRetryTimer);
      this.retryState.currentRetryTimer = null;
    }
  }

  /**
   * Record a failed operation - increments retry counter
   */
  _recordFailure() {
    this.retryState.consecutiveFailures++;
    this.retryState.lastFailureTime = Date.now();
  }

  /**
   * Check if we should continue retrying
   */
  _shouldRetry() {
    return this.retryState.consecutiveFailures < this.retryConfig.maxRetries;
  }

  /**
   * Schedule a retry with exponential backoff
   * Returns a promise that resolves when the retry completes
   */
  async _scheduleRetryWithBackoff(operation, operationName) {
    if (!this._shouldRetry()) {
      const waitTime = Math.round(this.retryConfig.maxDelayMs / 1000);
      console.log(`⚠️ ROTATION: Max retries (${this.retryConfig.maxRetries}) reached for ${operationName}. Waiting ${waitTime}s before reset...`);

      // Wait for max delay then reset and try again (don't give up permanently)
      return new Promise((resolve) => {
        this.retryState.currentRetryTimer = setTimeout(async () => {
          // Check if locked before retrying
          if (this.isLocked) {
            console.log('🔒 ROTATION: Skipping retry - timer is locked');
            resolve({ success: false, error: 'Rotation is locked' });
            return;
          }
          console.log(`🔄 ROTATION: Resetting retry counter and attempting ${operationName} again...`);
          this.retryState.consecutiveFailures = 0; // Reset for fresh attempts
          const result = await operation();
          resolve(result);
        }, this.retryConfig.maxDelayMs);
      });
    }

    const delay = this._calculateRetryDelay();
    const delaySeconds = Math.round(delay / 1000);
    console.log(`🔄 ROTATION: Retry ${this.retryState.consecutiveFailures}/${this.retryConfig.maxRetries} for ${operationName} in ${delaySeconds}s...`);

    return new Promise((resolve) => {
      this.retryState.currentRetryTimer = setTimeout(async () => {
        // Check if locked before retrying
        if (this.isLocked) {
          console.log('🔒 ROTATION: Skipping retry - timer is locked');
          resolve({ success: false, error: 'Rotation is locked' });
          return;
        }
        const result = await operation();
        resolve(result);
      }, delay);
    });
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

    // CRITICAL: Listen for URL stream failures to auto-rotate to next stream
    if (service) {
      service.on('url-stream-ended', async (data) => {
        const { urlId, reason } = data;
        console.log(`🔔 ROTATION: URL stream ${urlId} ended (reason: ${reason})`);

        // Only auto-rotate if the stream failed (not manual stop)
        const shouldRotate = ['error', 'reconnect_failed', 'source_ended', 'health-check', 'http_error'].includes(reason);

        if (shouldRotate && this.isEnabled) {
          console.log(`🔄 ROTATION: Auto-rotating to next stream due to ${reason}...`);

          // Announce to chat that stream disconnected and we're finding a new one
          this.sendChatAnnouncement('Stream disconnected - finding a new streamer...');

          // Small delay to let cleanup complete (shorter for HTTP errors since no reconnect was attempted)
          const cleanupDelay = reason === 'http_error' ? 500 : 1500;
          await new Promise(resolve => setTimeout(resolve, cleanupDelay));

          // CRITICAL: Check if service is busy (reconnecting or starting new stream)
          if (this.viewBotURLService.isBusy()) {
            console.log('⏳ ROTATION: Service is busy (reconnecting/starting), skipping auto-rotation');
            return;
          }

          // Check if already restarting or retry timer pending
          if (this.isRestarting || this.retryState.currentRetryTimer) {
            console.log('⏳ ROTATION: Already restarting or retry pending, skipping auto-rotation');
            return;
          }

          // Check if another stream started in the meantime
          if (this.viewBotURLService.activeStreams.size === 0) {
            this.isRestarting = true;
            try {
              const result = await this._rotateToNewStream();
              if (result.success) {
                console.log(`✅ ROTATION: Auto-rotated to new stream: ${result.stream?.displayName}`);
                this._recordSuccess();

                // Ensure rotation timer is scheduled
                if (!this.rotationTimer) {
                  this._scheduleNextRotation();
                }
              } else {
                console.error(`❌ ROTATION: Auto-rotation failed: ${result.error}`);
                this._recordFailure();
                // Auto-restart monitor will handle retry with backoff
              }
            } catch (error) {
              console.error(`❌ ROTATION: Auto-rotation error:`, error.message);
              this._recordFailure();
            } finally {
              this.isRestarting = false;
            }
          } else {
            console.log('⏭️ ROTATION: Another stream already started, skipping auto-rotation');
            this._recordSuccess(); // Stream recovered on its own
          }
        }
      });
      console.log('✅ URL stream failure listener registered for auto-rotation');
    }
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
   * Uses exponential backoff to avoid rapid retry loops
   */
  _startAutoRestartMonitor() {
    // Dynamic check interval - increases on failures, resets on success
    const baseInterval = 5000;  // 5 seconds base
    const maxInterval = 60000;  // 1 minute max

    if (this.autoRestartMonitor) {
      clearInterval(this.autoRestartMonitor);
    }

    const runMonitorCheck = async () => {
      // Skip if already processing or a retry timer is pending
      if (this.isRestarting || this.retryState.currentRetryTimer) return;

      // CRITICAL: Check if ViewBotURLService is busy (starting or reconnecting)
      if (this.viewBotURLService && this.viewBotURLService.isBusy()) {
        return; // Don't interfere while service is busy
      }

      // Check if there's currently a real streamer
      const hasRealStreamer = this._hasRealStreamer();
      if (hasRealStreamer) {
        // Reset failure count when real streamer is active
        if (this.retryState.consecutiveFailures > 0) {
          this._recordSuccess();
        }
        return;
      }

      // Case 1: Should auto-restart but not enabled (shouldn't happen often with new logic)
      if (this.shouldAutoRestart && !this.isEnabled) {
        console.log('🔄 No active streamer detected, auto-restarting random rotation...');
        this.isRestarting = true;
        try {
          await this.start();
          this._recordSuccess();
        } catch (error) {
          console.error('❌ Auto-restart failed:', error.message);
          this._recordFailure();
        } finally {
          this.isRestarting = false;
        }
        return;
      }

      // Case 2: Rotation is enabled but no URL stream is actually active (dead stream detection)
      if (this.isEnabled && this.viewBotURLService) {
        const activeStreamCount = this.viewBotURLService.activeStreams.size;

        // Also check if rotation timer exists - if not, we may have lost state
        const hasRotationTimer = this.rotationTimer !== null || this.retryState.currentRetryTimer !== null;

        if (activeStreamCount === 0) {
          // Check backoff - don't retry too fast after failures
          const timeSinceLastFailure = this.retryState.lastFailureTime
            ? Date.now() - this.retryState.lastFailureTime
            : Infinity;
          const requiredBackoff = this._calculateRetryDelay();

          if (timeSinceLastFailure < requiredBackoff) {
            // Still in backoff period, skip this check
            return;
          }

          console.log(`⚠️ ROTATION: Enabled but no active URL stream (failures: ${this.retryState.consecutiveFailures}) - starting recovery...`);
          this.isRestarting = true;
          try {
            const result = await this._rotateToNewStream();
            if (result.success) {
              console.log(`✅ ROTATION: Recovery successful: ${result.stream?.displayName}`);
              this._recordSuccess();

              // CRITICAL: Ensure rotation timer is scheduled after recovery
              if (!this.rotationTimer) {
                this._scheduleNextRotation();
              }
            } else {
              console.error(`❌ ROTATION: Recovery failed: ${result.error}`);
              this._recordFailure();
            }
          } catch (error) {
            console.error('❌ ROTATION: Recovery error:', error.message);
            this._recordFailure();
          } finally {
            this.isRestarting = false;
          }
        } else if (!hasRotationTimer && activeStreamCount > 0) {
          // Stream is active but no rotation timer - reschedule
          console.log('⚠️ ROTATION: Stream active but no rotation timer detected!');
          console.log(`   - rotationTimer: ${this.rotationTimer ? 'set' : 'null'}`);
          console.log(`   - currentRetryTimer: ${this.retryState.currentRetryTimer ? 'set' : 'null'}`);
          console.log(`   - isLocked: ${this.isLocked}`);
          console.log(`   - nextRotationAt: ${this.nextRotationAt ? new Date(this.nextRotationAt).toLocaleTimeString() : 'null'}`);
          console.log('🔄 ROTATION: Rescheduling timer to recover...');
          this._scheduleNextRotation();
        }
      }
    };

    // Run check on interval
    this.autoRestartMonitor = setInterval(runMonitorCheck, baseInterval);

    console.log('👁️ Auto-restart monitor started (with exponential backoff)');
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
   * Uses robust retry logic - never fails permanently
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

    // CRITICAL: Set state BEFORE attempting first stream
    // Both flags must be set together for consistent state
    this.isEnabled = true;
    this.shouldAutoRestart = true;
    this.stats.startedAt = Date.now();

    // Reset retry state for fresh start
    this.retryState.consecutiveFailures = 0;
    this.retryState.lastFailureTime = null;

    // Save state for persistence across restarts
    this._saveState();

    // Start auto-restart monitor if not already running
    this._startAutoRestartMonitor();

    // CRITICAL: Perform comprehensive viewbot cleanup before starting
    await this._cleanupAllViewbots();

    // Start first stream with retry logic
    const result = await this._startFirstStreamWithRetry();

    if (!result.success) {
      // CRITICAL FIX: Don't disable - keep trying via auto-restart monitor
      // The monitor will use _executeRotationWithRetry which has proper backoff
      console.log('⚠️ ROTATION: Initial stream failed but keeping rotation enabled for retry...');
      // Don't set isEnabled = false - let the system keep retrying
      return result;
    }

    // Schedule next rotation
    this._scheduleNextRotation();

    // Emit status
    this.emit('rotation-started', {
      stream: this.currentStream
    });

    if (this.io) {
      // Note: Don't include rotationTiming here - it's stale at this point.
      // The correct timing will be emitted via 'rotation-timing' event after
      // _scheduleNextRotation() is called in _executeRotationWithRetry()
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
   * Start first stream with retry logic
   * Retries a few times before returning failure (auto-restart monitor will continue)
   */
  async _startFirstStreamWithRetry() {
    const maxInitialRetries = 3;

    for (let attempt = 1; attempt <= maxInitialRetries; attempt++) {
      console.log(`🎬 ROTATION: Starting first stream (attempt ${attempt}/${maxInitialRetries})...`);

      const result = await this._rotateToNewStream();

      if (result.success) {
        this._recordSuccess();
        return result;
      }

      this._recordFailure();
      console.log(`⚠️ ROTATION: First stream attempt ${attempt} failed: ${result.error}`);

      if (attempt < maxInitialRetries) {
        const delay = this._calculateRetryDelay();
        const delaySeconds = Math.round(delay / 1000);
        console.log(`⏳ ROTATION: Waiting ${delaySeconds}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return { success: false, error: 'Failed to start initial stream after retries' };
  }

  /**
   * Comprehensive viewbot cleanup
   * Stops ALL viewbot systems to ensure clean slate for random rotation
   * CRITICAL: Must stop every viewbot system to prevent conflicts
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

    // 2. CRITICAL: Stop ViewBotRotationService (global.viewBotRotation)
    // This is a SEPARATE service from SimpleViewBotRotation!
    if (global.viewBotRotation && global.viewBotRotation.stopRotation) {
      console.log('🛑 Stopping ViewBotRotationService (global.viewBotRotation)...');
      try {
        global.viewBotRotation.enabled = false;
        await global.viewBotRotation.stopRotation();
        console.log('✅ ViewBotRotationService stopped and disabled');
      } catch (error) {
        console.error('⚠️ Error stopping ViewBotRotationService:', error.message);
      }
    }

    // 3. Stop ViewBotManager if it exists (alternative viewbot system)
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

    // 4. Stop UnifiedViewBotRotation if it exists
    if (global.unifiedViewBotRotation) {
      console.log('🛑 Stopping UnifiedViewBotRotation...');
      try {
        if (global.unifiedViewBotRotation.stopRotation) {
          await global.unifiedViewBotRotation.stopRotation();
        }
        console.log('✅ UnifiedViewBotRotation stopped');
      } catch (error) {
        console.error('⚠️ Error stopping UnifiedViewBotRotation:', error.message);
      }
    }

    // 5. CRITICAL: Stop all LiveKit viewbots and remove them from the room
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

    // CRITICAL: Clear any pending retry timer
    if (this.retryState.currentRetryTimer) {
      clearTimeout(this.retryState.currentRetryTimer);
      this.retryState.currentRetryTimer = null;
    }

    // Clear countdown announcements
    this._clearCountdownAnnouncements();

    // Reset retry state
    this.retryState.consecutiveFailures = 0;
    this.retryState.lastFailureTime = null;

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

    // Clear any pending retry timer
    if (this.retryState.currentRetryTimer) {
      clearTimeout(this.retryState.currentRetryTimer);
      this.retryState.currentRetryTimer = null;
    }

    // Reset retry state (fresh start after pause)
    this.retryState.consecutiveFailures = 0;
    this.retryState.lastFailureTime = null;

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
  async forceRotate(options = {}) {
    const { platform = null } = options;

    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    console.log(`🔄 Force rotating to new stream...${platform ? ` (platform: ${platform})` : ''}`);

    // If locked, unlock first (force rotate overrides lock)
    const wasLocked = this.isLocked;
    if (this.isLocked) {
      console.log('🔓 ROTATION: Force rotate - unlocking timer');
      this.isLocked = false;
      this.lockedAt = null;
      this.remainingTimeWhenLocked = null;
    }

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

    // Rotate (with optional platform override)
    const result = await this._rotateToNewStream({ forcePlatform: platform });

    if (result.success) {
      this._scheduleNextRotation();
      // Emit updated timing after scheduling
      this._emitRotationTiming();

      // If was locked, emit unlock event so clients update their UI
      if (wasLocked && this.io) {
        this.io.emit('rotation-unlocked', {
          locked: false,
          remainingMs: this.nextRotationAt - Date.now(),
          nextRotationAt: this.nextRotationAt,
          currentStream: this.currentStream
        });
      }
    }

    return result;
  }

  /**
   * Extend the current rotation by adding time before the next switch
   * Called when !extend vote passes
   * @param {number} minutesToAdd - Number of minutes to add (default: 4)
   * @returns {object} Result with success status
   */
  extendRotation(minutesToAdd = null) {
    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    if (!this.nextRotationAt) {
      return { success: false, error: 'No rotation scheduled' };
    }

    // Check cooldown
    if (this.lastExtendTime) {
      const timeSinceLastExtend = Date.now() - this.lastExtendTime;
      if (timeSinceLastExtend < this.extendCooldownMs) {
        const remainingCooldown = Math.ceil((this.extendCooldownMs - timeSinceLastExtend) / 1000);
        return {
          success: false,
          error: `Extend on cooldown. ${remainingCooldown} seconds remaining.`,
          cooldownRemaining: remainingCooldown
        };
      }
    }

    // Use provided minutes or default (random between 3-5)
    const extendMs = (minutesToAdd || (3 + Math.floor(Math.random() * 3))) * 60 * 1000;
    const extendMinutes = Math.round(extendMs / 60000);

    // Calculate remaining time before current rotation
    const remainingTime = this.nextRotationAt - Date.now();
    if (remainingTime <= 0) {
      return { success: false, error: 'Rotation already in progress' };
    }

    // Clear current timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Calculate new interval (remaining time + extension)
    const newInterval = remainingTime + extendMs;

    console.log(`⏰ EXTEND: Adding ${extendMinutes} minutes to rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    // Record extend time for cooldown
    this.lastExtendTime = Date.now();

    // Reschedule with the extended time
    this._scheduleNextRotation(newInterval);

    // Emit extend event
    if (this.io) {
      this.io.emit('rotation-extended', {
        extendedBy: extendMs,
        extendedByMinutes: extendMinutes,
        newNextRotationAt: this.nextRotationAt,
        currentStream: this.currentStream
      });
    }

    return {
      success: true,
      extendedByMinutes: extendMinutes,
      newNextRotationAt: this.nextRotationAt,
      message: `Extended rotation by ${extendMinutes} minutes`
    };
  }

  /**
   * Check if extend is on cooldown
   * @returns {object} Cooldown status
   */
  getExtendCooldownStatus() {
    if (!this.lastExtendTime) {
      return { onCooldown: false, remainingSeconds: 0 };
    }

    const timeSinceLastExtend = Date.now() - this.lastExtendTime;
    if (timeSinceLastExtend >= this.extendCooldownMs) {
      return { onCooldown: false, remainingSeconds: 0 };
    }

    return {
      onCooldown: true,
      remainingSeconds: Math.ceil((this.extendCooldownMs - timeSinceLastExtend) / 1000)
    };
  }

  /**
   * Admin extend - immediately adds time without vote or cooldown
   * @param {number} minutes - Minutes to add (default: 5)
   * @returns {object} Result with success status
   */
  adminExtend(minutes = 5) {
    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    if (this.isLocked) {
      return { success: false, error: 'Rotation is locked. Unlock first to extend.' };
    }

    if (!this.nextRotationAt) {
      return { success: false, error: 'No rotation scheduled' };
    }

    const extendMs = minutes * 60 * 1000;

    // Calculate remaining time before current rotation
    const remainingTime = this.nextRotationAt - Date.now();
    if (remainingTime <= 0) {
      return { success: false, error: 'Rotation already in progress' };
    }

    // Clear current timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Calculate new interval (remaining time + extension)
    const newInterval = remainingTime + extendMs;

    console.log(`⏰ ADMIN EXTEND: Adding ${minutes} minutes to rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    // Reschedule with the extended time (no cooldown for admin)
    this._scheduleNextRotation(newInterval);

    // Emit extend event
    if (this.io) {
      this.io.emit('rotation-extended', {
        extendedBy: extendMs,
        extendedByMinutes: minutes,
        newNextRotationAt: this.nextRotationAt,
        currentStream: this.currentStream,
        isAdminExtend: true
      });
    }

    return {
      success: true,
      extendedByMinutes: minutes,
      newNextRotationAt: this.nextRotationAt,
      message: `Admin extended rotation by ${minutes} minutes`
    };
  }

  /**
   * Reduce the current rotation by subtracting time before the next switch
   * Called when !reduce vote passes
   * @param {number} minutesToSubtract - Number of minutes to subtract (default: random 3-5)
   * @returns {object} Result with success status
   */
  reduceRotation(minutesToSubtract = null) {
    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    if (!this.nextRotationAt) {
      return { success: false, error: 'No rotation scheduled' };
    }

    // Check cooldown (shares cooldown with extend)
    if (this.lastExtendTime) {
      const timeSinceLastExtend = Date.now() - this.lastExtendTime;
      if (timeSinceLastExtend < this.extendCooldownMs) {
        const remainingCooldown = Math.ceil((this.extendCooldownMs - timeSinceLastExtend) / 1000);
        return {
          success: false,
          error: `Reduce on cooldown. ${remainingCooldown} seconds remaining.`,
          cooldownRemaining: remainingCooldown
        };
      }
    }

    // Use provided minutes or default (random between 3-5)
    const reduceMs = (minutesToSubtract || (3 + Math.floor(Math.random() * 3))) * 60 * 1000;
    const reduceMinutes = Math.round(reduceMs / 60000);

    // Calculate remaining time before current rotation
    const remainingTime = this.nextRotationAt - Date.now();
    if (remainingTime <= 0) {
      return { success: false, error: 'Rotation already in progress' };
    }

    // Calculate new interval (remaining time - reduction), minimum 30 seconds
    const minRemainingMs = 30 * 1000; // 30 seconds minimum
    const newInterval = Math.max(remainingTime - reduceMs, minRemainingMs);
    const actualReduction = remainingTime - newInterval;
    const actualReductionMinutes = Math.round(actualReduction / 60000 * 10) / 10;

    // Clear current timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    console.log(`⏰ REDUCE: Removing ${actualReductionMinutes} minutes from rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    // Record time for cooldown (shares with extend)
    this.lastExtendTime = Date.now();

    // Reschedule with the reduced time
    this._scheduleNextRotation(newInterval);

    // Emit reduce event
    if (this.io) {
      this.io.emit('rotation-reduced', {
        reducedBy: actualReduction,
        reducedByMinutes: actualReductionMinutes,
        newNextRotationAt: this.nextRotationAt,
        currentRotationDuration: this.currentRotationDuration,
        serverTime: Date.now(),
        currentStream: this.currentStream
      });
    }

    return {
      success: true,
      reducedByMinutes: actualReductionMinutes,
      newNextRotationAt: this.nextRotationAt,
      message: `Reduced rotation by ${actualReductionMinutes} minutes`
    };
  }

  /**
   * Admin reduce - immediately removes time without vote or cooldown
   * @param {number} minutes - Minutes to remove (default: 5)
   * @returns {object} Result with success status
   */
  adminReduce(minutes = 5) {
    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    if (this.isLocked) {
      return { success: false, error: 'Rotation is locked. Unlock first to reduce.' };
    }

    if (!this.nextRotationAt) {
      return { success: false, error: 'No rotation scheduled' };
    }

    const reduceMs = minutes * 60 * 1000;

    // Calculate remaining time before current rotation
    const remainingTime = this.nextRotationAt - Date.now();
    if (remainingTime <= 0) {
      return { success: false, error: 'Rotation already in progress' };
    }

    // Calculate new interval (remaining time - reduction), minimum 30 seconds
    const minRemainingMs = 30 * 1000; // 30 seconds minimum
    const newInterval = Math.max(remainingTime - reduceMs, minRemainingMs);
    const actualReduction = remainingTime - newInterval;
    const actualReductionMinutes = Math.round(actualReduction / 60000 * 10) / 10;

    // Clear current timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    console.log(`⏰ ADMIN REDUCE: Removing ${actualReductionMinutes} minutes from rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    // Reschedule with the reduced time (no cooldown for admin)
    this._scheduleNextRotation(newInterval);

    // Emit reduce event
    if (this.io) {
      this.io.emit('rotation-reduced', {
        reducedBy: actualReduction,
        reducedByMinutes: actualReductionMinutes,
        newNextRotationAt: this.nextRotationAt,
        currentRotationDuration: this.currentRotationDuration,
        serverTime: Date.now(),
        currentStream: this.currentStream,
        isAdminReduce: true
      });
    }

    return {
      success: true,
      reducedByMinutes: actualReductionMinutes,
      newNextRotationAt: this.nextRotationAt,
      message: `Admin reduced rotation by ${actualReductionMinutes} minutes`
    };
  }

  /**
   * Lock the rotation timer - freezes the countdown
   * @returns {object} Result with success status
   */
  lockRotation() {
    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    if (this.isLocked) {
      return { success: false, error: 'Rotation is already locked' };
    }

    if (!this.nextRotationAt) {
      return { success: false, error: 'No rotation scheduled' };
    }

    // Store remaining time
    this.remainingTimeWhenLocked = this.nextRotationAt - Date.now();
    if (this.remainingTimeWhenLocked <= 0) {
      return { success: false, error: 'Rotation already in progress' };
    }

    // Clear the rotation timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Also clear any pending retry timer
    if (this.retryState.currentRetryTimer) {
      clearTimeout(this.retryState.currentRetryTimer);
      this.retryState.currentRetryTimer = null;
      console.log('🔒 ROTATION: Also cleared pending retry timer');
    }

    // Clear countdown announcements
    this._clearCountdownAnnouncements();

    this.isLocked = true;
    this.lockedAt = Date.now();

    console.log(`🔒 ROTATION LOCKED: Timer frozen with ${Math.round(this.remainingTimeWhenLocked / 1000)} seconds remaining`);

    // Emit lock event
    if (this.io) {
      this.io.emit('rotation-locked', {
        locked: true,
        remainingMs: this.remainingTimeWhenLocked,
        currentStream: this.currentStream
      });
    }

    return {
      success: true,
      remainingMs: this.remainingTimeWhenLocked,
      message: `Rotation locked with ${Math.round(this.remainingTimeWhenLocked / 1000)} seconds remaining`
    };
  }

  /**
   * Unlock the rotation timer - resumes the countdown
   * @returns {object} Result with success status
   */
  unlockRotation() {
    if (!this.isEnabled) {
      return { success: false, error: 'Rotation not enabled' };
    }

    if (!this.isLocked) {
      return { success: false, error: 'Rotation is not locked' };
    }

    const remainingTime = this.remainingTimeWhenLocked;

    // Clear lock state
    this.isLocked = false;
    this.lockedAt = null;
    this.remainingTimeWhenLocked = null;

    console.log(`🔓 ROTATION UNLOCKED: Resuming timer with ${Math.round(remainingTime / 1000)} seconds remaining`);

    // Resume the timer with the remaining time
    this._scheduleNextRotation(remainingTime);

    // Emit unlock event
    if (this.io) {
      this.io.emit('rotation-unlocked', {
        locked: false,
        remainingMs: remainingTime,
        nextRotationAt: this.nextRotationAt,
        currentStream: this.currentStream
      });
    }

    return {
      success: true,
      remainingMs: remainingTime,
      nextRotationAt: this.nextRotationAt,
      message: `Rotation unlocked, resuming with ${Math.round(remainingTime / 1000)} seconds remaining`
    };
  }

  /**
   * Get lock status
   * @returns {object} Lock status
   */
  getLockStatus() {
    return {
      isLocked: this.isLocked,
      lockedAt: this.lockedAt,
      remainingTimeWhenLocked: this.remainingTimeWhenLocked
    };
  }

  /**
   * Internal: Rotate to a new random stream
   */
  async _rotateToNewStream(options = {}) {
    const { forcePlatform = null } = options;

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

      // Select platform - use forcePlatform if specified, otherwise random
      let platform;
      if (forcePlatform && ['kick', 'twitch'].includes(forcePlatform.toLowerCase())) {
        platform = forcePlatform.toLowerCase();
        console.log(`🎯 Forced platform: ${platform}`);
      } else {
        platform = this.selectRandomPlatform();
        if (!platform) {
          return { success: false, error: 'No platforms available' };
        }
        console.log(`🎲 Selected platform: ${platform}`);
      }

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
        autoReconnect: true,
        kickUsername: streamer.platform === 'kick' ? streamer.username : null  // Pass username for Kick token refresh
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
        // NOTE: random-rotation-status is now emitted via _emitFullRotationStatus()
        // after _scheduleNextRotation() so timing data is accurate

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
   * Uses robust retry logic with exponential backoff
   */
  _scheduleNextRotation(customInterval = null) {
    // ALWAYS clear any existing rotation timer first to prevent orphaned timers
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    const interval = customInterval !== null ? customInterval : this.getRandomInterval();
    const minutes = Math.round(interval / 60000 * 10) / 10;

    // Track next rotation time
    this.nextRotationAt = Date.now() + interval;
    this.currentRotationDuration = interval;

    console.log(`⏱️ Next rotation in ${minutes} minutes (at ${new Date(this.nextRotationAt).toLocaleTimeString()})`);

    // Emit rotation timing to clients
    this._emitRotationTiming();

    // Schedule countdown announcements (2 min, 1 min, 30 sec warnings)
    this._scheduleCountdownAnnouncements();

    this.rotationTimer = setTimeout(async () => {
      try {
        console.log('⏰ ROTATION TIMER FIRED - executing rotation callback...');

        if (!this.isEnabled) {
          console.log('⏭️ ROTATION: Skipping - rotation not enabled');
          return;
        }

        // Check if locked - don't rotate when locked
        if (this.isLocked) {
          console.log('🔒 ROTATION: Skipping scheduled rotation - timer is locked');
          return; // Don't reschedule - will resume when unlocked
        }

        // Check if already restarting (mutex)
        if (this.isRestarting) {
          console.log('⏳ ROTATION: Skipping scheduled rotation - restart in progress');
          this._scheduleNextRotation(); // Reschedule for later
          return;
        }

        await this._executeRotationWithRetry();
      } catch (error) {
        console.error('❌ ROTATION TIMER ERROR:', error.message);
        console.error(error.stack);

        // CRITICAL: Always reschedule on error to prevent stuck state
        if (this.isEnabled && !this.isLocked) {
          console.log('🔄 ROTATION: Rescheduling after error...');
          this._scheduleNextRotation();
        }
      }
    }, interval);
  }

  /**
   * Emit rotation timing information to all connected clients
   */
  _emitRotationTiming() {
    if (this.io && this.isEnabled) {
      this.io.emit('rotation-timing', {
        nextRotationAt: this.nextRotationAt,
        currentRotationDuration: this.currentRotationDuration,
        serverTime: Date.now()
      });
    }
  }

  /**
   * Emit complete rotation status WITH timing data
   * Called after scheduling so timing is accurate
   */
  _emitFullRotationStatus() {
    if (this.io && this.isEnabled && this.currentStream) {
      console.log('📡 EMITTING full rotation status with timing');
      this.io.emit('random-rotation-status', {
        enabled: true,
        currentStream: this.currentStream,
        rotationTiming: {
          nextRotationAt: this.nextRotationAt,
          currentRotationDuration: this.currentRotationDuration,
          serverTime: Date.now()
        }
      });
    }
  }

  /**
   * Clear all countdown announcement timers
   */
  _clearCountdownAnnouncements() {
    this.countdownAnnouncementTimers.forEach(timer => clearTimeout(timer));
    this.countdownAnnouncementTimers = [];
  }

  /**
   * Schedule countdown announcements for the current rotation
   * Sends helpful messages at key intervals to encourage engagement
   */
  _scheduleCountdownAnnouncements() {
    // Clear any existing timers first
    this._clearCountdownAnnouncements();

    if (!this.nextRotationAt || !this.isEnabled) return;

    const remainingMs = this.nextRotationAt - Date.now();

    // Define announcements with time remaining (in ms) and messages
    // Messages rotate to add variety
    const announcements = [
      {
        timeRemaining: 180000, // 3 minutes
        messages: [
          "📺 3 minutes until we switch! Use !extend to add more time or !next to skip ahead!",
          "⏰ Stream switching in 3 minutes! Like it? !extend to stay. Bored? !next to skip!",
          "🎬 3 min warning! Vote !extend to keep watching or !next to find something new!"
        ]
      },
      {
        timeRemaining: 60000, // 1 minute
        messages: [
          "⚠️ 1 minute left! Quick - use !extend to keep watching or !next to skip to something new!",
          "🔔 60 seconds! Vote !extend to add time, !next to skip, or !lock to freeze the timer!",
          "⏰ Final minute! Enjoying this stream? !extend to stay, !next to move on!"
        ]
      },
      {
        timeRemaining: 30000, // 30 seconds
        messages: [
          "🚨 30 seconds! Last chance to !extend or !lock if you want to keep watching!",
          "⚡ 30 sec warning! !extend to add time, !next to skip now!",
          "⏱️ Switching soon! Use !extend, !next, or !lock before time runs out!"
        ]
      }
    ];

    // Schedule each announcement
    announcements.forEach(announcement => {
      const delay = remainingMs - announcement.timeRemaining;

      // Only schedule if there's enough time remaining
      if (delay > 0) {
        const timer = setTimeout(() => {
          // Don't announce if locked or disabled
          if (this.isLocked || !this.isEnabled) return;

          // Pick a random message from the array
          const message = announcement.messages[Math.floor(Math.random() * announcement.messages.length)];
          this.sendChatAnnouncement(message);
        }, delay);

        this.countdownAnnouncementTimers.push(timer);
      }
    });

    console.log(`📢 Scheduled ${this.countdownAnnouncementTimers.length} countdown announcements`);
  }

  /**
   * Execute rotation with robust retry logic
   * CRITICAL: Never gives up permanently - always reschedules
   */
  async _executeRotationWithRetry() {
    if (!this.isEnabled) return;

    // Check if locked - don't rotate when locked
    if (this.isLocked) {
      console.log('🔒 ROTATION: Skipping rotation - timer is locked');
      return;
    }

    const result = await this._rotateToNewStream();

    if (result.success) {
      this._recordSuccess();
      this._scheduleNextRotation();
      // Emit complete status WITH timing after scheduling
      this._emitFullRotationStatus();
    } else {
      this._recordFailure();
      console.log(`⚠️ ROTATION: Failed (${this.retryState.consecutiveFailures} consecutive failures): ${result.error}`);

      // Use exponential backoff retry
      const retryResult = await this._scheduleRetryWithBackoff(
        () => this._executeRotationWithRetry(),
        'scheduled rotation'
      );

      // If retry eventually succeeded, the recursive call handled scheduling
      // If we get here and rotation is still enabled but no timer, something went wrong - reschedule
      if (this.isEnabled && !this.rotationTimer && !this.retryState.currentRetryTimer) {
        console.log('⚠️ ROTATION: No timer active after retry - rescheduling...');
        this._scheduleNextRotation();
      }
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    const now = Date.now();

    return {
      enabled: this.isEnabled,
      currentStream: this.currentStream,
      // Rotation timing info for countdown timer
      rotationTiming: {
        nextRotationAt: this.nextRotationAt,
        currentRotationDuration: this.currentRotationDuration,
        remainingMs: this.nextRotationAt ? Math.max(0, this.nextRotationAt - now) : null,
        serverTime: now
      },
      // Extend cooldown status
      extendCooldown: this.getExtendCooldownStatus(),
      stats: {
        ...this.stats,
        uptime: this.stats.startedAt ? now - this.stats.startedAt : 0
      },
      settings: this.settings,
      twitchConfigured: this.twitchService.isConfigured(),
      kickConfigured: true, // Kick doesn't need API keys
      availablePlatforms: this._getAvailablePlatforms(),
      // Retry state for debugging
      retryState: {
        consecutiveFailures: this.retryState.consecutiveFailures,
        hasRetryPending: this.retryState.currentRetryTimer !== null,
        hasRotationTimer: this.rotationTimer !== null,
        lastFailure: this.retryState.lastFailureTime
          ? new Date(this.retryState.lastFailureTime).toISOString()
          : null,
        lastSuccess: this.retryState.lastSuccessTime
          ? new Date(this.retryState.lastSuccessTime).toISOString()
          : null
      }
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
