/**
 * ViewBotURLService.js - Stream external URLs (Twitch, YouTube, etc.) as viewbots
 *
 * This service creates viewbots that relay content from external streaming platforms
 * onto onestreamer. URL viewbots are treated like "real streamers" - other viewbots
 * cannot interrupt them.
 *
 * Pipeline: URL -> streamlink/yt-dlp -> FFmpeg -> RTMP -> LiveKit -> Viewers
 */

const EventEmitter = require('events');
const URLStreamExtractorService = require('./URLStreamExtractorService');
const StreamProbeService = require('./StreamProbeService');
const AdaptiveEncodingSettings = require('./AdaptiveEncodingSettings');
const KickRandomService = require('./KickRandomService');
const { defaultPropsForPlatform } = require('./viewbot/streamDefaults');
const webrtcConfig = require('../config/webrtc.config');
const WhitelistGate = require('./urlstream/WhitelistGate');
const ViewerNotifier = require('./urlstream/ViewerNotifier');
const IngressJanitor = require('./urlstream/IngressJanitor');
const FFmpegPipeline = require('./urlstream/FFmpegPipeline');
const StreamReconnector = require('./urlstream/StreamReconnector');

const logger = require('../bootstrap/logger').child({ svc: 'ViewBotURLService' });

class ViewBotURLService extends EventEmitter {
  constructor() {
    super();

    // Dependencies
    this.extractorService = new URLStreamExtractorService();
    this.probeService = new StreamProbeService();
    this.streamService = null;
    this.livekitService = null;
    this.kickService = new KickRandomService(); // For Kick token refresh

    // Adaptive encoding settings - configured per backend
    this.adaptiveSettings = null; // Initialized after backend detection

    // Active URL streams
    this.activeStreams = new Map(); // urlId -> stream info

    // Backend is LiveKit-only (ADR-0024)
    this.backend = webrtcConfig.backend;

    // Stream counter for unique IDs
    this.streamCounter = 0;

    // FFmpeg path - use system FFmpeg which has HTTPS support
    // The custom /usr/local/bin/ffmpeg lacks HTTPS protocol
    this.ffmpegPath = '/usr/bin/ffmpeg';

    // CRITICAL: Mutex to prevent concurrent stream starts
    // This ensures only one stream can ever be starting at a time
    this._startingStream = false;

    // CRITICAL: Mutex to prevent concurrent reconnect attempts
    // This prevents race conditions where multiple errors trigger overlapping reconnects
    this._reconnecting = false;

    // Adaptive encoding configuration
    this.adaptiveConfig = {
      enabled: true,           // Enable adaptive encoding by default
      mode: 'performance',     // 'performance', 'balanced', or 'quality' — perf uses ultrafast + 0.7x bitrate
      maxWidth: 1920,          // Max output resolution
      maxHeight: 1080,
      maxVideoBitrate: 6000,   // kbps
      maxFps: 60,
      probeTimeout: 8000       // ms to wait for probe
    };

    // Initialize adaptive settings with backend type
    this._initAdaptiveSettings();

    // Collaborators (decomposed from this service). Each takes a back-reference
    // so it can read/mutate service state; behavior is unchanged.
    this.whitelistGate = new WhitelistGate(this);
    this.viewerNotifier = new ViewerNotifier(this, logger);
    this.ingressJanitor = new IngressJanitor(this, logger);
    this.ffmpegPipeline = new FFmpegPipeline(this, logger);
    this.streamReconnector = new StreamReconnector(this, logger);

    logger.debug(`🔗 ViewBotURLService initialized (backend: ${this.backend}, adaptive: ${this.adaptiveConfig.enabled})`);
  }

  /**
   * Set StreamService reference for stream management
   */
  setStreamService(streamService) {
    this.streamService = streamService;
    logger.debug('✅ StreamService registered with ViewBotURLService');
  }

  /**
   * Set LiveKit service for LiveKit backend
   */
  setLiveKitService(livekitService) {
    this.livekitService = livekitService;
    logger.debug('✅ LiveKitService registered with ViewBotURLService');
  }

  /**
   * Set ViewBot rotation service for pausing/resuming viewbots
   */
  setViewBotRotation(viewBotRotation) {
    this.viewBotRotation = viewBotRotation;
    logger.debug('✅ ViewBotRotation registered with ViewBotURLService');
  }

