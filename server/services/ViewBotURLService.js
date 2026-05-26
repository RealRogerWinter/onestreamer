/**
 * ViewBotURLService.js - Stream external URLs (Twitch, YouTube, etc.) as viewbots
 *
 * This service creates viewbots that relay content from external streaming platforms
 * onto onestreamer. URL viewbots are treated like "real streamers" - other viewbots
 * cannot interrupt them.
 *
 * Pipeline: URL -> streamlink/yt-dlp -> FFmpeg -> RTP/RTMP -> MediaSoup/LiveKit -> Viewers
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const URLStreamExtractorService = require('./URLStreamExtractorService');
const StreamProbeService = require('./StreamProbeService');
const AdaptiveEncodingSettings = require('./AdaptiveEncodingSettings');
const KickRandomService = require('./KickRandomService');
const webrtcConfig = require('../config/webrtc.config');

class ViewBotURLService extends EventEmitter {
  constructor() {
    super();

    // Dependencies
    this.extractorService = new URLStreamExtractorService();
    this.probeService = new StreamProbeService();
    this.streamService = null;
    this.livekitService = null;
    this.viewBotClientService = null; // For real streamer protection
    this.kickService = new KickRandomService(); // For Kick token refresh

    // Adaptive encoding settings - configured per backend
    this.adaptiveSettings = null; // Initialized after backend detection

    // Active URL streams
    this.activeStreams = new Map(); // urlId -> stream info

    // RTP ports for MediaSoup
    this.rtpPorts = {
      video: 5004,
      audio: 5006
    };

    // Backend detection
    this.backend = webrtcConfig.backend || 'mediasoup';

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

    console.log(`🔗 ViewBotURLService initialized (backend: ${this.backend}, adaptive: ${this.adaptiveConfig.enabled})`);
  }

  /**
   * Set StreamService reference for stream management
   */
  setStreamService(streamService) {
    this.streamService = streamService;
    console.log('✅ StreamService registered with ViewBotURLService');
  }

  /**
   * Set LiveKit service for LiveKit backend
   */
  setLiveKitService(livekitService) {
    this.livekitService = livekitService;
    console.log('✅ LiveKitService registered with ViewBotURLService');
  }

  /**
   * Set ViewBot rotation service for pausing/resuming viewbots
   */
  setViewBotRotation(viewBotRotation) {
    this.viewBotRotation = viewBotRotation;
    console.log('✅ ViewBotRotation registered with ViewBotURLService');
  }

  /**
   * Set socket.io instance for broadcasting to viewers
   */
  setSocketIO(io) {
    this.io = io;
    console.log('✅ Socket.IO registered with ViewBotURLService');
  }

  /**
   * Set ViewBotClientService for real streamer protection
   */
  setViewBotClientService(viewBotClientService) {
    this.viewBotClientService = viewBotClientService;
    console.log('✅ ViewBotClientService registered with ViewBotURLService');
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
    console.log('🎯 Adaptive encoding config updated:', this.adaptiveConfig);
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
        console.log(`📊 Probe: Pipe mode detected, using platform-based defaults`);
        return this._getDefaultPropsForPlatform(streamInfo.platform || 'unknown', quality);
      }

      // Direct URL - probe it
      const props = await this.probeService.probeStream(streamInfo.streamUrl, {
        timeout: this.adaptiveConfig.probeTimeout
      });

      return props;
    } catch (error) {
      console.warn(`⚠️ Probe failed: ${error.message}, using defaults`);
      return this.probeService.defaults;
    }
  }

  /**
   * Get default stream properties based on platform and quality
   */
  _getDefaultPropsForPlatform(platform, quality) {
    // Platform-specific defaults based on typical stream characteristics
    const platformDefaults = {
      twitch: {
        best: { width: 1920, height: 1080, fps: 60, videoBitrate: 6000000 },
        '1080p': { width: 1920, height: 1080, fps: 60, videoBitrate: 6000000 },
        '720p': { width: 1280, height: 720, fps: 60, videoBitrate: 3000000 },
        '480p': { width: 854, height: 480, fps: 30, videoBitrate: 1500000 },
        worst: { width: 640, height: 360, fps: 30, videoBitrate: 800000 }
      },
      youtube: {
        best: { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
        '1080p': { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
        '720p': { width: 1280, height: 720, fps: 60, videoBitrate: 4000000 },
        '480p': { width: 854, height: 480, fps: 30, videoBitrate: 2000000 },
        worst: { width: 640, height: 360, fps: 30, videoBitrate: 1000000 }
      },
      kick: {
        best: { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
        '1080p': { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
        '720p': { width: 1280, height: 720, fps: 60, videoBitrate: 4000000 },
        '480p': { width: 854, height: 480, fps: 30, videoBitrate: 1500000 },
        worst: { width: 640, height: 360, fps: 30, videoBitrate: 800000 }
      },
      default: {
        best: { width: 1280, height: 720, fps: 30, videoBitrate: 3000000 },
        worst: { width: 640, height: 360, fps: 30, videoBitrate: 1000000 }
      }
    };

    const platformSettings = platformDefaults[platform] || platformDefaults.default;
    const qualitySettings = platformSettings[quality] || platformSettings.best || platformSettings.default?.best;

    return {
      ...this.probeService.defaults,
      ...qualitySettings,
      hasAudio: true,
      audioBitrate: 128000,
      probeNote: `platform_default_${platform}`
    };
  }

  /**
   * Stop current viewbot and pause rotation
   */
  async _stopViewBotsForURLStream() {
    if (!this.viewBotRotation) {
      console.warn('⚠️ ViewBotRotation not available - cannot stop viewbots');
      return;
    }

    console.log('🛑 URL STREAM: Stopping viewbots to make room for URL stream');

    // Remember if rotation was enabled so we can restore it later
    this._wasRotationEnabled = this.viewBotRotation.settings?.enabled || false;

    // Stop current viewbot and disable rotation
    await this.viewBotRotation.stopRotation();

    console.log('✅ URL STREAM: Viewbots stopped, rotation paused');
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
      console.log('▶️ URL STREAM: Resuming viewbot rotation');
      this.viewBotRotation.updateSettings({ enabled: true });
      await this.viewBotRotation.startRotation();
    } else {
      console.log('ℹ️ URL STREAM: Viewbot rotation was not enabled before, not resuming');
    }
  }

  /**
   * Wait for stream to be ready, then notify viewers
   * Polls LiveKit to check if participant has published tracks
   */
  async _notifyViewersWhenReady(urlId, streamEntry, validation) {
    if (!this.io) {
      console.warn('⚠️ URL STREAM: Socket.IO not available - viewers may not auto-switch');
      return;
    }

    const maxWaitTime = 15000; // Max 15 seconds to wait
    const pollInterval = 1000; // Check every 1 second
    const startTime = Date.now();

    console.log(`⏳ URL STREAM: Waiting for stream ${urlId} to be ready for viewers...`);

    const checkStreamReady = async () => {
      // Check if stream is still active
      if (!this.activeStreams.has(urlId)) {
        console.log(`⚠️ URL STREAM: Stream ${urlId} ended before becoming ready`);
        return;
      }

      // If using LiveKit, check if participant has tracks
      if (this.backend === 'livekit' && this.livekitService) {
        try {
          const { RoomServiceClient } = require('livekit-server-sdk');
          const webrtcConfig = require('../config/webrtc.config');
          const config = webrtcConfig.livekit;
          const host = config.host.startsWith('http') ? config.host : `http://${config.host}`;
          const roomClient = new RoomServiceClient(host, config.apiKey, config.apiSecret);

          const participants = await roomClient.listParticipants(config.roomName);
          const urlParticipant = participants.find(p => p.identity === urlId);

          if (urlParticipant && urlParticipant.tracks && urlParticipant.tracks.length > 0) {
            console.log(`✅ URL STREAM: Stream ${urlId} is now live with ${urlParticipant.tracks.length} tracks`);
            this._broadcastNewStreamer(urlId, streamEntry, validation);
            return;
          }
        } catch (err) {
          console.warn(`⚠️ URL STREAM: Error checking participant status: ${err.message}`);
        }
      }

      // Check if we've waited long enough
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitTime) {
        console.log(`⏰ URL STREAM: Max wait time reached, notifying viewers anyway`);
        this._broadcastNewStreamer(urlId, streamEntry, validation);
        return;
      }

      // Continue polling
      setTimeout(checkStreamReady, pollInterval);
    };

    // Start polling after initial delay (let FFmpeg establish connection)
    setTimeout(checkStreamReady, 2000);
  }

  /**
   * Broadcast new-streamer event to all viewers
   */
  _broadcastNewStreamer(urlId, streamEntry, validation) {
    if (!this.io) return;

    // CRITICAL: Register the URL stream as the current streamer
    // This ensures viewers switch to consuming from the URL stream
    if (this.streamService) {
      console.log(`📢 URL STREAM: Registering ${urlId} as current streamer`);
      this.streamService.setStreamer(urlId);
    }

    // Also set on MediasoupService/WebRTCAdapter if available
    if (global.mediasoupService) {
      console.log(`📢 URL STREAM: Setting MediaSoup currentStreamer to ${urlId}`);
      global.mediasoupService.currentStreamer = urlId;
    }

    console.log('📢 URL STREAM: Broadcasting new-streamer event to all viewers');
    this.io.emit('new-streamer', {
      streamer: {
        odyseeId: urlId,
        odysee_username: streamEntry.displayName || validation.title || 'URL Stream',
        userId: urlId,
        isUrlStream: true,
        platform: validation.platform
      }
    });

    // Also emit stream-started event for any listeners
    this.io.emit('stream-started', {
      streamerId: urlId,
      streamerName: streamEntry.displayName || validation.title || 'URL Stream',
      isUrlStream: true
    });
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
      console.log('⚠️ URL STREAM: Another stream is currently starting, rejecting request');
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
      // CRITICAL: Check if a real user is currently streaming
      // URL streams should NEVER override a real human streamer
      if (this.viewBotClientService && this.viewBotClientService.realStreamerActive) {
        console.log(`⛔ URL STREAM: Blocking ${urlId} - real streamer is active`);
        this._startingStream = false;
        return {
          success: false,
          error: 'Real streamer is active - URL stream blocked',
          urlId
        };
      }

      console.log(`🚀 Starting URL stream: ${urlId}`);

      // Run cleanup in background - don't block new stream startup
      // Pass the new urlId to exclude it from cleanup (prevent killing the new stream)
      console.log('🧹 URL STREAM: Running cleanup in background...');
      this._cleanupAllURLStreamIngresses(urlId).catch(err =>
        console.error('⚠️ Background cleanup error:', err.message)
      );
      console.log(`   URL: ${url}`);
      console.log(`   Quality: ${quality}`);

      // Validate URL first
      const validation = await this.validateURL(url);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error || 'Invalid stream URL',
          urlId
        };
      }

      console.log(`✅ URL validated: ${validation.title} (${validation.platform})`);

      // CRITICAL: Stop ALL existing URL streams before starting a new one
      // This ensures only ONE stream is ever active at a time
      if (this.activeStreams.size > 0) {
        console.log(`🛑 URL STREAM: Stopping ${this.activeStreams.size} existing URL stream(s) before starting new one`);
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
        console.log(`🎯 Adaptive (${validation.platform}/${quality}): ` +
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
      if (this.backend === 'livekit' && this.livekitService) {
        await this._startLiveKitStream(urlId, streamEntry);
      } else {
        await this._startMediaSoupStream(urlId, streamEntry);
      }

      streamEntry.status = 'streaming';

      // CRITICAL FIX: Register as current streamer IMMEDIATELY
      // This prevents "offline" status indicator during stream startup
      // (previously only set after track verification, causing null streamerId)
      if (this.streamService) {
        console.log(`📢 URL STREAM: Immediately registering ${urlId} as current streamer`);
        this.streamService.setStreamer(urlId);
      }
      if (global.mediasoupService) {
        global.mediasoupService.currentStreamer = urlId;
      }

      // Emit event for integration
      this.emit('url-stream-started', {
        urlId,
        sourceUrl: url,
        platform: validation.platform,
        title: validation.title
      });

      console.log(`✅ URL stream started: ${urlId}`);

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
      console.error(`❌ Failed to start URL stream ${urlId}:`, error);
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
   * Start MediaSoup RTP stream pipeline
   * Uses: streamlink -> FFmpeg -> RTP -> MediaSoup
   */
  async _startMediaSoupStream(urlId, streamEntry) {
    const { sourceUrl, quality, streamInfo } = streamEntry;

    console.log(`🎥 Starting MediaSoup pipeline for ${urlId}`);

    let ffmpegProcess;

    if (streamInfo.pipeMode) {
      // Pipe mode: streamlink stdout -> FFmpeg stdin
      const streamlinkProcess = this.extractorService.createStreamPipe(sourceUrl, quality);
      streamEntry.processes.push({ type: 'streamlink', process: streamlinkProcess });

      // FFmpeg reads from stdin
      ffmpegProcess = this._createFFmpegRTPProcess('-', streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });

      // Pipe streamlink to FFmpeg
      streamlinkProcess.stdout.pipe(ffmpegProcess.stdin);

      // Handle streamlink errors
      streamlinkProcess.on('error', (err) => {
        console.error(`❌ Streamlink error for ${urlId}:`, err);
        this._handleStreamError(urlId, 'streamlink', err);
      });

      streamlinkProcess.on('exit', (code) => {
        console.log(`📤 Streamlink exited for ${urlId} with code ${code}`);
        if (code !== 0) {
          this._handleStreamError(urlId, 'streamlink', new Error(`Exit code ${code}`));
        }
      });

    } else {
      // Direct URL mode: FFmpeg reads from URL directly
      ffmpegProcess = this._createFFmpegRTPProcess(streamInfo.streamUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });
    }

    // Handle FFmpeg events
    this._setupFFmpegHandlers(urlId, ffmpegProcess);

    // Wait for FFmpeg to start producing
    await this._waitForStream(ffmpegProcess, 15000);  // 15s timeout for analyzeduration

    console.log(`✅ MediaSoup pipeline started for ${urlId}`);
  }

  /**
   * Start LiveKit RTMP stream pipeline
   * Uses: streamlink -> FFmpeg -> RTMP -> LiveKit
   */
  async _startLiveKitStream(urlId, streamEntry) {
    const { sourceUrl, quality, streamInfo } = streamEntry;

    console.log(`🎥 Starting LiveKit pipeline for ${urlId}`);

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

    console.log(`🔗 LiveKit ingress created: ${ingress.ingressId}`);
    console.log(`📡 RTMP URL: ${rtmpUrl}`);

    let ffmpegProcess;

    if (streamInfo.pipeMode) {
      // Pipe mode
      const streamlinkProcess = this.extractorService.createStreamPipe(sourceUrl, quality);
      streamEntry.processes.push({ type: 'streamlink', process: streamlinkProcess });

      ffmpegProcess = this._createFFmpegRTMPProcess('-', rtmpUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });

      // Handle pipe errors to prevent EPIPE crashes
      ffmpegProcess.stdin.on('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
          console.log(`ℹ️ FFmpeg stdin closed for ${urlId} (normal during shutdown)`);
        } else {
          console.error(`❌ FFmpeg stdin error for ${urlId}:`, err.message);
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
      ffmpegProcess = this._createFFmpegRTMPProcess(streamInfo.streamUrl, rtmpUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });
    }

    this._setupFFmpegHandlers(urlId, ffmpegProcess);
    await this._waitForStream(ffmpegProcess, 15000);  // 15s timeout for analyzeduration

    console.log(`✅ LiveKit pipeline started for ${urlId}`);
  }

  /**
   * Create FFmpeg process for RTP output (MediaSoup)
   * Uses adaptive encoding settings when available
   */
  _createFFmpegRTPProcess(input, streamEntry) {
    const settings = streamEntry.encodingSettings;
    const useAdaptive = this.adaptiveConfig.enabled && settings;

    // Build video filter if scaling/fps change needed
    let vfArg = null;
    if (useAdaptive && settings.scale) {
      vfArg = settings.scale;
    }

    const args = [];

    // Input buffer settings for smoother streaming
    args.push(
      '-analyzeduration', '3000000',   // 3 seconds - balance between startup speed and stability
      '-probesize', '10000000',        // 10MB - read more data for format detection
      '-fflags', '+genpts+discardcorrupt+nobuffer',
      '-flags', 'low_delay',
      '-max_delay', '500000'           // 500ms max delay
    );

    // For direct URLs (not piped), add reconnect options
    if (input !== '-') {
      args.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
      );
    } else {
      // For piped input, add thread queue size for better buffering
      args.push('-thread_queue_size', '4096');
    }

    args.push('-re', '-i', input);

    // Add video filter if needed
    if (vfArg) {
      args.push('-vf', vfArg);
    }

    // Video encoding with adaptive or default settings
    args.push(
      '-map', '0:v:0',
      '-c:v', 'libvpx', // VP8 for MediaSoup
      '-deadline', useAdaptive ? settings.deadline : 'realtime',
      '-cpu-used', useAdaptive ? String(settings.cpuUsed) : '8',
      '-b:v', useAdaptive ? `${settings.videoBitrate}k` : '1500k',
      '-maxrate', useAdaptive ? `${settings.maxrate}k` : '2000k',
      '-bufsize', useAdaptive ? `${settings.bufsize}k` : '4000k',
      '-g', useAdaptive ? String(settings.gopSize) : '30',
      '-keyint_min', useAdaptive ? String(settings.keyintMin) : '30',
      '-f', 'rtp',
      `rtp://127.0.0.1:${this.rtpPorts.video}?pkt_size=1200`
    );

    // Audio encoding
    args.push(
      '-map', '0:a:0?', // Optional audio stream
      '-c:a', 'libopus',
      '-b:a', useAdaptive && settings.audioBitrate ? `${settings.audioBitrate}k` : '128k',
      '-ar', '48000',
      '-ac', useAdaptive ? String(settings.audioChannels || 2) : '2',
      '-f', 'rtp',
      `rtp://127.0.0.1:${this.rtpPorts.audio}?pkt_size=1200`
    );

    const logSettings = useAdaptive
      ? `ADAPTIVE ${settings.width}x${settings.height}@${settings.fps}fps ${settings.videoBitrate}kbps`
      : 'FIXED 720p 1500kbps';

    console.log(`🎬 FFmpeg RTP (${logSettings}): ${this.ffmpegPath} ${args.slice(0, 5).join(' ')}...`);

    const process = spawn(this.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return process;
  }

  /**
   * Create FFmpeg process for RTMP output (LiveKit)
   * Uses adaptive encoding settings when available, falls back to fixed 720p
   */
  _createFFmpegRTMPProcess(input, rtmpUrl, streamEntry) {
    const settings = streamEntry.encodingSettings;
    const useAdaptive = this.adaptiveConfig.enabled && settings;

    const args = [];

    // Input buffer settings for smoother streaming
    args.push(
      '-analyzeduration', '3000000',   // 3 seconds - balance between startup speed and stability
      '-probesize', '10000000',        // 10MB - read more data for format detection
      '-fflags', '+genpts+discardcorrupt+nobuffer',
      '-flags', 'low_delay',
      '-max_delay', '500000'           // 500ms max delay
    );

    // Add -re flag and reconnect options for direct HLS/URL inputs (not piped stdin)
    if (input !== '-') {
      args.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-re'
      );
      console.log(`📡 Using -re flag with reconnect for direct URL input: ${input.substring(0, 60)}...`);
    } else {
      // For piped input, add thread queue size for better buffering
      args.push('-thread_queue_size', '4096');
    }

    // Input
    args.push('-i', input);

    // Experimental: VIEWBOT_STREAM_COPY=true bypasses re-encoding entirely.
    // Only works when the source is already H.264 + AAC (most IVS/Kick/Twitch HLS).
    // Risk: GOP/keyframe mismatch can cause WebRTC subscriber freeze-on-join,
    // and a silent platform-side codec change breaks copy with no error.
    const streamCopy = process.env.VIEWBOT_STREAM_COPY === 'true' && input !== '-';
    if (streamCopy) {
      args.push('-c:v', 'copy', '-c:a', 'copy', '-bsf:v', 'h264_mp4toannexb');
      args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', rtmpUrl);
      console.log(`🎬 FFmpeg RTMP [STREAM-COPY]: ${this.ffmpegPath} -i ${input.substring(0, 60)}... -> ${rtmpUrl}`);
      const process = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      return process;
    }

    // Video filter - use adaptive scale or default 720p
    if (useAdaptive && settings.scale) {
      args.push('-vf', settings.scale);
    } else if (useAdaptive) {
      // No scaling needed if source matches target
      // Add fps filter if needed
      if (settings.sourceFps && Math.abs(settings.sourceFps - settings.fps) > 2) {
        args.push('-vf', `fps=${settings.fps}`);
      }
    } else {
      // Default: scale to 720p
      args.push('-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
    }

    // Video encoding - use adaptive or default settings
    if (useAdaptive) {
      args.push(
        '-c:v', 'libx264',
        '-preset', settings.preset,
        '-profile:v', settings.profile,
        '-level', settings.level,
        '-b:v', `${settings.videoBitrate}k`,
        '-maxrate', `${settings.maxrate}k`,
        '-bufsize', `${settings.bufsize}k`,
        '-pix_fmt', settings.pixFmt,
        '-r', String(settings.fps),
        '-g', String(settings.gopSize),
        '-keyint_min', String(settings.keyintMin),
        '-sc_threshold', String(settings.scThreshold)
      );
    } else {
      // Default fixed settings (720p @ 2Mbps). Used only when the source probe fails;
      // the adaptive path is the hot path. Values mirror viewbot-config.json's 2 Mbps
      // target and the LiveKit ingress's 2125 kbps tier.
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-profile:v', 'main',
        '-level', '3.1',
        '-b:v', '2000k',
        '-maxrate', '2500k',
        '-bufsize', '4000k',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-g', '60',
        '-keyint_min', '30',
        '-sc_threshold', '0'
      );
    }

    // Audio encoding
    args.push(
      '-c:a', 'aac',
      '-b:a', useAdaptive && settings.audioBitrate ? `${settings.audioBitrate}k` : '160k',
      '-ar', '48000',
      '-ac', useAdaptive ? String(settings.audioChannels || 2) : '2'
    );

    // Output with RTMP optimizations for smoother streaming
    args.push(
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',  // Don't write duration/filesize (causes issues with live)
      rtmpUrl
    );

    const logSettings = useAdaptive
      ? `ADAPTIVE ${settings.width}x${settings.height}@${settings.fps}fps ${settings.videoBitrate}kbps`
      : 'FIXED 720p@30fps 4000kbps';

    console.log(`🎬 FFmpeg RTMP (${logSettings}): ${this.ffmpegPath} ... -> ${rtmpUrl}`);

    const process = spawn(this.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return process;
  }

  /**
   * Setup FFmpeg process event handlers
   */
  _setupFFmpegHandlers(urlId, ffmpegProcess) {
    let lastProgressTime = Date.now();
    let lastHealthReportTime = 0;

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();

      // Log errors
      if (output.includes('Error') || output.includes('error')) {
        console.error(`❌ FFmpeg error for ${urlId}:`, output.substring(0, 200));
      }

      // Track progress and report to health service
      if (output.includes('frame=') || output.includes('time=')) {
        const now = Date.now();
        if (now - lastProgressTime > 30000) { // Log every 30s
          console.log(`📊 URL stream ${urlId}: FFmpeg active`);
          lastProgressTime = now;
        }

        // Report progress to health service more frequently (every 5s)
        // This prevents false "stale stream" detection
        if (global.urlStreamHealthService && now - lastHealthReportTime > 5000) {
          // Parse FFmpeg stats from output
          const stats = {};
          const frameMatch = output.match(/frame=\s*(\d+)/);
          const fpsMatch = output.match(/fps=\s*(\d+\.?\d*)/);
          const timeMatch = output.match(/time=\s*(\d+:\d+:\d+\.\d+)/);
          const bitrateMatch = output.match(/bitrate=\s*(\d+\.?\d*\w+)/);

          if (frameMatch) stats.frame = parseInt(frameMatch[1]);
          if (fpsMatch) stats.fps = parseFloat(fpsMatch[1]);
          if (timeMatch) stats.time = timeMatch[1];
          if (bitrateMatch) stats.bitrate = bitrateMatch[1];

          global.urlStreamHealthService.updateFFmpegProgress(urlId, stats);
          lastHealthReportTime = now;
        }
      }

      // Detect stream end
      if (output.includes('EOF') || output.includes('End of file')) {
        console.log(`🏁 URL stream ${urlId}: Source stream ended`);
        this._handleStreamEnd(urlId, 'source_ended');
      }

      // CRITICAL: Detect HTTP errors from source stream (403 Forbidden, 404 Not Found, etc.)
      // These cause FFmpeg to exit with code 0 but the stream is dead
      const httpErrorMatch = output.match(/HTTP error (\d{3})/);
      if (httpErrorMatch) {
        const errorCode = httpErrorMatch[1];
        console.error(`🚫 URL stream ${urlId}: Source returned HTTP ${errorCode}`);
        // Mark that we detected an HTTP error - will trigger reconnect on FFmpeg exit
        const stream = this.activeStreams.get(urlId);
        if (stream) {
          stream._httpError = parseInt(errorCode);
        }
      }
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`❌ FFmpeg process error for ${urlId}:`, err);
      this._handleStreamError(urlId, 'ffmpeg', err);
    });

    ffmpegProcess.on('exit', (code, signal) => {
      console.log(`📤 FFmpeg exited for ${urlId} with code ${code}, signal ${signal}`);

      // CRITICAL FIX: Handle code 0 exits that are actually errors
      // HTTP 403/404 errors cause FFmpeg to exit "successfully" with code 0
      const stream = this.activeStreams.get(urlId);

      if (code !== 0 && code !== null) {
        this._handleStreamError(urlId, 'ffmpeg', new Error(`Exit code ${code}`));
      } else if (code === 0 && stream && stream.status === 'streaming') {
        // FFmpeg exited with code 0 but stream was supposed to be running
        // This happens with HTTP 403, source going offline, etc.
        const httpError = stream._httpError;
        if (httpError) {
          console.log(`🔄 URL stream ${urlId}: FFmpeg exited normally after HTTP ${httpError}, triggering recovery`);
          this._handleStreamError(urlId, 'ffmpeg', new Error(`Source HTTP error ${httpError}`));
        } else {
          console.log(`🔄 URL stream ${urlId}: FFmpeg exited normally while streaming, triggering recovery`);
          this._handleStreamError(urlId, 'ffmpeg', new Error('Unexpected stream end'));
        }
      }
    });
  }

  /**
   * Wait for FFmpeg to start producing output
   * Fails fast if FFmpeg exits early (e.g., HTTP 404, connection refused)
   */
  _waitForStream(ffmpegProcess, timeout) {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        clearTimeout(timer);
        ffmpegProcess.stderr.removeListener('data', checkOutput);
        ffmpegProcess.removeListener('exit', onExit);
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error('FFmpeg startup timeout'));
        }
      }, timeout);

      const checkOutput = (data) => {
        const output = data.toString();
        if (output.includes('frame=') || output.includes('Stream mapping')) {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve();
          }
        }
      };

      // CRITICAL: Fail fast if FFmpeg exits before producing output
      // This happens with HTTP 404/403, connection refused, invalid URLs, etc.
      const onExit = (code) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`FFmpeg exited early with code ${code}`));
        }
      };

      ffmpegProcess.stderr.on('data', checkOutput);
      ffmpegProcess.on('exit', onExit);
    });
  }

  /**
   * Handle stream errors with optional reconnection
   * CRITICAL: Uses mutex to prevent multiple simultaneous reconnect attempts
   */
  async _handleStreamError(urlId, source, error) {
    const streamEntry = this.activeStreams.get(urlId);
    if (!streamEntry) return;

    console.error(`❌ Stream error for ${urlId} (${source}):`, error.message);

    // CRITICAL: Check if already reconnecting to prevent race conditions
    // Multiple error events (FFmpeg error, streamlink exit, etc.) could fire simultaneously
    if (this._reconnecting) {
      console.log(`⏳ URL STREAM: Ignoring error for ${urlId} - reconnect already in progress`);
      return;
    }

    // CRITICAL: Check if a new stream is starting (mutex check)
    if (this._startingStream) {
      console.log(`⏳ URL STREAM: Ignoring error for ${urlId} - new stream is starting`);
      return;
    }

    // CRITICAL: For HTTP 4xx errors (403 Forbidden, 404 Not Found, etc.)
    // For Kick streams with 403 (token expired), try to refresh the token
    // For other platforms or non-refreshable errors, end stream immediately
    const httpError = streamEntry._httpError;
    if (httpError && httpError >= 400 && httpError < 500) {
      streamEntry._httpError = null; // Clear the flag

      // Special handling for Kick 403 errors - try token refresh
      if (httpError === 403 && streamEntry.platform === 'kick' && streamEntry.kickUsername) {
        if (streamEntry.tokenRefreshAttempts < streamEntry.maxTokenRefreshAttempts) {
          console.log(`🔄 KICK TOKEN: HTTP 403 detected - attempting token refresh for ${streamEntry.kickUsername} (attempt ${streamEntry.tokenRefreshAttempts + 1}/${streamEntry.maxTokenRefreshAttempts})`);

          // Try to refresh token and restart stream
          const refreshed = await this._refreshKickTokenAndRestart(urlId, streamEntry);
          if (refreshed) {
            return; // Successfully refreshed, don't end stream
          }
          // If refresh failed, fall through to end stream
          console.log(`❌ KICK TOKEN: Token refresh failed, ending stream`);
        } else {
          console.log(`🚫 KICK TOKEN: Max token refresh attempts (${streamEntry.maxTokenRefreshAttempts}) reached for ${urlId}`);
        }
      }

      console.log(`🚫 URL STREAM: HTTP ${httpError} error - ending stream immediately`);
      this._handleStreamEnd(urlId, 'http_error');
      return;
    }

    if (streamEntry.autoReconnect && streamEntry.reconnectAttempts < streamEntry.maxReconnectAttempts) {
      // CRITICAL: Set reconnecting mutex BEFORE any async operations
      this._reconnecting = true;

      // CRITICAL: Clear health data so reconnected stream gets fresh grace period
      // Without this, the old stale timestamp persists and triggers immediate reconnect loops
      if (global.urlStreamHealthService) {
        console.log(`🏥 Clearing health data for ${urlId} before reconnect`);
        global.urlStreamHealthService.clearHealthData(urlId);
      }

      try {
        streamEntry.reconnectAttempts++;
        streamEntry.status = 'reconnecting';

        console.log(`🔄 Attempting reconnect ${streamEntry.reconnectAttempts}/${streamEntry.maxReconnectAttempts} for ${urlId}`);

        // Stop current processes
        await this._stopProcesses(streamEntry);

        // Clean up LiveKit ingress before reconnect (critical to prevent "Publish failed" errors)
        if (streamEntry.ingressInfo && this.livekitService) {
          try {
            console.log(`🧹 Cleaning up old LiveKit ingress ${streamEntry.ingressInfo.ingressId} before reconnect`);
            await this.livekitService.deleteIngress(streamEntry.ingressInfo.ingressId);
            streamEntry.ingressInfo = null;
          } catch (err) {
            console.error(`⚠️ Error cleaning up old ingress for ${urlId}:`, err.message);
          }
        }

        // Wait before reconnecting (exponential backoff)
        const delay = Math.min(5000 * Math.pow(2, streamEntry.reconnectAttempts - 1), 30000);
        console.log(`⏳ Waiting ${delay/1000}s before reconnect attempt for ${urlId}`);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Verify stream is still in activeStreams (could have been stopped during delay)
        if (!this.activeStreams.has(urlId)) {
          console.log(`⚠️ URL STREAM: Stream ${urlId} was removed during reconnect delay, aborting`);
          return;
        }

        // Attempt restart
        try {
          if (this.backend === 'livekit' && this.livekitService) {
            await this._startLiveKitStream(urlId, streamEntry);
          } else {
            await this._startMediaSoupStream(urlId, streamEntry);
          }
          streamEntry.status = 'streaming';
          streamEntry.reconnectAttempts = 0; // Reset on success
          console.log(`✅ Reconnected successfully: ${urlId}`);

          // CRITICAL: Re-register as current streamer after reconnect
          // This ensures status indicator stays correct
          if (this.streamService) {
            console.log(`📢 URL STREAM: Re-registering ${urlId} as current streamer after reconnect`);
            this.streamService.setStreamer(urlId);
          }
          if (global.mediasoupService) {
            global.mediasoupService.currentStreamer = urlId;
          }

          // Notify viewers about the reconnected stream
          if (this.io) {
            this.io.emit('stream-reconnected', {
              streamerId: urlId,
              streamerName: streamEntry.displayName,
              isUrlStream: true
            });
          }
        } catch (reconnectError) {
          console.error(`❌ Reconnect failed for ${urlId}:`, reconnectError.message);
          this._handleStreamEnd(urlId, 'reconnect_failed');
        }
      } finally {
        // CRITICAL: Always release the reconnect mutex
        this._reconnecting = false;
      }
    } else {
      this._handleStreamEnd(urlId, 'error');
    }
  }

  /**
   * Handle stream ending
   */
  async _handleStreamEnd(urlId, reason) {
    const streamEntry = this.activeStreams.get(urlId);
    if (!streamEntry) return;

    console.log(`🛑 URL stream ended: ${urlId} (reason: ${reason})`);

    // Stop all processes
    await this._stopProcesses(streamEntry);

    // Clean up LiveKit ingress if exists
    if (streamEntry.ingressInfo && this.livekitService) {
      try {
        console.log(`🧹 Cleaning up LiveKit ingress ${streamEntry.ingressInfo.ingressId} for ${urlId}`);
        await this.livekitService.deleteIngress(streamEntry.ingressInfo.ingressId);
        streamEntry.ingressInfo = null;
      } catch (err) {
        console.error(`⚠️ Error cleaning up LiveKit ingress for ${urlId}:`, err.message);
      }
    }

    // Update status
    streamEntry.status = 'ended';
    streamEntry.endedAt = Date.now();
    streamEntry.endReason = reason;

    // Remove from active streams
    this.activeStreams.delete(urlId);

    // CRITICAL: Clear the currentStreamer if this was the active streamer
    // This ensures other systems know no stream is active
    if (this.streamService) {
      const currentStreamer = this.streamService.getCurrentStreamer();
      if (currentStreamer === urlId) {
        console.log(`🧹 URL STREAM: Clearing currentStreamer (was ${urlId})`);
        this.streamService.clearStreamer();
      }
    }

    // Emit event
    this.emit('url-stream-ended', {
      urlId,
      reason,
      sourceUrl: streamEntry.sourceUrl,
      duration: streamEntry.endedAt - streamEntry.startedAt
    });

    // Notify viewers that URL stream has ended
    if (this.io) {
      console.log('📢 URL STREAM: Broadcasting stream-ended event (natural end)');
      this.io.emit('stream-ended', {
        reason: `url_stream_${reason}`,
        streamerId: urlId,
        isUrlStream: true
      });
    }

    // Resume viewbot rotation if no more URL streams are active
    if (this.activeStreams.size === 0) {
      await this._resumeViewBots();
    }
  }

  /**
   * Refresh Kick token and restart stream with new playback URL
   * Used when a Kick stream gets 403 Forbidden (token expired)
   * @returns {boolean} true if refresh succeeded, false otherwise
   */
  async _refreshKickTokenAndRestart(urlId, streamEntry) {
    try {
      streamEntry.tokenRefreshAttempts++;
      streamEntry.status = 'refreshing_token';

      console.log(`🔑 KICK TOKEN: Getting fresh playback URL for ${streamEntry.kickUsername}...`);

      // Get fresh playback URL from Kick
      const playbackInfo = await this.kickService.getPlaybackUrl(streamEntry.kickUsername);

      if (!playbackInfo || !playbackInfo.playback_url) {
        console.error(`❌ KICK TOKEN: Failed to get fresh playback URL for ${streamEntry.kickUsername}`);
        return false;
      }

      const newPlaybackUrl = playbackInfo.playback_url;
      console.log(`✅ KICK TOKEN: Got fresh playback URL for ${streamEntry.kickUsername}`);

      // Stop current FFmpeg/streamlink processes
      console.log(`🛑 KICK TOKEN: Stopping current processes for ${urlId}...`);
      await this._stopProcesses(streamEntry);

      // Clean up LiveKit ingress before restart
      if (streamEntry.ingressInfo && this.livekitService) {
        try {
          console.log(`🧹 KICK TOKEN: Cleaning up old LiveKit ingress ${streamEntry.ingressInfo.ingressId}`);
          await this.livekitService.deleteIngress(streamEntry.ingressInfo.ingressId);
          streamEntry.ingressInfo = null;
        } catch (err) {
          console.error(`⚠️ KICK TOKEN: Error cleaning up old ingress:`, err.message);
        }
      }

      // Clear health data for fresh grace period
      if (global.urlStreamHealthService) {
        console.log(`🏥 KICK TOKEN: Clearing health data for ${urlId}`);
        global.urlStreamHealthService.clearHealthData(urlId);
      }

      // Update stream entry with new URL
      streamEntry.sourceUrl = newPlaybackUrl;

      // Update streamInfo for direct HLS playback
      streamEntry.streamInfo = {
        mode: 'direct',
        url: newPlaybackUrl
      };

      // Small delay to let cleanup complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify stream is still in activeStreams
      if (!this.activeStreams.has(urlId)) {
        console.log(`⚠️ KICK TOKEN: Stream ${urlId} was removed during token refresh, aborting`);
        return false;
      }

      // Restart the stream with fresh URL
      console.log(`🚀 KICK TOKEN: Restarting stream with fresh URL...`);

      try {
        if (this.backend === 'livekit' && this.livekitService) {
          await this._startLiveKitStream(urlId, streamEntry);
        } else {
          await this._startMediaSoupStream(urlId, streamEntry);
        }

        streamEntry.status = 'streaming';
        console.log(`✅ KICK TOKEN: Successfully refreshed and restarted stream ${urlId}`);

        // Re-register as current streamer
        if (this.streamService) {
          console.log(`📢 KICK TOKEN: Re-registering ${urlId} as current streamer`);
          this.streamService.setStreamer(urlId);
        }
        if (global.mediasoupService) {
          global.mediasoupService.currentStreamer = urlId;
        }

        return true;
      } catch (restartError) {
        console.error(`❌ KICK TOKEN: Failed to restart stream: ${restartError.message}`);
        return false;
      }
    } catch (error) {
      console.error(`❌ KICK TOKEN: Error during token refresh: ${error.message}`);
      return false;
    }
  }

  /**
   * Stop all processes for a stream
   * Properly waits for process termination with fallback to SIGKILL
   */
  async _stopProcesses(streamEntry) {
    const killPromises = streamEntry.processes.map(async ({ type, process }) => {
      if (!process || process.killed) {
        return;
      }

      const pid = process.pid;
      console.log(`🛑 Killing ${type} process (PID ${pid}) for ${streamEntry.urlId}`);

      return new Promise((resolve) => {
        let resolved = false;

        // Handle process exit
        const onExit = () => {
          if (!resolved) {
            resolved = true;
            console.log(`✅ ${type} process (PID ${pid}) terminated for ${streamEntry.urlId}`);
            resolve();
          }
        };

        process.once('exit', onExit);
        process.once('close', onExit);

        // Try SIGTERM first
        try {
          process.kill('SIGTERM');
        } catch (err) {
          // Process might already be dead
          if (err.code !== 'ESRCH') {
            console.error(`⚠️ Error sending SIGTERM to ${type} (PID ${pid}):`, err.message);
          }
          if (!resolved) {
            resolved = true;
            resolve();
          }
          return;
        }

        // Force SIGKILL after 3 seconds if not dead
        setTimeout(() => {
          if (!resolved && !process.killed) {
            console.log(`⚠️ Force killing ${type} process (PID ${pid}) with SIGKILL`);
            try {
              process.kill('SIGKILL');
            } catch (err) {
              // Ignore errors - process may already be dead
            }
          }
        }, 3000);

        // Final timeout to prevent hanging - resolve after 5 seconds max
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            console.log(`⏱️ ${type} process (PID ${pid}) cleanup timeout - continuing`);
            resolve();
          }
        }, 5000);
      });
    });

    // Wait for all processes to be killed (with timeout protection)
    await Promise.all(killPromises);
    streamEntry.processes = [];
  }

  /**
   * Stop a URL stream
   */
  async stopURLStream(urlId) {
    const streamEntry = this.activeStreams.get(urlId);

    if (!streamEntry) {
      return { success: false, error: 'Stream not found' };
    }

    console.log(`⏹️ Stopping URL stream: ${urlId}`);

    // Stop processes
    await this._stopProcesses(streamEntry);

    // If using LiveKit, stop ingress
    if (streamEntry.ingressInfo && this.livekitService) {
      try {
        await this.livekitService.deleteIngress(streamEntry.ingressInfo.ingressId);
      } catch (err) {
        console.error('⚠️ Error stopping LiveKit ingress:', err);
      }
    }

    // Remove from active streams
    this.activeStreams.delete(urlId);

    // Emit event
    this.emit('url-stream-stopped', { urlId });

    // Notify viewers that URL stream has ended
    if (this.io) {
      console.log('📢 URL STREAM: Broadcasting stream-ended event to all viewers');
      this.io.emit('stream-ended', {
        reason: 'url_stream_stopped',
        streamerId: urlId,
        isUrlStream: true
      });
    }

    console.log(`✅ URL stream stopped: ${urlId}`);

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
    console.log(`🛑 Stopping all URL streams (${this.activeStreams.size} active)`);

    const stopPromises = [];
    for (const urlId of this.activeStreams.keys()) {
      stopPromises.push(this.stopURLStream(urlId));
    }

    await Promise.allSettled(stopPromises);

    // SAFETY NET: Kill any orphaned processes that weren't tracked
    try {
      const { exec } = require('child_process');
      exec('pkill -9 -f "ffmpeg.*rtmp://127.0.0.1:1935"', () => {});
      exec('pkill -9 -f "streamlink.*twitch|streamlink.*kick"', () => {});
    } catch (err) {
      // Ignore errors
    }

    console.log('✅ All URL streams stopped');
  }

  /**
   * CRITICAL: Clean up ALL URL stream ingresses and participants from LiveKit
   * This handles orphaned streams that aren't tracked in activeStreams
   * (e.g., from server restarts or failed cleanup)
   * @param {string} excludeUrlId - Optional URL ID to exclude from cleanup (for the new stream being started)
   */
  async _cleanupAllURLStreamIngresses(excludeUrlId = null) {
    if (!this.livekitService) {
      console.log('⚠️ URL STREAM CLEANUP: No LiveKit service, skipping ingress cleanup');
      return;
    }

    try {
      const { IngressClient, RoomServiceClient } = require('livekit-server-sdk');
      const host = this.livekitService.config?.host || 'http://localhost:7882';
      const apiKey = this.livekitService.config?.apiKey;
      const apiSecret = this.livekitService.config?.apiSecret;
      const roomName = this.livekitService.config?.roomName || 'onestreamer-main';

      const ingressClient = new IngressClient(
        host.startsWith('http') ? host : `http://${host}`,
        apiKey,
        apiSecret
      );
      const roomClient = new RoomServiceClient(
        host.startsWith('http') ? host : `http://${host}`,
        apiKey,
        apiSecret
      );

      // 1. List and delete ALL url-stream AND viewbot ingresses
      console.log(`🧹 URL STREAM CLEANUP: Listing all ingresses...${excludeUrlId ? ` (excluding ${excludeUrlId})` : ''}`);
      const allIngresses = await ingressClient.listIngress({ roomName });

      // Find URL stream ingresses (excluding the one we're starting)
      const urlStreamIngresses = allIngresses.filter(ing => {
        const isUrlStream = ing.participantIdentity?.startsWith('url-stream-') ||
          ing.name?.includes('url-stream');
        // If excludeUrlId is set, skip ingresses that match
        if (excludeUrlId && (ing.participantIdentity === excludeUrlId || ing.name?.includes(excludeUrlId))) {
          console.log(`🔒 URL STREAM CLEANUP: Preserving ingress for new stream: ${ing.participantIdentity}`);
          return false;
        }
        return isUrlStream;
      });

      // Find viewbot ingresses (they should be stopped when URL stream starts)
      const viewbotIngresses = allIngresses.filter(ing =>
        ing.participantIdentity?.startsWith('viewbot-') ||
        ing.name?.includes('viewbot')
      );

      console.log(`🧹 URL STREAM CLEANUP: Found ${urlStreamIngresses.length} URL stream ingresses and ${viewbotIngresses.length} viewbot ingresses to clean up`);

      // Delete URL stream ingresses
      for (const ingress of urlStreamIngresses) {
        try {
          await ingressClient.deleteIngress(ingress.ingressId);
          console.log(`🗑️ URL STREAM CLEANUP: Deleted URL stream ingress ${ingress.ingressId} (${ingress.participantIdentity})`);
        } catch (err) {
          console.error(`⚠️ URL STREAM CLEANUP: Failed to delete ingress ${ingress.ingressId}:`, err.message);
        }
      }

      // Delete viewbot ingresses
      for (const ingress of viewbotIngresses) {
        try {
          await ingressClient.deleteIngress(ingress.ingressId);
          console.log(`🗑️ URL STREAM CLEANUP: Deleted viewbot ingress ${ingress.ingressId} (${ingress.participantIdentity})`);
        } catch (err) {
          console.error(`⚠️ URL STREAM CLEANUP: Failed to delete viewbot ingress ${ingress.ingressId}:`, err.message);
        }
      }

      // 2. Remove ALL url-stream participants from the room (excluding the new stream)
      console.log('🧹 URL STREAM CLEANUP: Listing room participants...');
      const participants = await roomClient.listParticipants(roomName);
      const urlStreamParticipants = participants.filter(p => {
        if (!p.identity?.startsWith('url-stream-')) return false;
        // If excludeUrlId is set, skip the new stream's participant
        if (excludeUrlId && p.identity === excludeUrlId) {
          console.log(`🔒 URL STREAM CLEANUP: Preserving participant for new stream: ${p.identity}`);
          return false;
        }
        return true;
      });

      console.log(`🧹 URL STREAM CLEANUP: Found ${urlStreamParticipants.length} URL stream participants to remove`);

      for (const participant of urlStreamParticipants) {
        try {
          await roomClient.removeParticipant(roomName, participant.identity);
          console.log(`🗑️ URL STREAM CLEANUP: Removed participant ${participant.identity}`);
        } catch (err) {
          console.error(`⚠️ URL STREAM CLEANUP: Failed to remove participant ${participant.identity}:`, err.message);
        }
      }

      // 3. Also remove viewbot participants that have tracks (they shouldn't be publishing alongside URL stream)
      const viewbotParticipants = participants.filter(p =>
        p.identity?.startsWith('viewbot-') && p.tracks && p.tracks.length > 0
      );

      console.log(`🧹 URL STREAM CLEANUP: Found ${viewbotParticipants.length} viewbot participants with tracks to remove`);

      for (const participant of viewbotParticipants) {
        try {
          await roomClient.removeParticipant(roomName, participant.identity);
          console.log(`🗑️ URL STREAM CLEANUP: Removed viewbot participant ${participant.identity}`);
        } catch (err) {
          console.error(`⚠️ URL STREAM CLEANUP: Failed to remove viewbot participant ${participant.identity}:`, err.message);
        }
      }

      // 4. CRITICAL: Stop all LOCAL processes (FFmpeg, streamlink) for tracked streams (excluding new stream)
      console.log('🧹 URL STREAM CLEANUP: Stopping local processes for tracked streams...');
      for (const [urlId, streamEntry] of this.activeStreams) {
        // Skip the new stream we're starting
        if (excludeUrlId && urlId === excludeUrlId) {
          console.log(`🔒 URL STREAM CLEANUP: Preserving processes for new stream: ${urlId}`);
          continue;
        }
        if (streamEntry.processes && streamEntry.processes.length > 0) {
          console.log(`🛑 URL STREAM CLEANUP: Stopping ${streamEntry.processes.length} processes for ${urlId}`);
          await this._stopProcesses(streamEntry);
        }
      }

      // 5. SAFETY NET: Kill any orphaned ffmpeg/streamlink processes by pattern
      // This catches processes that weren't properly tracked
      // IMPORTANT: Skip pkill if we're preserving a stream - pkill would kill ALL processes including the new one
      if (!excludeUrlId) {
        console.log('🧹 URL STREAM CLEANUP: Killing any orphaned streaming processes...');
        try {
          const { exec } = require('child_process');
          await new Promise((resolve) => {
            exec('pkill -9 -f "ffmpeg.*rtmp://127.0.0.1:1935"', (err) => {
              if (!err) console.log('🗑️ URL STREAM CLEANUP: Killed orphaned FFmpeg RTMP processes');
              resolve();
            });
          });
          await new Promise((resolve) => {
            exec('pkill -9 -f "streamlink.*twitch|streamlink.*kick"', (err) => {
              if (!err) console.log('🗑️ URL STREAM CLEANUP: Killed orphaned streamlink processes');
              resolve();
            });
          });
        } catch (err) {
          console.error('⚠️ URL STREAM CLEANUP: Error killing orphaned processes:', err.message);
        }
      } else {
        console.log('🔒 URL STREAM CLEANUP: Skipping pkill to preserve new stream processes');
      }

      // 6. Clear local tracking (but preserve excluded stream entry)
      if (excludeUrlId) {
        const preservedEntry = this.activeStreams.get(excludeUrlId);
        this.activeStreams.clear();
        if (preservedEntry) {
          this.activeStreams.set(excludeUrlId, preservedEntry);
          console.log(`🔒 URL STREAM CLEANUP: Preserved activeStream entry for ${excludeUrlId}`);
        }
      } else {
        this.activeStreams.clear();
      }
      console.log('✅ URL STREAM CLEANUP: Complete - old URL streams, processes, and viewbots cleaned up');

    } catch (error) {
      console.error('❌ URL STREAM CLEANUP: Error during cleanup:', error.message);
    }
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
   * Clean shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down ViewBotURLService');
    await this.stopAllURLStreams();
  }
}

module.exports = ViewBotURLService;
