/**
 * UnifiedViewBotRotation.js - Unified rotation system for both Plain RTP and WebRTC viewbots
 * 
 * This controller manages rotation for both types of viewbots and can switch between them
 * based on configuration or runtime requirements
 */

// SimpleViewBotRotation is a singleton instance, not a class
const simpleViewBotRotationInstance = require('./SimpleViewBotRotation');
const WebRTCViewBotRotation = require('./WebRTCViewBotRotation');

const logger = require('../bootstrap/logger').child({ svc: 'UnifiedViewBotRotation' });
class UnifiedViewBotRotation {
  constructor(io, streamService, mediasoupService, livekitService, streamNotifier = null, deps = {}) {
    this.io = io;
    this.streamService = streamService;
    this.mediasoupService = mediasoupService;
    this.livekitService = livekitService;
    // PR 3.1: thread the StreamNotifier into WebRTCViewBotRotation so its
    // `stream-ended` emit goes through the chokepoint.
    this.streamNotifier = streamNotifier;

    // PR 8.2 (Phase 8 — see ADR-0016): watchdog dep overrides. Tests inject
    // a smaller `watchdogCheckMs`, a controllable `now`, and a spyable
    // `watchdogLogger`. Production uses the defaults.
    this.watchdogCheckMs = deps.watchdogCheckMs ?? 30000;
    this.watchdogLogger = deps.watchdogLogger ?? console;
    this.watchdogNow = deps.now ?? (() => Date.now());
    this.watchdogInterval = null;

    // Detect which backend to use
    const useAdapter = process.env.USE_WEBRTC_ADAPTER === 'true';
    const backend = process.env.WEBRTC_BACKEND || 'mediasoup';
    this.backendType = (useAdapter && backend === 'livekit') ? 'livekit' : 'mediasoup';

    // Current mode - default to plainrtp since WebRTC viewbots have GStreamer issues
    this.mode = 'plainrtp'; // 'plainrtp' or 'webrtc'

    // Rotation instances
    this.plainRtpRotation = null;
    this.webRtcRotation = null;
    this.activeRotation = null;

    // Shared state
    this.videoFiles = [];
    this.isRotating = false;

    logger.debug(`🎮 UnifiedViewBotRotation: Initialized with ${this.backendType} backend`);
  }
  