  /**
   * Set socket.io instance for broadcasting to viewers
   */
  setSocketIO(io) {
    this.io = io;
    logger.debug('✅ Socket.IO registered with ViewBotURLService');
  }

  /**
   * Set the StreamNotifier (PR 3.1) used to emit `stream-ended` events.
   * Parallel to setSocketIO — the notifier is preferred but the raw io ref
   * is still kept because URL-stream code paths also emit other events.
   */
  setStreamNotifier(streamNotifier) {
    this.streamNotifier = streamNotifier;
    logger.debug('✅ StreamNotifier registered with ViewBotURLService');
  }

  /**
   * Set the WhitelistService (ADR-0010, PR-W2) used to gate URL submissions
   * against the per-platform allow/block lists + CCL/mature filters. When the
   * service is set, startURLStream consults it after URL validation and before
   * extracting the playback URL. When unset, the gate is a pass-through —
   * Phase 0 ships without the gate active, the setter wires it on.
   */
  setWhitelistService(whitelistService) {
    this.whitelistService = whitelistService;
    logger.debug('✅ WhitelistService registered with ViewBotURLService');
  }

  /**
   * Initialize adaptive encoding settings
   */
  _initAdaptiveSettings() {
    this.adaptiveSettings = new AdaptiveEncodingSettings({
      backend: this.backend,
      mode: this.adaptiveConfig.mode,
      maxWidth: this.adaptiveConfig.maxWidth,
      maxHeight: this.adaptiveConfig.maxHeight,
      maxVideoBitrate: this.adaptiveConfig.maxVideoBitrate,
      maxFps: this.adaptiveConfig.maxFps
    });
  }

  /**
   * Update adaptive encoding configuration
   * @param {object} config - New configuration values
   */
  setAdaptiveConfig(config) {
    Object.assign(this.adaptiveConfig, config);
    this._initAdaptiveSettings();
    logger.debug('🎯 Adaptive encoding config updated:', this.adaptiveConfig);
    return this.adaptiveConfig;
  }

  /**
   * Get current adaptive encoding configuration
   */
  getAdaptiveConfig() {
    return { ...this.adaptiveConfig };
  }

  /**
   * Probe a stream URL to get its properties (resolution, fps, bitrate)
   * @param {string} url - Stream URL
   * @param {string} quality - Quality preference
   * @returns {Promise<object>} Stream properties
   */
  async probeStreamSource(url, quality = 'best') {
    try {
      // First get the actual stream URL via extractor
      const streamInfo = await this.extractorService.getStreamURL(url, quality);

      if (streamInfo.pipeMode) {
        // For pipe mode, we can't easily probe - use defaults with platform hints
        logger.debug(`📊 Probe: Pipe mode detected, using platform-based defaults`);
        return this._getDefaultPropsForPlatform(streamInfo.platform || 'unknown', quality);
      }

      // Direct URL - probe it
      const props = await this.probeService.probeStream(streamInfo.streamUrl, {
        timeout: this.adaptiveConfig.probeTimeout
      });

      return props;
    } catch (error) {
      logger.warn(`⚠️ Probe failed: ${error.message}, using defaults`);
      return this.probeService.defaults;
    }
  }

  /**
   * Get default stream properties based on platform and quality
   */
  _getDefaultPropsForPlatform(platform, quality) {
    return defaultPropsForPlatform(platform, quality, this.probeService.defaults);
  }

  /**
   * Stop current viewbot and pause rotation
   */
  async _stopViewBotsForURLStream() {
    if (!this.viewBotRotation) {
      logger.warn('⚠️ ViewBotRotation not available - cannot stop viewbots');
      return;
    }

    logger.debug('🛑 URL STREAM: Stopping viewbots to make room for URL stream');

    // Remember if rotation was enabled so we can restore it later
    this._wasRotationEnabled = this.viewBotRotation.settings?.enabled || false;

    // Stop current viewbot and disable rotation
    await this.viewBotRotation.stopRotation();

    logger.debug('✅ URL STREAM: Viewbots stopped, rotation paused');
  }

