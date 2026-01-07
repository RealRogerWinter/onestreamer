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
const webrtcConfig = require('../config/webrtc.config');

class ViewBotURLService extends EventEmitter {
  constructor() {
    super();

    // Dependencies
    this.extractorService = new URLStreamExtractorService();
    this.probeService = new StreamProbeService();
    this.streamService = null;
    this.livekitService = null;

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

    // Adaptive encoding configuration
    this.adaptiveConfig = {
      enabled: true,           // Enable adaptive encoding by default
      mode: 'balanced',        // 'performance', 'balanced', or 'quality'
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
          const config = require('../config/livekit.config');
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
      autoReconnect = true
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
      console.log(`🚀 Starting URL stream: ${urlId}`);
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
        // Small delay to ensure cleanup is complete
        await new Promise(resolve => setTimeout(resolve, 500));
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
        maxReconnectAttempts: 3
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
    await this._waitForStream(ffmpegProcess, 10000);

    console.log(`✅ MediaSoup pipeline started for ${urlId}`);
  }

  /**
   * Start LiveKit RTMP stream pipeline
   * Uses: streamlink -> FFmpeg -> RTMP -> LiveKit
   */
  async _startLiveKitStream(urlId, streamEntry) {
    const { sourceUrl, quality, streamInfo } = streamEntry;

    console.log(`🎥 Starting LiveKit pipeline for ${urlId}`);

    // Create ingress with bot-like object (createIngress expects bot.id)
    const ingress = await this.livekitService.createIngress({
      id: urlId,
      name: streamEntry.displayName
    });

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
    await this._waitForStream(ffmpegProcess, 10000);

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

    const args = [
      '-re', // Read input at native frame rate
      '-i', input,
    ];

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

    // Input settings
    args.push('-fflags', '+genpts+discardcorrupt');

    // Add -re flag for direct HLS/URL inputs (not piped stdin)
    if (input !== '-') {
      args.push('-re');
      console.log(`📡 Using -re flag for direct URL input: ${input.substring(0, 60)}...`);
    }

    // Input
    args.push('-i', input);

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
      // Default fixed settings (720p @ 4Mbps)
      args.push(
        '-c:v', 'libx264',
        '-preset', 'superfast',
        '-profile:v', 'main',
        '-level', '3.1',
        '-b:v', '4000k',
        '-maxrate', '4500k',
        '-bufsize', '6000k',
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

    // Output
    args.push('-f', 'flv', rtmpUrl);

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

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();

      // Log errors
      if (output.includes('Error') || output.includes('error')) {
        console.error(`❌ FFmpeg error for ${urlId}:`, output.substring(0, 200));
      }

      // Track progress
      if (output.includes('frame=') || output.includes('time=')) {
        const now = Date.now();
        if (now - lastProgressTime > 30000) { // Log every 30s
          console.log(`📊 URL stream ${urlId}: FFmpeg active`);
          lastProgressTime = now;
        }
      }

      // Detect stream end
      if (output.includes('EOF') || output.includes('End of file')) {
        console.log(`🏁 URL stream ${urlId}: Source stream ended`);
        this._handleStreamEnd(urlId, 'source_ended');
      }
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`❌ FFmpeg process error for ${urlId}:`, err);
      this._handleStreamError(urlId, 'ffmpeg', err);
    });

    ffmpegProcess.on('exit', (code, signal) => {
      console.log(`📤 FFmpeg exited for ${urlId} with code ${code}, signal ${signal}`);
      if (code !== 0 && code !== null) {
        this._handleStreamError(urlId, 'ffmpeg', new Error(`Exit code ${code}`));
      }
    });
  }

  /**
   * Wait for FFmpeg to start producing output
   */
  _waitForStream(ffmpegProcess, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('FFmpeg startup timeout'));
      }, timeout);

      const checkOutput = (data) => {
        const output = data.toString();
        if (output.includes('frame=') || output.includes('Stream mapping')) {
          clearTimeout(timer);
          ffmpegProcess.stderr.removeListener('data', checkOutput);
          resolve();
        }
      };

      ffmpegProcess.stderr.on('data', checkOutput);
    });
  }

  /**
   * Handle stream errors with optional reconnection
   */
  async _handleStreamError(urlId, source, error) {
    const streamEntry = this.activeStreams.get(urlId);
    if (!streamEntry) return;

    console.error(`❌ Stream error for ${urlId} (${source}):`, error.message);

    if (streamEntry.autoReconnect && streamEntry.reconnectAttempts < streamEntry.maxReconnectAttempts) {
      streamEntry.reconnectAttempts++;
      streamEntry.status = 'reconnecting';

      console.log(`🔄 Attempting reconnect ${streamEntry.reconnectAttempts}/${streamEntry.maxReconnectAttempts} for ${urlId}`);

      // Stop current processes
      await this._stopProcesses(streamEntry);

      // Wait before reconnecting (exponential backoff)
      const delay = Math.min(5000 * Math.pow(2, streamEntry.reconnectAttempts - 1), 30000);
      await new Promise(resolve => setTimeout(resolve, delay));

      // Attempt restart
      try {
        if (this.backend === 'livekit' && this.livekitService) {
          await this._startLiveKitStream(urlId, streamEntry);
        } else {
          await this._startMediaSoupStream(urlId, streamEntry);
        }
        streamEntry.status = 'streaming';
        console.log(`✅ Reconnected successfully: ${urlId}`);
      } catch (reconnectError) {
        console.error(`❌ Reconnect failed for ${urlId}:`, reconnectError);
        this._handleStreamEnd(urlId, 'reconnect_failed');
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
    this._stopProcesses(streamEntry);

    // Update status
    streamEntry.status = 'ended';
    streamEntry.endedAt = Date.now();
    streamEntry.endReason = reason;

    // Remove from active streams
    this.activeStreams.delete(urlId);

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
   * Stop all processes for a stream
   */
  async _stopProcesses(streamEntry) {
    for (const { type, process } of streamEntry.processes) {
      try {
        if (process && !process.killed) {
          console.log(`🛑 Killing ${type} process for ${streamEntry.urlId}`);
          process.kill('SIGTERM');

          // Force kill after timeout
          setTimeout(() => {
            if (!process.killed) {
              process.kill('SIGKILL');
            }
          }, 3000);
        }
      } catch (err) {
        console.error(`⚠️ Error killing ${type} process:`, err);
      }
    }
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

    console.log('✅ All URL streams stopped');
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