  /**
   * Initialize both rotation systems
   */
  async initialize(videoFiles) {
    this.videoFiles = videoFiles;
    logger.debug(`📦 UnifiedViewBotRotation: Loading ${videoFiles.length} video files`);
    
    // Initialize Plain RTP rotation (existing system - use singleton)
    if (!this.plainRtpRotation) {
      this.plainRtpRotation = simpleViewBotRotationInstance;
      // It's already initialized as a singleton, just update with video files
      await this.plainRtpRotation.initialize(videoFiles.map(f => ({
        id: `viewbot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        mediaFile: f
      })));
    }
    
    // Initialize WebRTC rotation (new system)
    // CRITICAL: Disable auto-start before initialization to prevent unwanted rotation
    if (!this.webRtcRotation) {
      this.webRtcRotation = new WebRTCViewBotRotation(this.io, this.streamService, this.streamNotifier);
      // Disable auto-start before initialization
      this.webRtcRotation.settings.enabled = false;
      await this.webRtcRotation.initialize(videoFiles);
    }

    // Set default mode - now defaults to plainrtp since WebRTC viewbots have issues
    this.mode = 'plainrtp';
    await this.setMode(this.mode);
    
    logger.debug('✅ UnifiedViewBotRotation: Both systems initialized');
  }
  
  /**
   * Set rotation mode
   */
  async setMode(mode) {
    if (mode !== 'plainrtp' && mode !== 'webrtc') {
      throw new Error(`Invalid mode: ${mode}. Must be 'plainrtp' or 'webrtc'`);
    }
    
    logger.debug(`🔄 UnifiedViewBotRotation: Switching to ${mode} mode`);
    
    // Stop current rotation
    if (this.activeRotation) {
      await this.activeRotation.stopRotation();
    }

    // CRITICAL: Explicitly disable the rotation system we're switching away from
    if (mode === 'plainrtp' && this.webRtcRotation) {
      this.webRtcRotation.settings.enabled = false;
      await this.webRtcRotation.stopRotation();
      logger.debug('🛑 WebRTC rotation disabled');
    } else if (mode === 'webrtc' && this.plainRtpRotation) {
      // Disable plain RTP if switching to WebRTC
      logger.debug('🛑 Plain RTP rotation disabled');
    }

    // Switch mode
    this.mode = mode;

    if (mode === 'webrtc') {
      this.activeRotation = this.webRtcRotation;
      this.webRtcRotation.settings.enabled = true;
      logger.debug('📱 Using WebRTC viewbots (mobile compatible)');
    } else {
      this.activeRotation = this.plainRtpRotation;
      logger.debug('🖥️ Using Plain RTP viewbots (desktop only)');
    }
    
    // Restart rotation if it was running
    if (this.isRotating && this.activeRotation) {
      await this.activeRotation.startRotation();
    }
    
    // Emit mode change event
    if (this.io) {
      this.io.emit('viewbot-mode-changed', {
        mode: mode,
        mobileCompatible: mode === 'webrtc',
        timestamp: Date.now()
      });
    }
    
    return {
      success: true,
      mode: mode,
      mobileCompatible: mode === 'webrtc'
    };
  }
  
  /**
   * Start rotation
   */
  async startRotation() {
    logger.debug(`🎬 UnifiedViewBotRotation: Starting rotation in ${this.mode} mode`);

    if (!this.activeRotation) {
      throw new Error('Rotation system not initialized');
    }

    this.isRotating = true;
    this._startWatchdog();
    await this.activeRotation.startRotation();
  }

  /**
   * Stop rotation
   */
  async stopRotation() {
    logger.debug('⏹️ UnifiedViewBotRotation: Stopping rotation');

    this.isRotating = false;
    this._stopWatchdog();

    if (this.activeRotation) {
      await this.activeRotation.stopRotation();
    }
  }

  /**
   * PR 8.2 — start the tick-loop watchdog (see ADR-0016). Observability
   * only; the watchdog never restarts the rotation itself. A pm2 (or
   * equivalent) supervisor is the recovery agent, with the watchdog log
   * line being the trigger that wakes a human.
   */
  _startWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
    this.watchdogInterval = setInterval(() => this._checkRotationHealth(), this.watchdogCheckMs);
  }

  /**
   * PR 8.2 — stop the watchdog when rotation is stopped.
   */
  _stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /**
   * PR 8.2 — single watchdog check. Fires `level:error` log line if the
   * active sub-rotation has not ticked within `maxRotationInterval * 2`.
   * The threshold tolerates one missed schedule (jitter, brief await
   * stall) while catching an unhandled-exception-broken tick chain.
   */
  _checkRotationHealth() {
    if (!this.isRotating || !this.activeRotation) {
      return;
    }
    const lastTickAt = this.activeRotation.lastTickAt;
    if (lastTickAt === null || lastTickAt === undefined) {
      // Rotation just started; first tick hasn't recorded yet.
      return;
    }
    const maxInterval = this.activeRotation.settings?.maxRotationInterval ?? 180000;
    const threshold = maxInterval * 2;
    const sinceMs = this.watchdogNow() - lastTickAt;

    if (sinceMs > threshold) {
      const context = {
        level: 'error',
        event: 'viewbot-rotation-stalled',
        mode: this.mode,
        backend: this.backendType,
        sinceLastTickMs: sinceMs,
        thresholdMs: threshold,
        maxRotationIntervalMs: maxInterval,
        isRotating: this.isRotating,
        // Hint to the operator: when the loop is wedged because a real
        // streamer is on, this flag separates "code bug" from "blocked
        // by design". See runbook viewbot-fleet-misbehaving.md.
        realStreamerActive: this._isAnyRealStreamerActive(),
      };
      this.watchdogLogger.error(
        `[ViewBotRotation Watchdog] rotation has not ticked in ${sinceMs}ms (threshold ${threshold}ms)`,
        context
      );
    }
  }

  /**
   * Helper for the watchdog: is a real streamer (or URL stream) currently
   * active? The sub-rotations have their own checks; we delegate to the
   * plain-RTP rotation's helper which already covers both cases.
   */
  _isAnyRealStreamerActive() {
    try {
      if (this.plainRtpRotation && typeof this.plainRtpRotation.isRealStreamerActive === 'function') {
        return this.plainRtpRotation.isRealStreamerActive();
      }
    } catch (_err) {
      // Defensive: don't let an exception in the helper break the watchdog log.
    }
    return false;
  }
  
  /**
   * Force rotation to next bot
   */
  async forceRotation() {
    if (!this.activeRotation) {
      throw new Error('Rotation system not initialized');
    }
    
    await this.activeRotation.forceRotation();
  }
  
  /**
   * Get current status
   */
  getStatus() {
    const baseStatus = {
      mode: this.mode,
      mobileCompatible: this.mode === 'webrtc',
      isRotating: this.isRotating,
      totalVideos: this.videoFiles.length
    };
    
    if (this.activeRotation && this.activeRotation.getStatus) {
      return {
        ...baseStatus,
        ...this.activeRotation.getStatus()
      };
    }
    
    return baseStatus;
  }
  
  /**
   * Update settings for active rotation
   */
  updateSettings(settings) {
    if (this.activeRotation && this.activeRotation.updateSettings) {
      this.activeRotation.updateSettings(settings);
    }
    
    // Also update the inactive rotation for consistency
    if (this.mode === 'webrtc' && this.plainRtpRotation) {
      this.plainRtpRotation.updateSettings(settings);
    } else if (this.mode === 'plainrtp' && this.webRtcRotation) {
      this.webRtcRotation.updateSettings(settings);
    }
  }
  
  /**
   * Check if mobile clients should be warned
   */
  shouldWarnMobileClients() {
    return this.mode === 'plainrtp';
  }
  
  /**
   * Auto-detect and switch mode based on client types
   */
  async autoDetectMode(clientStats) {
    const mobileClientCount = clientStats.mobile || 0;
    const desktopClientCount = clientStats.desktop || 0;
    
    logger.debug(`📊 Client stats - Mobile: ${mobileClientCount}, Desktop: ${desktopClientCount}`);
    
    // If we have mobile clients and currently in Plain RTP mode, switch to WebRTC
    if (mobileClientCount > 0 && this.mode === 'plainrtp') {
      logger.debug('📱 Mobile clients detected, switching to WebRTC mode');
      await this.setMode('webrtc');
      return true;
    }
    
    // If only desktop clients and currently in WebRTC mode, optionally switch to Plain RTP
    // to save resources (optional optimization)
    if (mobileClientCount === 0 && desktopClientCount > 0 && this.mode === 'webrtc') {
      logger.debug('🖥️ Only desktop clients, could switch to Plain RTP to save resources');
      // Uncomment to enable auto-switch to Plain RTP:
      // await this.setMode('plainrtp');
      // return true;
    }
    
    return false;
  }
  
  /**
   * Cleanup
   */
  async shutdown() {
    logger.debug('🛑 UnifiedViewBotRotation: Shutting down');

    // stopRotation() clears the watchdog; this is the canonical teardown
    // path. The explicit _stopWatchdog() below is defensive in case
    // stopRotation throws partway.
    await this.stopRotation();
    this._stopWatchdog();
    
    if (this.plainRtpRotation) {
      await this.plainRtpRotation.shutdown();
    }
    
    if (this.webRtcRotation) {
      await this.webRtcRotation.shutdown();
    }
  }
}

module.exports = UnifiedViewBotRotation;