  /**
   * Resume viewbot rotation after URL stream ends
   */
  async _resumeViewBots() {
    if (!this.viewBotRotation) {
      return;
    }

    // Only resume if rotation was previously enabled
    if (this._wasRotationEnabled) {
      logger.debug('▶️ URL STREAM: Resuming viewbot rotation');
      this.viewBotRotation.updateSettings({ enabled: true });
      await this.viewBotRotation.startRotation();
    } else {
      logger.debug('ℹ️ URL STREAM: Viewbot rotation was not enabled before, not resuming');
    }
  }

  /**
   * Start the streaming pipeline for the active backend.
   * Shared dispatch used by startURLStream, reconnect, and Kick token refresh.
   * LiveKit is the sole backend (ADR-0024).
   */
  async _startPipeline(urlId, streamEntry) {
    await this._startLiveKitStream(urlId, streamEntry);
  }

  /**
   * Register a URL stream as the current streamer on StreamService and
   * MediaSoup. Shared across startURLStream, broadcast, reconnect, and Kick
   * token refresh. The per-call-site debug logs are preserved verbatim via
   * the optional `streamerLog` / `mediasoupLog` strings.
   */
  _registerAsCurrentStreamer(urlId, { streamerLog = null, mediasoupLog = null } = {}) {
    if (this.streamService) {
      if (streamerLog) logger.debug(streamerLog);
      this.streamService.setStreamer(urlId);
    }
    if (global.webrtcService) {
      if (mediasoupLog) logger.debug(mediasoupLog);
      global.webrtcService.currentStreamer = urlId;
    }
  }

  /**
   * Delete and null a stream's LiveKit ingress. Shared by the reconnect,
   * Kick-refresh, and natural-end teardown paths. Callers own the try/catch
   * and the surrounding livekitService guard (the log strings differ).
   */
  async _teardownIngress(streamEntry) {
    await this.livekitService.deleteIngress(streamEntry.ingressInfo.ingressId);
    streamEntry.ingressInfo = null;
  }

  /**
   * Wait for stream to be ready, then notify viewers
   * Polls LiveKit to check if participant has published tracks
   */
  async _notifyViewersWhenReady(urlId, streamEntry, validation) {
    return this.viewerNotifier.notifyWhenReady(urlId, streamEntry, validation);
  }

  /**
   * Check if a URL stream is currently active
   */
  isURLStreamActive() {
    return this.activeStreams.size > 0;
  }

  /**
   * Check if the service is busy (starting/reconnecting)
   * Used by external services to avoid interfering with ongoing operations
   */
  isBusy() {
    return this._startingStream || this._reconnecting;
  }

  /**
   * Check if currently reconnecting
   */
  isReconnecting() {
    return this._reconnecting;
  }

  /**
   * Get active URL stream info (for protection checks)
   */
  getActiveURLStream() {
    if (this.activeStreams.size === 0) return null;
    // Return first active stream
    const [urlId, info] = this.activeStreams.entries().next().value;
    return { urlId, ...info };
  }

  /**
   * Validate a URL before starting stream
   */
  async validateURL(url) {
    return await this.extractorService.validateStream(url);
  }

  /**
   * Start streaming from a URL
   */
  async startURLStream(url, options = {}) {
    const {
      quality = 'best',
      displayName = null,
      autoReconnect = true,
      kickUsername = null  // Kick username for token refresh
    } = options;

    // CRITICAL: Mutex to prevent concurrent stream starts
    // This prevents race conditions where multiple streams could start simultaneously
    if (this._startingStream) {
      logger.debug('⚠️ URL STREAM: Another stream is currently starting, rejecting request');
      return {
        success: false,
        error: 'Another stream is currently starting, please wait',
        urlId: null
      };
    }

    this._startingStream = true;

    // Generate unique ID early so we can reference it in all code paths
    const urlId = `url-stream-${Date.now()}-${++this.streamCounter}`;

    try {
      // CRITICAL: Check if a real (human) user is currently streaming.
      // URL streams should NEVER override a real human streamer. Source of
      // truth is StreamService (a real streamer is a current streamer whose
      // socket id is not a viewbot/bot/url-stream).
      const currentStreamer = this.streamService && this.streamService.getCurrentStreamer();
      const realStreamerActive = !!currentStreamer
        && !currentStreamer.startsWith('viewbot-')
        && !currentStreamer.includes('viewbot')
        && !currentStreamer.startsWith('bot-')
        && !currentStreamer.startsWith('url-stream-');
      if (realStreamerActive) {
        logger.debug(`⛔ URL STREAM: Blocking ${urlId} - real streamer is active`);
        this._startingStream = false;
        return {
          success: false,
          error: 'Real streamer is active - URL stream blocked',
          urlId
        };
      }

      logger.debug(`🚀 Starting URL stream: ${urlId}`);

      // Run cleanup in background - don't block new stream startup
      // Pass the new urlId to exclude it from cleanup (prevent killing the new stream)
      logger.debug('🧹 URL STREAM: Running cleanup in background...');
      this.ingressJanitor.cleanupAll(urlId).catch(err =>
        logger.error('⚠️ Background cleanup error:', err.message)
      );
      logger.debug(`   URL: ${url}`);
      logger.debug(`   Quality: ${quality}`);

      // Validate URL first
      const validation = await this.validateURL(url);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error || 'Invalid stream URL',
          urlId
        };
      }

