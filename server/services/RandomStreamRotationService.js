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
const path = require('path');

const RotationRetryState = require('./random-stream/RotationRetryState');
const AnimalNameGenerator = require('./random-stream/AnimalNameGenerator');
const RotationAnnouncer = require('./random-stream/RotationAnnouncer');
const PlatformSelector = require('./random-stream/PlatformSelector');
const RotationScheduler = require('./random-stream/RotationScheduler');
const RotationTimerController = require('./random-stream/RotationTimerController');
const RotationStatePersistence = require('./random-stream/RotationStatePersistence');
const RotationRecoveryMonitor = require('./random-stream/RotationRecoveryMonitor');

const logger = require('../bootstrap/logger').child({ svc: 'RandomStreamRotationService' });

// Persistence file for enabled state
const STATE_FILE = path.join(__dirname, '../data/random-rotation-state.json');

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
    // `rotationTimer`, `nextRotationAt`, `currentRotationDuration`, and
    // `countdownAnnouncementTimers` moved to RotationScheduler in PR 17.3.
    // They're re-exposed below as property accessors so existing consumers
    // (lifecycle methods, manual-control verbs, getStatus, auto-restart
    // monitor) keep working byte-equivalent.

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

    // Retry state machine (PR 17.1) — extracted to RotationRetryState. The
    // helper owns config + state; we expose `this.retryConfig` and
    // `this.retryState` as references to its internal objects so existing
    // in-file read sites (auto-restart monitor, lifecycle, getStatus, etc.)
    // remain byte-equivalent.
    this._retryHelper = new RotationRetryState({
      maxRetries: 5,
      baseDelayMs: 1500,
      maxDelayMs: 60000,
      backoffMultiplier: 2,
    });
    this.retryConfig = this._retryHelper.config;
    this.retryState = this._retryHelper.state;

    // Animal name generator (PR 17.1) — extracted. `this.usedAnimalNames`
    // aliases the generator's internal Set so `clearStats()` keeps working.
    this._animalNameGen = new AnimalNameGenerator({ logger });
    this.usedAnimalNames = this._animalNameGen.usedNames;

    // Chat announcement composer (PR 17.1) — extracted.
    this._announcer = new RotationAnnouncer();

    // Extend cooldown + lock state (PR 17.4) — moved to RotationTimerController.
    // `lastExtendTime`, `extendCooldownMs`, `extendMinutes`, `isLocked`,
    // `lockedAt`, `remainingTimeWhenLocked` are re-exposed below as accessors.

    // Platform selector (PR 17.1) — extracted. Holds refs to the inner Twitch
    // + Kick services that the constructor just instantiated.
    this._platformSelector = new PlatformSelector({
      twitchService: this.twitchService,
      kickService: this.kickService,
    });

    // Scheduler (PR 17.3) — owns the rotation timer, countdown-announcement
    // timer set, and the "when does the next rotation fire" bookkeeping.
    // Property accessors below proxy `this.rotationTimer`/`this.nextRotationAt`/
    // `this.currentRotationDuration`/`this.countdownAnnouncementTimers` to the
    // scheduler's slots so consumers that read or set these fields directly
    // (lifecycle, manual-control verbs, getStatus, auto-restart monitor) keep
    // working byte-equivalent.
    this._scheduler = new RotationScheduler({ host: this, logger });

    // Manual-control verbs + extend-cooldown/lock state (PR 17.4) — extracted.
    this._timerController = new RotationTimerController({ host: this, logger });

    // Persistence + recovery monitor (PR 17.5) — extracted. Persistence must
    // be constructed before the _loadState() call below; the recovery monitor
    // owns the autoRestartMonitor interval handle (re-exposed via accessor).
    this._persistence = new RotationStatePersistence({ host: this, stateFile: STATE_FILE, logger });
    this._recoveryMonitor = new RotationRecoveryMonitor({ host: this, logger });

    logger.debug('🎲 RandomStreamRotationService initialized');

    // Load persisted state
    this._loadState();
  }

  // ---- PR 17.3: scheduler state accessors -------------------------------
  // Direct proxies to `this._scheduler.*`. Consumers (lifecycle, verbs,
  // monitor) continue to read/write `this.rotationTimer` etc. unchanged.
  get rotationTimer() { return this._scheduler.rotationTimer; }
  set rotationTimer(v) { this._scheduler.rotationTimer = v; }
  get nextRotationAt() { return this._scheduler.nextRotationAt; }
  set nextRotationAt(v) { this._scheduler.nextRotationAt = v; }
  get currentRotationDuration() { return this._scheduler.currentRotationDuration; }
  set currentRotationDuration(v) { this._scheduler.currentRotationDuration = v; }
  get countdownAnnouncementTimers() { return this._scheduler.countdownAnnouncementTimers; }
  set countdownAnnouncementTimers(v) { this._scheduler.countdownAnnouncementTimers = v; }

  // ---- PR 17.3: scheduler method delegates ------------------------------
  // Public + private method names preserved so external consumers (auto-
  // restart monitor reads `this.rotationTimer`; ModerationActionArbiter
  // calls `_rotateToNewStream` directly; tests stub these) keep working.
  _scheduleNextRotation(customInterval = null) { return this._scheduler.scheduleNext(customInterval); }
  _emitRotationTiming() { return this._scheduler.emitRotationTiming(); }
  _emitFullRotationStatus() { return this._scheduler.emitFullRotationStatus(); }
  _clearCountdownAnnouncements() { return this._scheduler.clearCountdownAnnouncements(); }
  _scheduleCountdownAnnouncements() { return this._scheduler.scheduleCountdownAnnouncements(); }
  async _executeRotationWithRetry() { return this._scheduler.executeRotationWithRetry(); }

  // ---- PR 17.4: timer-controller state accessors ------------------------
  // Direct proxies to `this._timerController.*`. Consumers (getStatus, the
  // auto-restart monitor, the stream-ended listener's probes, the retry
  // helper's isLocked checks) continue to read/write `this.isLocked` etc.
  // unchanged.
  get isLocked() { return this._timerController.isLocked; }
  set isLocked(v) { this._timerController.isLocked = v; }
  get lockedAt() { return this._timerController.lockedAt; }
  set lockedAt(v) { this._timerController.lockedAt = v; }
  get remainingTimeWhenLocked() { return this._timerController.remainingTimeWhenLocked; }
  set remainingTimeWhenLocked(v) { this._timerController.remainingTimeWhenLocked = v; }
  get lastExtendTime() { return this._timerController.lastExtendTime; }
  set lastExtendTime(v) { this._timerController.lastExtendTime = v; }
  get extendCooldownMs() { return this._timerController.extendCooldownMs; }
  set extendCooldownMs(v) { this._timerController.extendCooldownMs = v; }
  get extendMinutes() { return this._timerController.extendMinutes; }
  set extendMinutes(v) { this._timerController.extendMinutes = v; }

  // ---- PR 17.4: timer-controller method delegates -----------------------
  // Public names preserved (chat-service /api/random-stream/* + admin UI +
  // tests call these). extendRotation→extend, reduceRotation→reduce,
  // lockRotation→lock, unlockRotation→unlock; the rest keep their names.
  forceRotate(options = {}) { return this._timerController.forceRotate(options); }
  extendRotation(minutesToAdd = null) { return this._timerController.extend(minutesToAdd); }
  adminExtend(minutes = 5) { return this._timerController.adminExtend(minutes); }
  reduceRotation(minutesToSubtract = null) { return this._timerController.reduce(minutesToSubtract); }
  adminReduce(minutes = 5) { return this._timerController.adminReduce(minutes); }
  lockRotation() { return this._timerController.lock(); }
  unlockRotation() { return this._timerController.unlock(); }
  getLockStatus() { return this._timerController.getLockStatus(); }
  getExtendCooldownStatus() { return this._timerController.getExtendCooldownStatus(); }

  // ---- PR 17.5: persistence + recovery-monitor delegates ----------------
  // `autoRestartMonitor` (the 5s poll interval handle) lives on the recovery
  // monitor; re-exposed so `stop()`'s `clearInterval(this.autoRestartMonitor)`
  // keeps working. Method names preserved (setSocketIO calls
  // _setupStreamEndedListener; start/stop/settings-update call _saveState).
  get autoRestartMonitor() { return this._recoveryMonitor.autoRestartMonitor; }
  set autoRestartMonitor(v) { this._recoveryMonitor.autoRestartMonitor = v; }
  _saveState() { return this._persistence.save(); }
  _loadState() { return this._persistence.load(); }
  _setupStreamEndedListener() { return this._recoveryMonitor.setupStreamEndedListener(); }
  _startAutoRestartMonitor() { return this._recoveryMonitor.startAutoRestartMonitor(); }
  _hasRealStreamer() { return this._recoveryMonitor.hasRealStreamer(); }

  // Retry/backoff math lives in RotationRetryState (server/services/random-stream/).
  // These methods stay on the main class as thin delegates so callers (including
  // private call-sites elsewhere in this file) keep working unchanged.
  _calculateRetryDelay() { return this._retryHelper.calculateRetryDelay(); }
  _recordSuccess() { return this._retryHelper.recordSuccess(); }
  _recordFailure() { return this._retryHelper.recordFailure(); }
  _shouldRetry() { return this._retryHelper.shouldRetry(); }
  async _scheduleRetryWithBackoff(operation, operationName) {
    return this._retryHelper.scheduleRetryWithBackoff(operation, operationName, {
      isLocked: () => this.isLocked,
      logger,
    });
  }

  /**
   * Auto-start if persisted state says we should be enabled
   * Called after all dependencies are set
   */
  async autoStartIfEnabled() {
    if (this.shouldAutoRestart && !this.isEnabled && !this.isRestarting) {
      logger.debug('🔄 Auto-starting random rotation (persisted state)');
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
    logger.debug('✅ ViewBotURLService registered with RandomStreamRotation');

    // CRITICAL: Listen for URL stream failures to auto-rotate to next stream
    if (service) {
      service.on('url-stream-ended', async (data) => {
        const { urlId, reason } = data;
        logger.debug(`🔔 ROTATION: URL stream ${urlId} ended (reason: ${reason})`);

        // Only auto-rotate if the stream failed (not manual stop)
        const shouldRotate = ['error', 'reconnect_failed', 'source_ended', 'health-check', 'http_error'].includes(reason);

        if (shouldRotate && this.isEnabled) {
          logger.debug(`🔄 ROTATION: Auto-rotating to next stream due to ${reason}...`);

          // Announce to chat that stream disconnected and we're finding a new one
          this.sendChatAnnouncement('Stream disconnected - finding a new streamer...');

          // Small delay to let cleanup complete (shorter for HTTP errors since no reconnect was attempted)
          const cleanupDelay = reason === 'http_error' ? 500 : 1500;
          await new Promise(resolve => setTimeout(resolve, cleanupDelay));

          // CRITICAL: Check if service is busy (reconnecting or starting new stream)
          if (this.viewBotURLService.isBusy()) {
            logger.debug('⏳ ROTATION: Service is busy (reconnecting/starting), skipping auto-rotation');
            return;
          }

          // Check if already restarting or retry timer pending
          if (this.isRestarting || this.retryState.currentRetryTimer) {
            logger.debug('⏳ ROTATION: Already restarting or retry pending, skipping auto-rotation');
            return;
          }

          // Check if another stream started in the meantime
          if (this.viewBotURLService.activeStreams.size === 0) {
            this.isRestarting = true;
            try {
              const result = await this._rotateToNewStream();
              if (result.success) {
                logger.debug(`✅ ROTATION: Auto-rotated to new stream: ${result.stream?.displayName}`);
                this._recordSuccess();

                // Ensure rotation timer is scheduled
                if (!this.rotationTimer) {
                  this._scheduleNextRotation();
                }
              } else {
                logger.error(`❌ ROTATION: Auto-rotation failed: ${result.error}`);
                this._recordFailure();
                // Auto-restart monitor will handle retry with backoff
              }
            } catch (error) {
              logger.error(`❌ ROTATION: Auto-rotation error:`, error.message);
              this._recordFailure();
            } finally {
              this.isRestarting = false;
            }
          } else {
            logger.debug('⏭️ ROTATION: Another stream already started, skipping auto-rotation');
            this._recordSuccess(); // Stream recovered on its own
          }
        }
      });
      logger.debug('✅ URL stream failure listener registered for auto-rotation');
    }
  }

  setViewBotRotation(rotation) {
    this.viewBotRotation = rotation;
    logger.debug('✅ ViewBotRotation registered with RandomStreamRotation');
  }

  /**
   * Inject the WhitelistService (ADR-0010, PR-W3) and fan it out to the
   * inner Twitch + Kick random services so their candidate filters consult
   * the same per-platform allow/block lists + CCL gate.
   */
  setWhitelistService(whitelistService) {
    this.whitelistService = whitelistService;
    if (this.twitchService && typeof this.twitchService.setWhitelistService === 'function') {
      this.twitchService.setWhitelistService(whitelistService);
    }
    if (this.kickService && typeof this.kickService.setWhitelistService === 'function') {
      this.kickService.setWhitelistService(whitelistService);
    }
    logger.debug('✅ WhitelistService registered with RandomStreamRotation');
  }

  setSocketIO(io) {
    this.io = io;
    logger.debug('✅ Socket.IO registered with RandomStreamRotation');

    // Listen for stream-ended events to auto-restart rotation
    if (io) {
      // Use a separate handler that checks if we should auto-restart
      this._setupStreamEndedListener();
    }
  }

  /**
   * Set the StreamNotifier (PR 3.1) for `stream-ended` emits.
   */
  setStreamNotifier(streamNotifier) {
    this.streamNotifier = streamNotifier;
    logger.debug('✅ StreamNotifier registered with RandomStreamRotation');
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

      logger.debug('📢 Rotation announcement sent to chat');
    } catch (error) {
      logger.error('❌ Failed to send rotation announcement:', error.message);
    }
  }

  // Pure helpers extracted (PR 17.1) to server/services/random-stream/.
  // Public method names preserved as thin delegates so external callers
  // (routes/random-stream.js calls generateAnimalName() directly) keep
  // working unchanged.
  generateRotationAnnouncement(streamer) { return this._announcer.generate(streamer); }
  generateAnimalName() { return this._animalNameGen.generate(); }
  getRandomInterval() { return this._platformSelector.getRandomInterval(this.settings); }
  isReady() { return this._platformSelector.isReady(this.settings, this.viewBotURLService); }
  selectRandomPlatform() { return this._platformSelector.selectRandom(this.settings); }

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
      logger.debug('⚠️ Random rotation already running');
      return { success: false, error: 'Already running' };
    }

    logger.debug('🎬 Starting random stream rotation...');

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
      logger.debug('⚠️ ROTATION: Initial stream failed but keeping rotation enabled for retry...');
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
      logger.debug(`🎬 ROTATION: Starting first stream (attempt ${attempt}/${maxInitialRetries})...`);

      const result = await this._rotateToNewStream();

      if (result.success) {
        this._recordSuccess();
        return result;
      }

      this._recordFailure();
      logger.debug(`⚠️ ROTATION: First stream attempt ${attempt} failed: ${result.error}`);

      if (attempt < maxInitialRetries) {
        const delay = this._calculateRetryDelay();
        const delaySeconds = Math.round(delay / 1000);
        logger.debug(`⏳ ROTATION: Waiting ${delaySeconds}s before retry...`);
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
    logger.debug('🧹 Performing comprehensive viewbot cleanup...');

    // 1. Stop SimpleViewBotRotation (primary viewbot system)
    if (this.viewBotRotation) {
      logger.debug('🛑 Stopping SimpleViewBotRotation...');
      // Disable the rotation to prevent auto-restart
      this.viewBotRotation.settings.enabled = false;
      // Stop and wait for cleanup
      await this.viewBotRotation.stopRotation();
      logger.debug('✅ SimpleViewBotRotation stopped and disabled');
    }

    // 2. CRITICAL: Stop ViewBotRotationService (global.viewBotRotation)
    // This is a SEPARATE service from SimpleViewBotRotation!
    if (global.viewBotRotation && global.viewBotRotation.stopRotation) {
      logger.debug('🛑 Stopping ViewBotRotationService (global.viewBotRotation)...');
      try {
        global.viewBotRotation.enabled = false;
        await global.viewBotRotation.stopRotation();
        logger.debug('✅ ViewBotRotationService stopped and disabled');
      } catch (error) {
        logger.error('⚠️ Error stopping ViewBotRotationService:', error.message);
      }
    }

    // 3. Stop ViewBotManager if it exists (alternative viewbot system)
    if (global.viewBotManager) {
      logger.debug('🛑 Stopping ViewBotManager...');
      try {
        // Stop rotation first
        global.viewBotManager.stopRotation();
        // Then cleanup all bots
        await global.viewBotManager.cleanup();
        logger.debug('✅ ViewBotManager cleaned up');
      } catch (error) {
        logger.error('⚠️ Error cleaning up ViewBotManager:', error.message);
      }
    }

    // 4. Stop UnifiedViewBotRotation if it exists
    if (global.unifiedViewBotRotation) {
      logger.debug('🛑 Stopping UnifiedViewBotRotation...');
      try {
        if (global.unifiedViewBotRotation.stopRotation) {
          await global.unifiedViewBotRotation.stopRotation();
        }
        logger.debug('✅ UnifiedViewBotRotation stopped');
      } catch (error) {
        logger.error('⚠️ Error stopping UnifiedViewBotRotation:', error.message);
      }
    }

    // 5. CRITICAL: Stop all LiveKit viewbots and remove them from the room
    if (global.viewBotLiveKitService) {
      logger.debug('🛑 Stopping all LiveKit viewbots...');
      try {
        await global.viewBotLiveKitService.stopAllViewBots();
        logger.debug('✅ All LiveKit viewbots stopped');
      } catch (error) {
        logger.error('⚠️ Error stopping LiveKit viewbots:', error.message);
      }
    }

    // 4. Clear current streamer from StreamService (viewbot was the current streamer)
    if (global.streamService) {
      const currentStreamer = global.streamService.getCurrentStreamer();
      if (currentStreamer && (currentStreamer.startsWith('viewbot-') || currentStreamer.includes('viewbot'))) {
        logger.debug(`🧹 Clearing viewbot streamer: ${currentStreamer}`);
        global.streamService.clearStreamer();
      }
    }

    // 5. Clear MediasoupService/WebRTCAdapter currentStreamer
    if (global.mediasoupService && global.mediasoupService.currentStreamer) {
      const current = global.mediasoupService.currentStreamer;
      if (current.startsWith('viewbot-') || current.includes('viewbot')) {
        logger.debug(`🧹 Clearing MediaSoup viewbot streamer: ${current}`);
        global.mediasoupService.currentStreamer = null;
      }
    }

    // 6. Emit stream-ended to notify viewers the current content is ending
    // PR 3.1: routed through StreamNotifier (single chokepoint).
    if (this.streamNotifier) {
      logger.debug('📢 Broadcasting stream-ended to prepare for rotation...');
      this.streamNotifier.streamEnded({
        reason: 'random_rotation_starting',
        isRandomRotation: true,
      });
    }

    // Brief pause to allow cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    logger.debug('✅ Viewbot cleanup complete');
  }

  /**
   * Stop the random stream rotation
   */
  async stop() {
    if (!this.isEnabled && !this.shouldAutoRestart) {
      logger.debug('⚠️ Random rotation not running');
      return { success: false, error: 'Not running' };
    }

    logger.debug('⏹️ Stopping random stream rotation...');

    const stoppingStream = this.currentStream;
    this.isEnabled = false;
    this.shouldAutoRestart = false; // Disable auto-restart

    // Stop auto-restart monitor
    if (this.autoRestartMonitor) {
      clearInterval(this.autoRestartMonitor);
      this.autoRestartMonitor = null;
      logger.debug('🛑 Auto-restart monitor stopped');
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
      logger.debug('▶️ Re-enabling viewbot rotation');
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
    }

    // Emit stream-ended event (PR 3.1 chokepoint — independent of this.io
    // because the notifier holds its own io ref).
    if (this.streamNotifier) {
      this.streamNotifier.streamEnded({
        reason: 'random_rotation_stopped',
        streamerId: stoppingStream?.urlId,
        isRandomRotation: true,
      });
    }

    logger.debug('✅ Random stream rotation stopped');
    return { success: true };
  }

  /**
   * Pause rotation (when a real streamer takes over)
   * Keeps auto-restart enabled so it resumes when the real streamer stops
   */
  async pause() {
    if (!this.isEnabled) {
      logger.debug('⚠️ Random rotation not running, nothing to pause');
      return { success: false, error: 'Not running' };
    }

    logger.debug('⏸️ Pausing random stream rotation (real streamer taking over)...');

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

    logger.debug('✅ Random stream rotation paused (will auto-restart when streamer ends)');
    return { success: true };
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
        logger.debug(`⏹️ Stopping current stream: ${this.currentStream.displayName}`);

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
        logger.debug(`🎯 Forced platform: ${platform}`);
      } else {
        platform = this.selectRandomPlatform();
        if (!platform) {
          return { success: false, error: 'No platforms available' };
        }
        logger.debug(`🎲 Selected platform: ${platform}`);
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
        logger.debug(`⚠️ No streamer found on ${platform}, trying other platform...`);

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
      logger.debug(`${platformIcon} Connecting to: ${streamer.displayName} (${streamer.game}) on ${streamer.platform} as "${animalName}"`);

      // For Kick streams, use the direct HLS playback URL if available
      // (streamlink doesn't support Kick, so we need the direct URL)
      const streamUrl = streamer.playbackUrl || streamer.url;
      if (streamer.platform === 'kick' && streamer.playbackUrl) {
        logger.debug(`🟢 Using direct Kick HLS URL: ${streamer.playbackUrl}`);
      }

      // Start URL stream
      const result = await this.viewBotURLService.startURLStream(streamUrl, {
        quality: 'best',
        displayName: animalName,
        autoReconnect: true,
        kickUsername: streamer.platform === 'kick' ? streamer.username : null  // Pass username for Kick token refresh
      });

      if (!result.success) {
        logger.error(`❌ Failed to start stream: ${result.error}`);
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

      logger.debug(`✅ Now streaming: "${animalName}" (${streamer.displayName} playing ${streamer.game} on ${streamer.platform})`);

      // Send announcement to chat
      const announcement = this.generateRotationAnnouncement(streamer);
      this.sendChatAnnouncement(announcement);

      return { success: true, stream: this.currentStream };

    } catch (error) {
      logger.error('❌ Error rotating stream:', error.message);
      return { success: false, error: error.message };
    }
  }

  // _scheduleNextRotation, _emitRotationTiming, _emitFullRotationStatus,
  // _clearCountdownAnnouncements, _scheduleCountdownAnnouncements, and
  // _executeRotationWithRetry moved to RotationScheduler (PR 17.3). Thin
  // delegates kept above the constructor as class methods.

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

    logger.debug('⚙️ Settings updated:', this.settings);
    this._saveState();
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
    logger.debug('🧹 Stats cleared');
  }
}

module.exports = RandomStreamRotationService;