      logger.debug(`✅ URL validated: ${validation.title} (${validation.platform})`);

      // Whitelist gate (ADR-0010, PR-W2). Returns { allowed: true } when no
      // service is injected, so this is a pass-through in Phase 0.
      const gate = this.whitelistGate.check(url, validation);
      if (!gate.allowed) {
        logger.debug(`⛔ URL STREAM: whitelist gate rejected ${urlId}: ${gate.reason}`);
        return {
          success: false,
          error: `Content policy: ${gate.reason}`,
          urlId,
          gateThatBlocked: gate.gateThatBlocked,
        };
      }

      // CRITICAL: Stop ALL existing URL streams before starting a new one
      // This ensures only ONE stream is ever active at a time
      if (this.activeStreams.size > 0) {
        logger.debug(`🛑 URL STREAM: Stopping ${this.activeStreams.size} existing URL stream(s) before starting new one`);
        await this.stopAllURLStreams();
        // No delay needed - processes are killed synchronously, ingress cleanup runs in background
      }

      // Get stream URL/pipe mode
      const streamInfo = await this.extractorService.getStreamURL(url, quality);

      // ADAPTIVE ENCODING: Use platform-based defaults (no blocking probe)
      let encodingSettings = null;
      let sourceProps = null;

      if (this.adaptiveConfig.enabled) {
        // Use platform+quality based defaults - fast and reliable, no probe delay
        sourceProps = this._getDefaultPropsForPlatform(validation.platform, quality);

        // Calculate optimal encoding settings based on platform defaults
        encodingSettings = this.adaptiveSettings.calculate(sourceProps);
        logger.debug(`🎯 Adaptive (${validation.platform}/${quality}): ` +
                   `${encodingSettings.width}x${encodingSettings.height}@${encodingSettings.fps}fps, ` +
                   `${encodingSettings.videoBitrate}kbps, preset=${encodingSettings.preset || encodingSettings.cpuUsed}`);
      }

      // Create stream entry
      const streamEntry = {
        urlId,
        sourceUrl: url,
        platform: validation.platform,
        quality,
        displayName: displayName || validation.title || 'URL Stream',
        status: 'starting',
        startedAt: Date.now(),
        validation,
        streamInfo,
        sourceProps,          // Source stream properties from probe
        encodingSettings,     // Calculated adaptive encoding settings
        processes: [],
        autoReconnect,
        reconnectAttempts: 0,
        maxReconnectAttempts: 3,
        kickUsername,         // Kick username for token refresh (null for non-Kick streams)
        tokenRefreshAttempts: 0,
        maxTokenRefreshAttempts: 5  // Allow multiple token refreshes per stream
      };

      this.activeStreams.set(urlId, streamEntry);

      // IMPORTANT: Stop any running viewbots first to clear the stream slot
      await this._stopViewBotsForURLStream();

      // Start the streaming pipeline
      await this._startPipeline(urlId, streamEntry);

      streamEntry.status = 'streaming';

      // CRITICAL FIX: Register as current streamer IMMEDIATELY
      // This prevents "offline" status indicator during stream startup
      // (previously only set after track verification, causing null streamerId)
      this._registerAsCurrentStreamer(urlId, {
        streamerLog: `📢 URL STREAM: Immediately registering ${urlId} as current streamer`,
      });

      // Emit event for integration
      this.emit('url-stream-started', {
        urlId,
        sourceUrl: url,
        platform: validation.platform,
        title: validation.title
      });

      logger.debug(`✅ URL stream started: ${urlId}`);

      // CRITICAL: Wait for stream to be actually ready before notifying viewers
      // The FFmpeg pipeline needs time to connect to LiveKit and publish tracks
      this._notifyViewersWhenReady(urlId, streamEntry, validation);

      return {
        success: true,
        urlId,
        platform: validation.platform,
        title: validation.title,
        qualities: validation.qualities
      };

    } catch (error) {
      logger.error(`❌ Failed to start URL stream ${urlId}:`, error);
      this.activeStreams.delete(urlId);
      return {
        success: false,
        error: error.message,
        urlId
      };
    } finally {
      // CRITICAL: Always release the mutex, regardless of success or failure
      this._startingStream = false;
    }
  }

  /**
   * Start LiveKit RTMP stream pipeline
   * Uses: streamlink -> FFmpeg -> RTMP -> LiveKit
   */
  async _startLiveKitStream(urlId, streamEntry) {
    const { sourceUrl, quality, streamInfo } = streamEntry;

    logger.debug(`🎥 Starting LiveKit pipeline for ${urlId}`);

    // Create ingress with bot-like object and encoding settings for adaptive frame rate
    // Note: RTMP input requires transcoding for WebRTC conversion (can't bypass)
    const ingress = await this.livekitService.createIngress(
      { id: urlId, name: streamEntry.displayName },
      streamEntry.encodingSettings  // Pass adaptive settings for frame rate matching
    );

    if (!ingress || !ingress.streamKey) {
      throw new Error('Failed to create LiveKit ingress - no stream key returned');
    }

    // Build RTMP URL from stream key
    const rtmpUrl = `rtmp://127.0.0.1:1935/live/${ingress.streamKey}`;

    streamEntry.ingressInfo = {
      ingressId: ingress.ingressId,
      streamKey: ingress.streamKey,
      rtmpUrl
    };

    logger.debug(`🔗 LiveKit ingress created: ${ingress.ingressId}`);
    logger.debug(`📡 RTMP URL: ${rtmpUrl}`);

    let ffmpegProcess;

    if (streamInfo.pipeMode) {
      // Pipe mode
      const streamlinkProcess = this.extractorService.createStreamPipe(sourceUrl, quality);
      streamEntry.processes.push({ type: 'streamlink', process: streamlinkProcess });

      ffmpegProcess = this.ffmpegPipeline.createRTMPProcess('-', rtmpUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });

      // Handle pipe errors to prevent EPIPE crashes
      ffmpegProcess.stdin.on('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
          logger.debug(`ℹ️ FFmpeg stdin closed for ${urlId} (normal during shutdown)`);
        } else {
          logger.error(`❌ FFmpeg stdin error for ${urlId}:`, err.message);
        }
      });

      streamlinkProcess.stdout.pipe(ffmpegProcess.stdin);

      streamlinkProcess.on('error', (err) => this._handleStreamError(urlId, 'streamlink', err));
      streamlinkProcess.on('exit', (code) => {
        if (code !== 0 && code !== 130) { // 130 = SIGINT, normal during shutdown
          this._handleStreamError(urlId, 'streamlink', new Error(`Exit code ${code}`));
        }
      });

    } else {
      // Direct URL mode
      ffmpegProcess = this.ffmpegPipeline.createRTMPProcess(streamInfo.streamUrl, rtmpUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });
    }

    this.ffmpegPipeline.setupHandlers(urlId, ffmpegProcess);
    await this.ffmpegPipeline.waitForStream(ffmpegProcess, 15000);  // 15s timeout for analyzeduration

    logger.debug(`✅ LiveKit pipeline started for ${urlId}`);
  }

  /**
   * Handle stream errors with optional reconnection
   * CRITICAL: Uses mutex to prevent multiple simultaneous reconnect attempts
   */
  async _handleStreamError(urlId, source, error) {
    return this.streamReconnector.handleStreamError(urlId, source, error);
  }

  /**
   * Handle stream ending
   */
  async _handleStreamEnd(urlId, reason) {
    return this.streamReconnector.handleStreamEnd(urlId, reason);
  }

  /**
   * Stop all processes for a stream
   * Properly waits for process termination with fallback to SIGKILL
   */
  async _stopProcesses(streamEntry) {
    return this.ffmpegPipeline.stopProcesses(streamEntry);
  }

  /**
   * Stop a URL stream
   */
  async stopURLStream(urlId) {
    const streamEntry = this.activeStreams.get(urlId);

    if (!streamEntry) {
      return { success: false, error: 'Stream not found' };
    }

    logger.debug(`⏹️ Stopping URL stream: ${urlId}`);

    // Stop processes
    await this._stopProcesses(streamEntry);

    // If using LiveKit, stop ingress
    if (streamEntry.ingressInfo && this.livekitService) {
      try {
        await this.livekitService.deleteIngress(streamEntry.ingressInfo.ingressId);
      } catch (err) {
        logger.error('⚠️ Error stopping LiveKit ingress:', err);
      }
    }

    // Remove from active streams
    this.activeStreams.delete(urlId);

    // Emit event
    this.emit('url-stream-stopped', { urlId });

    // Notify viewers that URL stream has ended (PR 3.1 chokepoint)
    if (this.streamNotifier) {
      logger.debug('📢 URL STREAM: Broadcasting stream-ended event to all viewers');
      this.streamNotifier.streamEnded({
        reason: 'url_stream_stopped',
        streamerId: urlId,
        isUrlStream: true,
      });
    }

    logger.debug(`✅ URL stream stopped: ${urlId}`);

    // Resume viewbot rotation if no more URL streams are active
    if (this.activeStreams.size === 0) {
      await this._resumeViewBots();
    }

    return { success: true };
  }

  /**
   * Stop all URL streams
   */
  async stopAllURLStreams() {
    logger.debug(`🛑 Stopping all URL streams (${this.activeStreams.size} active)`);

    const stopPromises = [];
    for (const urlId of this.activeStreams.keys()) {
      stopPromises.push(this.stopURLStream(urlId));
    }

    await Promise.allSettled(stopPromises);

    // SAFETY NET: Kill any orphaned processes that weren't tracked
    this.ingressJanitor.killOrphans();

    logger.debug('✅ All URL streams stopped');
  }

  /**
   * Get status of a URL stream
   */
  getStreamStatus(urlId) {
    const streamEntry = this.activeStreams.get(urlId);

    if (!streamEntry) {
      return null;
    }

    return {
      urlId,
      sourceUrl: streamEntry.sourceUrl,
      platform: streamEntry.platform,
      displayName: streamEntry.displayName,
      quality: streamEntry.quality,
      status: streamEntry.status,
      startedAt: streamEntry.startedAt,
      uptime: Date.now() - streamEntry.startedAt,
      reconnectAttempts: streamEntry.reconnectAttempts,
      processCount: streamEntry.processes.length
    };
  }

  /**
   * Get all active streams
   */
  getAllStreams() {
    const streams = [];
    for (const [urlId, entry] of this.activeStreams) {
      streams.push(this.getStreamStatus(urlId));
    }
    return streams;
  }

  /**
   * Test tools availability
   */
  async testTools() {
    return await this.extractorService.testTools();
  }

  /**
   * Extract the channel login from a platform URL.
   * Returns null for unknown platforms or URLs we can't parse.
   * Logins are lowercased to match WhitelistService's canonical form.
   */
  _extractLoginFromUrl(url, platform) {
    return this.whitelistGate.extractLoginFromUrl(url, platform);
  }

  /**
   * Apply the whitelist policy gate (ADR-0010) to a pending URL submission.
   * Phase 1 only knows the platform + login at this point; the current
   * category isn't resolved yet, so callers in `whitelist` mode will fall
   * through to the streamer allowlist alone here. A post-extraction re-check
   * is deferred to PR-W3 once TwitchRandomService surfaces the category.
   *
   * Returns { allowed: true } when no whitelistService is wired (Phase 0
   * behavior preserved) OR when the service grants the request. Returns
   * { allowed: false, reason, gateThatBlocked } otherwise.
   *
   * Non-Twitch / non-Kick platforms (YouTube, Facebook, etc.) are not gated
   * by this service — they're not on the whitelist's per-platform tables.
   */
  _checkWhitelistGate(url, validation) {
    return this.whitelistGate.check(url, validation);
  }

  /**
   * Clean shutdown
   */
  async shutdown() {
    logger.debug('🛑 Shutting down ViewBotURLService');
    await this.stopAllURLStreams();
  }
}

module.exports = ViewBotURLService;
