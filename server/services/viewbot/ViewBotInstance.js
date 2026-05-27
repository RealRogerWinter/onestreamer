/**
 * ViewBotInstance — extracted from ViewBotClientService.js in PR 11.1
 *
 * Individual streaming bot client. Created and owned by ViewBotClientService;
 * not used anywhere else in the codebase. Communicates upward only through
 * `this.parentService` (read-mostly, with two writes: `currentLiveBot` and
 * `currentLiveBotSetTime`, plus DB writes via `parentService.dbService`).
 *
 * Extraction rationale: see ADR-0019. The split is mechanical — no behavior
 * change, no API change. The orchestrator file shrinks from 6015 → ~2290 lines;
 * this file holds the per-bot streaming logic that previously cohabited.
 *
 * Requires path-prefix `../` instead of `./` for sibling-service imports because
 * this file lives one directory deeper than the original.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const io = require('socket.io-client');
const puppeteer = require('puppeteer');
const processManager = require('../ProcessManager');
const stateManager = require('../ViewBotStateManager');

const logger = require('../../bootstrap/logger').child({ svc: 'ViewBotInstance' });

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
    
    logger.debug(`🤖 ViewBot ${this.botId} initialized`);
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
        logger.debug(`🔄 ViewBot ${this.botId}: Updating server URL from ${this.serverUrl} to ${correctServerUrl}`);
        this.serverUrl = correctServerUrl;
      }
      
      logger.debug(`🔌 ViewBot ${this.botId}: Connecting to server ${this.serverUrl}`);
      
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
          logger.error(`❌ ViewBot ${this.botId}: Connection timeout after 10 seconds to ${this.serverUrl}`);
          reject(new Error('Connection timeout'));
        }, 10000);
        
        this.socket.on('connect', () => {
          clearTimeout(timeout);
          this.isConnected = true;
          // Clear any previous connection errors
          if (this.lastError && (this.lastError.includes('Socket') || this.lastError.includes('Connection'))) {
            this.lastError = null;
          }
          logger.debug(`✅ ViewBot ${this.botId}: Connected to server`);
          logger.debug(`📡 ViewBot ${this.botId}: My socket ID is: ${this.socket.id}`);
          logger.debug(`📡 ViewBot ${this.botId}: Socket connected: ${this.socket.connected}`);
          resolve();
        });
        
        this.socket.on('connect_error', (error) => {
          clearTimeout(timeout);
          logger.error(`❌ ViewBot ${this.botId}: Connection error:`, error.message, error.type);
          logger.error(`❌ ViewBot ${this.botId}: Failed to connect to ${this.serverUrl}`);
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
      logger.debug(`✅ ViewBot ${this.botId}: Ready for FFmpeg-based streaming`);
      
      logger.debug(`✅ ViewBot ${this.botId}: Initialization complete`);
      
    } catch (error) {
      this.lastError = error.message;
      logger.error(`❌ ViewBot ${this.botId}: Initialization failed:`, error);
      throw error;
    }
  }

  /**
   * Sets up socket event handlers
   */
  setupSocketHandlers() {
    logger.debug(`🔧 ViewBot ${this.botId}: Setting up socket handlers, socket ID: ${this.socket.id}, connected: ${this.socket.connected}`);
    
    this.socket.on('disconnect', () => {
      logger.debug(`🔌 ViewBot ${this.botId}: Disconnected from server`);
      this.isConnected = false;
      this.streaming = false;
    });

    this.socket.on('error', (error) => {
      logger.error(`❌ ViewBot ${this.botId}: Socket error:`, error);
      this.lastError = error.message || 'Socket error';
    });

    // CRITICAL: Set up streaming-approved handler with detailed logging
    this.socket.on('streaming-approved', () => {
      logger.debug(`🎉🎉🎉 ViewBot ${this.botId}: RECEIVED streaming-approved event!`);
      logger.debug(`📡 ViewBot ${this.botId}: Socket ID: ${this.socket.id}, Connected: ${this.socket.connected}`);
      
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
        logger.debug(`✅ ViewBot ${this.botId}: Updated parent service - now tracked as currentLiveBot`);
      }
      
      // Start rotation check timer now that we're approved
      this.startRotationCheckTimer();
      
      // Initialize media pipeline
      this.onStreamingApproved().catch(error => {
        logger.error(`❌ ViewBot ${this.botId}: Failed to handle streaming approval:`, error);
        this.streaming = false; // Reset streaming flag on error
        this.isStartingStream = false; // Clear the starting flag
      });
    });
    
    // Handle streaming approval with acknowledgment (for debugging)
    this.socket.on('streaming-approved-ack', (data, callback) => {
      logger.debug(`🔔 ViewBot ${this.botId}: Received streaming-approved-ack, sending acknowledgment`);
      if (callback) {
        callback(true); // Send acknowledgment back to server
      }
    });
    
    // Alternative ViewBot streaming approval event
    this.socket.on('viewbot-stream-approved', (data) => {
      logger.debug(`🎯 ViewBot ${this.botId}: Received viewbot-stream-approved!`);
      
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
        logger.debug(`✅ ViewBot ${this.botId}: Updated parent service - now tracked as currentLiveBot`);
      }
      
      // Start rotation check timer now that we're approved
      this.startRotationCheckTimer();
      
      // Initialize media pipeline
      this.onStreamingApproved().catch(error => {
        logger.error(`❌ ViewBot ${this.botId}: Failed to handle streaming approval:`, error);
        this.streaming = false;
      });
    });
    
    // Debug: Log all events received
    this.socket.onAny((eventName, ...args) => {
      if (eventName !== 'stream-status' && eventName !== 'viewer-count' && !eventName.includes('buff')) {
        logger.debug(`🔔 ViewBot ${this.botId}: Received event '${eventName}'`);
      }
    });

    // Handle takeover denial
    this.socket.on('takeover-denied', (data) => {
      logger.debug(`❌ ViewBot ${this.botId}: Takeover denied:`, data.reason);
      this.lastError = `Takeover denied: ${data.reason}`;
      this.streaming = false;
    });

    // Handle takeover by another streamer
    this.socket.on('stream-takeover', (data) => {
      logger.debug(`📢 ViewBot ${this.botId}: Stream taken over by ${data.newStreamerId}`);
      this.streaming = false;
    });

    // Handle stream end notifications
    this.socket.on('stream-ended', () => {
      logger.debug(`📺 ViewBot ${this.botId}: Stream ended notification received`);
      this.streaming = false;
    });
    
    this.socket.on('streamer-disconnected', () => {
      logger.debug(`📺 ViewBot ${this.botId}: Streamer disconnected notification received`);
    });

    // Handle viewer requests (ViewBot acting as streamer)
    this.socket.on('viewer-requesting-stream', (data) => {
      logger.debug(`👀 ViewBot ${this.botId}: Viewer ${data.viewerId} requesting stream`);
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
          logger.debug(`✅ ViewBot ${this.botId}: Confirmed as active streamer via polling!`);
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
            logger.error(`❌ ViewBot ${this.botId}: Failed to start media pipeline:`, error);
            this.streaming = false;
          });
          
          return;
        }
      } catch (error) {
        // API might not be available, continue polling
      }
      
      if (pollCount >= maxPolls) {
        logger.debug(`⏰ ViewBot ${this.botId}: Polling timeout - NOT auto-approving to prevent multiple streams`);
        clearInterval(pollInterval);
        
        // DON'T automatically start - this causes multiple bots to stream
        // The rotation system should handle starting the right bot
        this.isStartingStream = false; // Clear the starting flag
        this.streaming = false;
        
        // If this was the intended bot to stream, rotation system will retry
        logger.debug(`⚠️ ViewBot ${this.botId}: Stream request timed out without approval`);
      }
    }, 100);
  }
  
  /**
   * Called when server approves streaming - start producing media
   */
  async onStreamingApproved() {
    logger.debug(`🎬 ViewBot ${this.botId}: Now officially streaming, starting media production`);
    logger.debug(`🎬 ViewBot ${this.botId}: Socket connected: ${this.isConnected}, Socket ID: ${this.socket?.id}`);
    
    // Clear any previous errors on successful streaming approval
    this.lastError = null;
    
    // Use state manager for tracking but still create real media streams
    if (stateManager.simplifiedMode) {
      logger.debug(`🎯 ViewBot ${this.botId}: Using state manager with real media pipeline`);
      
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
        logger.debug(`🎬 ViewBot ${this.botId}: Starting GStreamer video pipeline: ${this.config.videoFile}`);
        await this.startGStreamerVideoFileStreaming();
      } else {
        logger.debug(`🎬 ViewBot ${this.botId}: Content type ${this.config.contentType} - starting media generation`);
        await this.initializeMediaGeneration();
      }
      
      // Confirm streaming is active
      this.streaming = true;
      this.isStartingStream = false; // Clear the starting flag
      
      logger.debug(`✅ ViewBot ${this.botId}: Media pipeline active, streaming to MediaSoup`);
      
      // CRITICAL: Start rotation timer for this bot
      this.startRotationCheckTimer();
      logger.debug(`🔄 ViewBot ${this.botId}: Started rotation check timer`);
      
      // Notify viewers immediately
      this.notifyViewersOfReadyStream();
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start media streaming:`, error);
      this.lastError = error.message;
      
      // CRITICAL FIX: Keep streaming=true to prevent presence system from restarting every 30s
      // The bot is "streaming" even if the media pipeline has issues
      this.streaming = true;
      this.isStartingStream = false;
      
      logger.debug(`⚠️ ViewBot ${this.botId}: Maintaining streaming=true despite media pipeline error to preserve rotation system`);
      
      // CRITICAL: Start rotation timer even if media pipeline failed
      this.startRotationCheckTimer();
      logger.debug(`🔄 ViewBot ${this.botId}: Started rotation check timer (despite media error)`);
      
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
    logger.debug(`📡 ViewBot ${this.botId}: Setting up WebRTC send transport...`);
    
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
      
      logger.debug(`✅ ViewBot ${this.botId}: Got RTP capabilities from server`);
      
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
      
      logger.debug(`✅ ViewBot ${this.botId}: WebRTC send transport created`);
      
      // Store transport info for later use
      this.transportInfo = transportInfo;
      this.rtpCapabilities = rtpCapabilities;
      
      logger.debug(`📡 ViewBot ${this.botId}: WebRTC transport setup complete`);
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: WebRTC transport setup failed:`, error);
      throw error;
    }
  }

  /**
   * Starts FFmpeg media generation and streaming to MediaSoup
   */
  async startFFmpegMediaGeneration() {
    logger.debug(`🎬 ViewBot ${this.botId}: Starting FFmpeg media generation...`);
    
    try {
      // This method is now only called for FFmpeg (GStreamer is handled in onStreamingApproved)
      if (this.config.contentType === 'videoFile' && this.config.videoFile) {
        // Use single FFmpeg process for video files (better A/V sync)
        logger.debug(`🎬 ViewBot ${this.botId}: Using combined FFmpeg for video file with A/V sync`);
        await this.startCombinedFFmpegGeneration();
      } else {
        // For test patterns, use separate processes (no sync issues with generated content)
        logger.debug(`🎬 ViewBot ${this.botId}: Using separate FFmpeg processes for test pattern`);
        // Generate test pattern video with FFmpeg
        await this.startFFmpegVideoGeneration();
        
        // Generate silent audio with FFmpeg
        await this.startFFmpegAudioGeneration();
      }
      
      logger.debug(`✅ ViewBot ${this.botId}: FFmpeg media generation started`);
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: FFmpeg media generation failed:`, error);
      throw error;
    }
  }

  /**
   * Starts combined FFmpeg process for video files (better A/V sync)
   * Now uses synchronized output approach for perfect A/V sync
   */
  async startCombinedFFmpegGeneration() {
    logger.debug(`🎬 ViewBot ${this.botId}: Starting synchronized FFmpeg for video file streaming...`);
    
    // Check if we should use the new multiplexed approach
    const useMuxedStream = this.config.useMuxedStream === true; // Default to false for stability
    
    if (useMuxedStream) {
      logger.debug(`🎬 ViewBot ${this.botId}: Using MULTIPLEXED stream for perfect A/V sync`);
      try {
        return await this.startMultiplexedFFmpegGeneration();
      } catch (error) {
        logger.error(`❌ ViewBot ${this.botId}: Multiplexed stream failed, falling back to standard approach:`, error.message);
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
    logger.debug(`📡 ViewBot ${this.botId}: Creating MediaSoup producers...`);
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
    
    logger.debug(`🎬 ViewBot ${this.botId}: Starting combined FFmpeg process...`);
    logger.debug(`🎬 ViewBot ${this.botId}: Video RTP port: ${this.videoRtpPort}, Audio RTP port: ${this.audioRtpPort}`);
    
    try {
      this.combinedFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      logger.debug(`🎬 ViewBot ${this.botId}: Combined FFmpeg process PID: ${this.combinedFFmpeg.pid}`);
      
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
    
    logger.debug(`✅ ViewBot ${this.botId}: Combined FFmpeg process started with A/V sync`);
  }

  /**
   * NEW: Starts multiplexed FFmpeg generation for perfect A/V sync
   * Uses filter_complex and synchronized timestamp handling
   * Now supports PlainTransport with RTCP synchronization
   */
  async startMultiplexedFFmpegGeneration() {
    logger.debug(`🎬 ViewBot ${this.botId}: Starting MULTIPLEXED FFmpeg stream...`);
    
    // Check if we should use PlainTransport for better sync
    const usePlainTransport = this.config.usePlainTransport === true; // Default to false for stability
    
    if (usePlainTransport) {
      logger.debug(`🎬 ViewBot ${this.botId}: Using PlainTransport with RTCP synchronization`);
      try {
        return await this.startPlainTransportFFmpegGeneration();
      } catch (error) {
        logger.error(`❌ ViewBot ${this.botId}: PlainTransport failed, falling back to standard approach:`, error.message);
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
    logger.debug(`📡 ViewBot ${this.botId}: Creating MediaSoup producers for multiplexed stream...`);
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
    
    logger.debug(`🎬 ViewBot ${this.botId}: Using filter_complex for synchronized output`);
    logger.debug(`🎬 ViewBot ${this.botId}: Video RTP port: ${this.videoRtpPort}, Audio RTP port: ${this.audioRtpPort}`);
    
    try {
      this.combinedFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', syncedArgs);
      logger.debug(`🎬 ViewBot ${this.botId}: Multiplexed FFmpeg process PID: ${this.combinedFFmpeg.pid}`);
      
      // Enhanced error handling for multiplexed stream
      this.combinedFFmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('error') || output.includes('Error')) {
          logger.error(`❌ ViewBot ${this.botId}: FFmpeg error:`, output);
        } else if (output.includes('Muxing overhead') || output.includes('video:') || output.includes('audio:')) {
          logger.debug(`✅ ViewBot ${this.botId}: Stream synchronized and running`);
        } else if (output.includes('frame=')) {
          // Log progress occasionally
          if (Math.random() < 0.01) {
            const frameMatch = output.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              logger.debug(`📊 ViewBot ${this.botId}: Multiplexed stream progress - frame ${frameMatch[1]}`);
            }
          }
        }
      });
      
      this.combinedFFmpeg.on('close', (code) => {
        logger.debug(`🛑 ViewBot ${this.botId}: Multiplexed FFmpeg process exited with code ${code}`);
        
        // Handle video end when FFmpeg exits normally for video files
        if (code === 0 && this.config.contentType === 'videoFile' && this.streaming && !this.handlingVideoEnd) {
          logger.debug(`🎬 ViewBot ${this.botId}: Video file reached end (FFmpeg exit code 0)`);
          this.handleVideoEnd();
        }
      });
      
      this.combinedFFmpeg.on('error', (error) => {
        logger.error(`❌ ViewBot ${this.botId}: FFmpeg process error:`, error);
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
    
    logger.debug(`✅ ViewBot ${this.botId}: Multiplexed FFmpeg stream started with PERFECT A/V sync`);
  }

  /**
   * NEW: Starts FFmpeg with PlainTransport and RTCP synchronization
   * This provides the best possible A/V sync with proper timestamp coordination
   */
  async startPlainTransportFFmpegGeneration() {
    logger.debug(`🎬 ViewBot ${this.botId}: Starting PlainTransport FFmpeg stream with RTCP sync...`);
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    
    // Request PlainTransport creation from server
    logger.debug(`📡 ViewBot ${this.botId}: Requesting PlainTransport creation...`);
    
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
      logger.error(`❌ ViewBot ${this.botId}: PlainTransport not available:`, error.message);
      throw error;
    });
    
    if (!transportResult.success) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to create PlainTransport`);
      // Fallback to regular approach
      return this.startMultiplexedFFmpegGeneration();
    }
    
    const { videoRtpPort, videoRtcpPort, audioRtpPort, audioRtcpPort } = transportResult;
    
    logger.debug(`✅ ViewBot ${this.botId}: PlainTransport created`);
    logger.debug(`   Video RTP: ${videoRtpPort}, RTCP: ${videoRtcpPort}`);
    logger.debug(`   Audio RTP: ${audioRtpPort}, RTCP: ${audioRtcpPort}`);
    
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
    
    logger.debug(`🎬 ViewBot ${this.botId}: Starting FFmpeg with RTCP synchronization...`);
    
    try {
      this.combinedFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      logger.debug(`🎬 ViewBot ${this.botId}: PlainTransport FFmpeg process PID: ${this.combinedFFmpeg.pid}`);
      
      // Enhanced monitoring for RTCP sync
      this.combinedFFmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('error') || output.includes('Error')) {
          logger.error(`❌ ViewBot ${this.botId}: FFmpeg error:`, output);
        } else if (output.includes('RTCP')) {
          logger.debug(`🔄 ViewBot ${this.botId}: RTCP sync active`);
        } else if (output.includes('frame=')) {
          if (Math.random() < 0.01) {
            const frameMatch = output.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              logger.debug(`📊 ViewBot ${this.botId}: PlainTransport stream - frame ${frameMatch[1]} (RTCP synced)`);
            }
          }
        }
      });
      
      this.combinedFFmpeg.on('close', (code) => {
        logger.debug(`🛑 ViewBot ${this.botId}: PlainTransport FFmpeg exited with code ${code}`);
        
        // Handle video end when FFmpeg exits normally for video files
        if (code === 0 && this.config.contentType === 'videoFile' && this.streaming && !this.handlingVideoEnd) {
          logger.debug(`🎬 ViewBot ${this.botId}: Video file reached end (FFmpeg exit code 0)`);
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
    
    logger.debug(`✅ ViewBot ${this.botId}: PlainTransport FFmpeg started with PERFECT RTCP sync`);
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
      logger.debug(`⚠️ ViewBot ${this.botId}: GStreamer already starting/running - skipping duplicate call`);
      logger.debug(`   Starting: ${this.gstreamerStarting}, Video PID: ${this.gstreamerVideoProcess?.pid}, Audio PID: ${this.gstreamerAudioProcess?.pid}`);
      return;
    }
    this.gstreamerStarting = true;
    
    logger.debug(`🎬 ViewBot ${this.botId}: Starting GStreamer-based video file streaming (ENHANCED)`);
    logger.debug(`📂 Video file: ${this.config.videoFile}`);
    logger.debug(`🔍 STACK TRACE:`, new Error().stack.split('\n').slice(1, 5).join('\n'));
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    logger.debug(`📐 Resolution: ${width}x${height} @ ${frameRate}fps`);
    
    // Check file exists first
    if (!fs.existsSync(this.config.videoFile)) {
      logger.error(`❌ ViewBot ${this.botId}: Video file not found: ${this.config.videoFile}`);
      throw new Error(`Video file not found: ${this.config.videoFile}`);
    }
    
    // Get file info
    const stats = fs.statSync(this.config.videoFile);
    logger.debug(`📊 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Get video duration using ffprobe for fallback timer
    await this.getVideoDuration(this.config.videoFile);
    
    // Generate fixed SSRCs that will be used by both GStreamer and MediaSoup
    const videoSSRC = 11111111;
    const audioSSRC = 22222222;
    
    logger.debug(`🔑 Using SSRCs - Video: ${videoSSRC}, Audio: ${audioSSRC}`);
    
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
    logger.debug(`📡 ViewBot ${this.botId}: Creating MediaSoup PlainTransport producers...`);
    logger.debug(`   Step 1: Creating video producer...`);
    
    // Store SSRCs for use in GStreamer
    this.videoSSRC = videoSSRC;
    this.audioSSRC = audioSSRC;
    
    try {
      await this.createWebRTCProducer('video', videoRtpParams);
      logger.debug(`   ✅ Video producer created`);
    } catch (err) {
      logger.error(`   ❌ Failed to create video producer:`, err.message);
      throw err;
    }
    
    try {
      logger.debug(`   Step 2: Creating audio producer...`);
      await this.createWebRTCProducer('audio', audioRtpParams);
      logger.debug(`   ✅ Audio producer created`);
    } catch (err) {
      logger.error(`   ❌ Failed to create audio producer:`, err.message);
      throw err;
    }
    
    // Wait for transports to be ready
    logger.debug(`⏳ Waiting for transports to be ready...`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to get RTP ports from server`);
      logger.error(`   Video port: ${this.videoRtpPort}, Audio port: ${this.audioRtpPort}`);
      throw new Error('Failed to get RTP ports from server');
    }
    
    logger.debug(`✅ ViewBot ${this.botId}: MediaSoup PlainTransport ready`);
    logger.debug(`   Video: RTP port ${this.videoRtpPort}, SSRC ${videoSSRC}`);
    logger.debug(`   Audio: RTP port ${this.audioRtpPort}, SSRC ${audioSSRC}`);
    
    try {
      // IMPORTANT: Use forward slashes for Windows paths in GStreamer
      const videoFile = this.config.videoFile.replace(/\\/g, '/');
      logger.debug(`📁 Converted path for GStreamer: ${videoFile}`);
      
      // Start separate pipelines without rtpbin
      logger.debug(`🚀 Starting GStreamer pipelines...`);
      await this.startDirectRTPPipelines(videoFile, width, height, frameRate);
      
      // Mark as using GStreamer
      this.useGStreamer = true;
      
      logger.debug(`✅ ViewBot ${this.botId}: GStreamer streaming started successfully`);
      
      // Clear the starting flag
      this.gstreamerStarting = false;
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: GStreamer launch failed:`, error.message);
      logger.error(`   Full error:`, error);
      
      // Clear the starting flag
      this.gstreamerStarting = false;
      
      // Clean up any started processes
      this.cleanupGStreamerProcesses();
      
      // Fallback to FFmpeg if GStreamer fails
      logger.debug(`⚠️ ViewBot ${this.botId}: Falling back to FFmpeg method`);
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
    
    logger.debug(`🎥 ViewBot ${this.botId}: Starting video pipeline (no rtpbin)`);
    logger.debug(`🎥 ViewBot ${this.botId}: GStreamer path: ${gstreamerPath}`);
    logger.debug(`🎥 ViewBot ${this.botId}: Video file: ${videoFile}`);
    logger.debug(`🎥 ViewBot ${this.botId}: Pipeline args count: ${videoPipeline.length}`);
    
    // Debug: Log the actual command being run
    logger.debug(`🎥 ViewBot ${this.botId}: Full command: ${gstreamerPath} ${videoPipeline.join(' ')}`);
    
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
      logger.error(`❌ ViewBot ${this.botId}: Failed to spawn video process`);
      throw new Error('Failed to spawn GStreamer video process');
    }
    
    logger.debug(`🎥 ViewBot ${this.botId}: Video process started, PID: ${this.gstreamerVideoProcess.pid}`);
    
    // Register with ProcessManager
    processManager.registerProcess(this.botId, 'video', this.gstreamerVideoProcess.pid);
    
    logger.debug(`🔊 ViewBot ${this.botId}: Starting audio pipeline (no rtpbin)`);
    
    // Only use shell: true on Windows, it breaks argument parsing on Linux
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      shell: isWindows,  // Only required for Windows
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows  // CRITICAL: Create new process group on Linux for proper cleanup
    });
    
    // Check if process started
    if (!this.gstreamerAudioProcess || !this.gstreamerAudioProcess.pid) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to spawn audio process`);
      throw new Error('Failed to spawn GStreamer audio process');
    }
    
    // Register with ProcessManager
    processManager.registerProcess(this.botId, 'audio', this.gstreamerAudioProcess.pid);
    
    logger.debug(`🔊 ViewBot ${this.botId}: Audio process started, PID: ${this.gstreamerAudioProcess.pid}`);
    
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
        logger.debug(`📹 ViewBot ${this.botId}: Video stderr: ${output.substring(0, 200)}`);
      }
      
      if (output.includes('ERROR')) {
        videoError = output.substring(0, 200);
        logger.error(`❌ ViewBot ${this.botId}: Video pipeline error`);
        logger.error(output);
      } else if (output.includes('PLAYING') || output.includes('Setting pipeline to PLAYING')) {
        if (!videoStarted) {
          videoStarted = true;
          logger.debug(`▶️ ViewBot ${this.botId}: Video pipeline playing`);
        }
      } else if (output.includes('EOS') || output.includes('end-of-stream') || 
                 output.includes('Got EOS from element') || output.includes('Posting EOS') ||
                 output.includes('EOS received') || output.includes('Execution ended')) {
        if (!videoEOS) {
          videoEOS = true;
          logger.debug(`🏁 ViewBot ${this.botId}: Video EOS detected - cleaning up first!`);
          logger.debug(`   EOS Message: ${output.substring(0, 100)}`);
          
          // First cleanup the processes to ensure resources are freed
          logger.debug(`🧹 ViewBot ${this.botId}: Cleaning up GStreamer processes immediately`);
          this.cleanupGStreamerProcesses();
          
          // Then trigger video end handling after cleanup to avoid conflicts
          setTimeout(() => {
            if (!this.stopping && !this.handlingVideoEnd) {
              logger.debug(`🔄 ViewBot ${this.botId}: Triggering rotation after cleanup`);
              this.handleVideoEnd();
            }
          }, 200); // Small delay to ensure cleanup completes
        }
      } else if (output.includes('Setting pipeline to NULL')) {
        logger.debug(`🔧 ViewBot ${this.botId}: Video pipeline shutting down`);
      } else if (output.includes('Setting pipeline')) {
        logger.debug(`🔧 ViewBot ${this.botId}: Video pipeline state change`);
      } else if (output.includes('caps = video/')) {
        logger.debug(`📹 ViewBot ${this.botId}: Video stream detected`);
      } else if (output.includes('Freeing pipeline')) {
        logger.debug(`🧹 ViewBot ${this.botId}: Video pipeline freed`);
      }
    });
    
    // Also monitor stdout (GStreamer may output to stdout instead of stderr)
    this.gstreamerVideoProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Log for debugging
      if (!videoStarted) {
        logger.debug(`📹 ViewBot ${this.botId}: Video stdout: ${output.substring(0, 200)}`);
      }
      
      if (output.includes('Setting pipeline') || output.includes('PLAYING')) {
        logger.debug(`🔧 ViewBot ${this.botId}: Video pipeline state: ${output.trim()}`);
        if (!videoStarted && (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED'))) {
          videoStarted = true;
          logger.debug(`▶️ ViewBot ${this.botId}: Video pipeline playing (from stdout)`);
        }
      }
    });
    
    // Monitor audio pipeline stderr for state changes and errors
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        audioError = output.substring(0, 200);
        logger.error(`❌ ViewBot ${this.botId}: Audio pipeline error`);
        logger.error(output);
      } else if (output.includes('PLAYING') || output.includes('Setting pipeline to PLAYING')) {
        if (!audioStarted) {
          audioStarted = true;
          logger.debug(`▶️ ViewBot ${this.botId}: Audio pipeline playing`);
        }
      } else if (output.includes('EOS')) {
        audioEOS = true;
        logger.debug(`🏁 ViewBot ${this.botId}: Audio EOS received - complete playback!`);
      } else if (output.includes('caps = audio/')) {
        logger.debug(`🔊 ViewBot ${this.botId}: Audio stream detected`);
      }
    });
    
    // Also monitor stdout (GStreamer may output to stdout instead of stderr)
    this.gstreamerAudioProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Log for debugging
      if (!audioStarted) {
        logger.debug(`🔊 ViewBot ${this.botId}: Audio stdout: ${output.substring(0, 200)}`);
      }
      
      if (output.includes('Setting pipeline') || output.includes('PLAYING')) {
        logger.debug(`🔧 ViewBot ${this.botId}: Audio pipeline state: ${output.trim()}`);
        if (!audioStarted && (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED'))) {
          audioStarted = true;
          logger.debug(`▶️ ViewBot ${this.botId}: Audio pipeline playing (from stdout)`);
        }
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start video pipeline:`, error);
      throw error;
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start audio pipeline:`, error);
      // Audio failure is not critical, continue
    });
    
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      logger.debug(`🛑 ViewBot ${this.botId}: Video pipeline exited (code: ${code})`);
      
      if (videoEOS) {
        logger.debug(`   ✅ Video played to completion`);
      } else if (code === 0) {
        logger.debug(`   ✅ Video pipeline completed normally`);
      } else if (videoError) {
        logger.error(`   ❌ Video error: ${videoError}`);
      }
      
      this.gstreamerVideoProcess = null;
      
      // Handle video end - trigger rotation after ensuring cleanup
      if (!this.stopping && !this.handlingVideoEnd && (videoEOS || code === 0)) {
        logger.debug(`🎬 ViewBot ${this.botId}: Video file reached end (GStreamer EOS: ${videoEOS}, Exit code: ${code})`);
        // Ensure cleanup then trigger rotation
        setTimeout(() => {
          if (!this.stopping && !this.handlingVideoEnd) {
            this.handleVideoEnd();
          }
        }, 500); // Small delay to ensure process cleanup
      }
    });
    
    this.gstreamerAudioProcess.on('exit', (code, signal) => {
      logger.debug(`🛑 ViewBot ${this.botId}: Audio pipeline exited (code: ${code})`);
      
      if (audioEOS) {
        logger.debug(`   ✅ Audio played to completion`);
      } else if (code === 0) {
        logger.debug(`   ✅ Audio pipeline completed normally`);
      } else if (audioError) {
        logger.error(`   ❌ Audio error: ${audioError}`);
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
          logger.debug(`⚠️ ViewBot ${this.botId}: Processes running without PLAYING confirmation (Video PID: ${this.gstreamerVideoProcess?.pid}, Audio PID: ${this.gstreamerAudioProcess?.pid})`);
          videoStarted = videoStarted || videoRunning;
          audioStarted = audioStarted || audioRunning;
          resolve();
        } else if (!videoStarted && !audioStarted) {
          const error = new Error('GStreamer pipelines failed to start');
          logger.error(`❌ ViewBot ${this.botId}: ${error.message}`);
          
          if (videoError) {
            logger.error(`   Video error: ${videoError}`);
          }
          if (audioError) {
            logger.error(`   Audio error: ${audioError}`);
          }
          
          this.cleanupGStreamerProcesses();
          reject(error);
        } else {
          logger.debug(`⚠️ ViewBot ${this.botId}: Partial start (Video: ${videoStarted}, Audio: ${audioStarted})`);
          resolve();
        }
      }, 15000);
      
      const checkInterval = setInterval(() => {
        if (videoStarted || audioStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          logger.debug(`✅ ViewBot ${this.botId}: Pipelines started (Video: ${videoStarted}, Audio: ${audioStarted})`);
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
        
        logger.debug(`⏰ ViewBot ${this.botId}: Video duration is ${durationSeconds}s, setting failsafe rotation timer for ${rotationDelay}ms`);
        
        this.videoDurationTimer = setTimeout(() => {
          logger.debug(`⚠️ ViewBot ${this.botId}: Duration-based failsafe triggered - video should have ended by now`);
          if (!this.handlingVideoEnd && this.streaming) {
            logger.debug(`🆘 ViewBot ${this.botId}: EOS not detected, forcing cleanup then rotation`);
            
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
        logger.warn(`⚠️ ViewBot ${this.botId}: Could not determine video duration for failsafe`);
      }
    } catch (error) {
      logger.warn(`⚠️ ViewBot ${this.botId}: Failed to set up duration-based rotation:`, error.message);
    }
  }
  
  cleanupGStreamerProcesses() {
    logger.debug(`🧹🧹🧹 CLEANUP CALLED - ViewBot ${this.botId}: Cleaning up GStreamer processes...`);
    logger.debug(`   📊 Current process references:`, {
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
        logger.debug(`   💀💀💀 KILLING ${name} process group (PID: ${pid})`);
        
        try {
          // CRITICAL: Use negative PID to kill entire process group on Linux
          // This ensures all child processes spawned by GStreamer are killed
          if (process.platform !== 'win32') {
            // On Linux, kill the entire process group
            const { execSync } = require('child_process');
            try {
              // Use pkill to kill all processes in the process group
              logger.debug(`   🔫 Executing: kill -9 -${pid} (kill process group)`);
              execSync(`kill -9 -${pid}`, { stdio: 'ignore' });
              logger.debug(`   ✅✅✅ ${name} process group KILLED (PID: -${pid})`);
            } catch (killError) {
              // If group kill fails, try to kill the single process
              logger.debug(`   ⚠️ Group kill failed, trying single process kill`);
              try {
                proc.kill('SIGKILL');
                logger.debug(`   ✅ ${name} single process killed (PID: ${pid})`);
              } catch (e) {
                logger.debug(`   ❌ Failed to kill ${name}: ${e.message}`);
              }
            }
          } else {
            // On Windows, just kill the process normally
            proc.kill('SIGKILL');
            logger.debug(`   ✅ ${name} process killed (PID: ${pid})`);
          }
        } catch (error) {
          // Process might already be dead
          if (error.code !== 'ESRCH') {
            logger.debug(`   ❌❌❌ ERROR killing ${name}: ${error.message}`);
          } else {
            logger.debug(`   ⚠️ ${name} process already dead (ESRCH)`);
          }
        }
      } else {
        logger.debug(`   ⚠️⚠️⚠️ No ${name} process reference to kill!`);
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
    logger.debug(`   🧹 Process references and flags cleared`);
    
    logger.debug(`   ✅ Cleanup completed - all processes killed`);
  }
  
  /**
   * Start health monitoring for GStreamer pipelines
   * Checks pipeline status every 5 seconds and recovers if needed
   */
  startPipelineHealthCheck() {
    if (this.pipelineHealthCheckTimer) {
      clearInterval(this.pipelineHealthCheckTimer);
    }
    
    logger.debug(`🏥 ViewBot ${this.botId}: Starting pipeline health monitoring`);
    
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
      logger.error(`💀 ViewBot ${this.botId}: Both pipelines are dead!`);
      this.handlePipelineCrash('both');
    } else if (!videoAlive) {
      logger.error(`💀 ViewBot ${this.botId}: Video pipeline is dead (PID ${videoPid})`);
      this.handlePipelineCrash('video');
    } else if (!audioAlive) {
      logger.error(`💀 ViewBot ${this.botId}: Audio pipeline is dead (PID ${audioPid})`);
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
      logger.warn(`⚠️ ViewBot ${this.botId}: No pipeline activity for ${timeDiff/1000}s`);
      
      // Check if we should recover
      if (timeDiff > 15000) {
        logger.error(`🔄 ViewBot ${this.botId}: Pipelines appear stuck, recovering...`);
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
      logger.debug(`🔄 ViewBot ${this.botId}: Recovery blocked (recovering=${this.recovering}, stopping=${this.stopping})`);
      return;
    }
    
    // Rate limit recovery attempts
    const now = Date.now();
    const timeSinceLastRecovery = now - (this.pipelineHealth?.lastRecovery || 0);
    if (timeSinceLastRecovery < 5000) {
      logger.debug(`⏳ ViewBot ${this.botId}: Delaying recovery (only ${timeSinceLastRecovery}ms since last)`);
      return;
    }
    
    this.recovering = true;
    this.recoveryAttempts = (this.recoveryAttempts || 0) + 1;
    
    if (this.pipelineHealth) {
      this.pipelineHealth.lastRecovery = now;
    }
    
    logger.debug(`🚨 ViewBot ${this.botId}: Pipeline crash detected (${type}), attempt ${this.recoveryAttempts}/3`);
    
    // If too many recovery attempts or consecutive failures, rotate to next video
    if (this.recoveryAttempts > 3 || (this.pipelineHealth?.consecutiveFailures > 5)) {
      logger.error(`❌ ViewBot ${this.botId}: Too many failures, forcing rotation`);
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
      logger.debug(`🛑 ViewBot ${this.botId}: Force stopping all pipelines...`);
      await this.killAllProcesses();
      
      // Wait for processes to die
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Clean up resources
      logger.debug(`🧹 ViewBot ${this.botId}: Cleaning up resources...`);
      this.cleanupGStreamerProcesses();
      
      // Check if we should still recover
      if (this.stopping || this.handlingVideoEnd) {
        logger.debug(`🚫 ViewBot ${this.botId}: Aborting recovery - bot is stopping`);
        this.recovering = false;
        return;
      }
      
      // Restart pipelines with exponential backoff
      const backoffDelay = Math.min(1000 * Math.pow(1.5, this.recoveryAttempts - 1), 10000);
      logger.debug(`⏰ ViewBot ${this.botId}: Waiting ${backoffDelay/1000}s before restart...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
      
      logger.debug(`🔄 ViewBot ${this.botId}: Restarting pipelines...`);
      
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
        
        logger.debug(`✅ ViewBot ${this.botId}: Pipeline recovery successful`);
      }
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Pipeline recovery failed:`, error.message);
      
      // Exponential backoff for retries
      const retryDelay = Math.min(3000 * Math.pow(2, this.recoveryAttempts - 1), 30000);
      logger.debug(`⏰ ViewBot ${this.botId}: Retrying recovery in ${retryDelay/1000}s`);
      
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
          logger.debug(`💀 Killing ${name} process (PID: ${proc.pid})`);
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
    logger.debug(`📹 ViewBot ${this.botId}: Starting FFmpeg video generation...`);
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    const pattern = this.config.testPattern || this.config.contentType || 'color-bars';
    
    // Create RTP parameters for video FIRST
    const rtpParameters = this.createVideoRtpParameters();
    
    // Create MediaSoup plain transport and producer BEFORE starting FFmpeg
    logger.debug(`📡 ViewBot ${this.botId}: Creating MediaSoup video producer first...`);
    await this.createWebRTCProducer('video', rtpParameters);
    
    // Wait a moment for the transport to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if port was allocated
    if (!this.videoRtpPort) {
      throw new Error('Failed to get RTP port from server for video');
    }
    
    // Now start FFmpeg to send RTP data to the waiting transport
    const ffmpegArgs = this.createVideoFFmpegArgs(width, height, frameRate, pattern);
    
    logger.debug(`🎬 ViewBot ${this.botId}: Starting FFmpeg video process...`);
    logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg will send video RTP to port ${this.videoRtpPort}`);
    logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg video args:`, ffmpegArgs.join(' '));
    
    // Start FFmpeg process
    try {
      this.videoFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      this.videoFFmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('frame=')) {
          // FFmpeg is running
        }
      });
      
      this.videoFFmpeg.on('error', (error) => {
        logger.error(`❌ ViewBot ${this.botId}: FFmpeg video error:`, error);
        throw error;
      });
      
      this.videoFFmpeg.on('close', (code) => {
        logger.debug(`🛑 ViewBot ${this.botId}: FFmpeg video process exited with code ${code}`);
        this.videoFFmpeg = null;
      });
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start FFmpeg video:`, error);
      throw error;
    }
    
    logger.debug(`✅ ViewBot ${this.botId}: FFmpeg video generation started on port ${this.videoRtpPort}`);
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
    
    logger.debug(`🔊 ViewBot ${this.botId}: Starting GStreamer audio pipeline on port ${this.audioRtpPort}`);
    
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'  // CRITICAL: Create new process group on Linux for proper cleanup
    });
    
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        logger.error(`❌ ViewBot ${this.botId}: GStreamer audio error:`, output);
      } else if (output.includes('PLAYING')) {
        logger.debug(`▶️ ViewBot ${this.botId}: GStreamer audio pipeline playing`);
      }
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start GStreamer audio:`, error);
      // Audio failure is not critical
      logger.warn(`⚠️ ViewBot ${this.botId}: Continuing without audio`);
    });
    
    // Wait for pipeline to start (don't fail if audio doesn't work)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(`⚠️ ViewBot ${this.botId}: Audio pipeline timeout, continuing`);
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
    logger.debug(`📹 ViewBot ${this.botId}: Starting FFmpeg video generation...`);
    
    const width = this.config.width || 1280;
    const height = this.config.height || 720;
    const frameRate = this.config.frameRate || 30;
    const pattern = this.config.testPattern || this.config.contentType || 'color-bars';
    
    // Create RTP parameters for video FIRST
    const rtpParameters = this.createVideoRtpParameters();
    
    // Create MediaSoup plain transport and producer BEFORE starting FFmpeg
    logger.debug(`📡 ViewBot ${this.botId}: Creating MediaSoup video producer first...`);
    await this.createWebRTCProducer('video', rtpParameters);
    
    // Wait a moment for the transport to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if port was allocated
    if (!this.videoRtpPort) {
      throw new Error('Failed to get RTP port from server for video');
    }
    
    // Now start FFmpeg to send RTP data to the waiting transport
    const ffmpegArgs = this.createVideoFFmpegArgs(width, height, frameRate, pattern);
    
    logger.debug(`🎬 ViewBot ${this.botId}: Starting FFmpeg video process...`);
    logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg will send video RTP to port ${this.videoRtpPort}`);
    logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg video args:`, ffmpegArgs.join(' '));
    
    // Start FFmpeg process
    try {
      logger.debug(`🎬 ViewBot ${this.botId}: Spawning FFmpeg video process...`);
      this.videoFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      
      logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg video process PID: ${this.videoFFmpeg.pid}`);
      
      // Set up FFmpeg event handlers
      this.setupFFmpegHandlers(this.videoFFmpeg, 'video');
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.error(`❌ ViewBot ${this.botId}: FFmpeg not found. Please install FFmpeg to enable ViewBot streaming.`);
        logger.error(`📋 ViewBot ${this.botId}: Installation instructions:`);
        logger.error(`   Windows: Download from https://ffmpeg.org/download.html and add to PATH`);
        logger.error(`   Or run: winget install ffmpeg`);
        logger.error(`   Or use Chocolatey: choco install ffmpeg`);
        throw new Error('FFmpeg not installed. ViewBot requires FFmpeg for media generation.');
      }
      throw error;
    }
    
    logger.debug(`✅ ViewBot ${this.botId}: FFmpeg video generation started on port ${this.videoRtpPort}`);
  }

  /**
   * Starts FFmpeg audio generation and creates MediaSoup audio producer
   */
  async startFFmpegAudioGeneration() {
    logger.debug(`🎤 ViewBot ${this.botId}: Starting FFmpeg audio generation...`);
    
    // Create RTP parameters for audio FIRST
    const rtpParameters = this.createAudioRtpParameters();
    
    // Create MediaSoup plain transport and producer BEFORE starting FFmpeg
    logger.debug(`📡 ViewBot ${this.botId}: Creating MediaSoup audio producer first...`);
    await this.createWebRTCProducer('audio', rtpParameters);
    
    // Wait a moment for the transport to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if port was allocated
    if (!this.audioRtpPort) {
      throw new Error('Failed to get RTP port from server for audio');
    }
    
    // Now start FFmpeg to send RTP data to the waiting transport
    const ffmpegArgs = this.createAudioFFmpegArgs();
    
    logger.debug(`🎬 ViewBot ${this.botId}: Starting FFmpeg audio process...`);
    logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg will send audio RTP to port ${this.audioRtpPort}`);
    logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg audio args:`, ffmpegArgs.join(' '));
    
    // Start FFmpeg process
    try {
      this.audioFFmpeg = spawn(this.parentService?.ffmpegPath || 'ffmpeg', ffmpegArgs);
      
      // Set up FFmpeg event handlers
      this.setupFFmpegHandlers(this.audioFFmpeg, 'audio');
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.error(`❌ ViewBot ${this.botId}: FFmpeg not found for audio generation.`);
        throw new Error('FFmpeg not installed. ViewBot requires FFmpeg for media generation.');
      }
      throw error;
    }
    
    logger.debug(`✅ ViewBot ${this.botId}: FFmpeg audio generation started on port ${this.audioRtpPort}`);
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
      logger.debug(`🎬 ViewBot ${this.botId}: Using video file input: ${this.config.videoFile}`);
      logger.debug(`🎬 ViewBot ${this.botId}: ContentType is: "${this.config.contentType}"`);
      logger.debug(`🎬 ViewBot ${this.botId}: Video file path: "${this.config.videoFile}"`);
      
      // Check if file exists and is actually a file (not a directory)
      const path = require('path');
      
      if (!fs.existsSync(this.config.videoFile)) {
        logger.error(`❌ ViewBot ${this.botId}: Video file does not exist: ${this.config.videoFile}`);
        throw new Error(`Video file not found: ${this.config.videoFile}`);
      }
      
      const stats = fs.statSync(this.config.videoFile);
      if (stats.isDirectory()) {
        logger.error(`❌ ViewBot ${this.botId}: Path is a directory, not a file: ${this.config.videoFile}`);
        throw new Error(`Path is a directory, not a video file: ${this.config.videoFile}`);
      }
      
      // Check if file has a video extension
      const ext = path.extname(this.config.videoFile).toLowerCase();
      const validExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv', '.ts'];
      if (!validExtensions.includes(ext)) {
        logger.warn(`⚠️ ViewBot ${this.botId}: File does not have a recognized video extension: ${ext}`);
        logger.warn(`⚠️ ViewBot ${this.botId}: Supported extensions: ${validExtensions.join(', ')}`);
        logger.warn(`⚠️ ViewBot ${this.botId}: Attempting to process anyway...`);
      }
      
      logger.debug(`✅ ViewBot ${this.botId}: Video file exists and will be used for streaming`);
      
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
    
    logger.debug(`🎬 ViewBot ${this.botId}: Video FFmpeg command: ffmpeg ${args.join(' ')}`);
    
    // Debug the actual input configuration
    logger.debug(`🔍 ViewBot ${this.botId}: Video config debug:`);
    logger.debug(`  - contentType: "${this.config.contentType}"`);
    logger.debug(`  - videoFile: "${this.config.videoFile}"`);
    logger.debug(`  - using video file input: ${this.config.contentType === 'videoFile' && this.config.videoFile}`);
    logger.debug(`  - input args: [${inputArgs.join(', ')}]`);
    logger.debug(`  - target RTP port: ${this.videoRtpPort}`);
    
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
    
    logger.debug(`🎬 ViewBot ${this.botId}: Using H.264 codec for video`);
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
      logger.debug(`🎤 ViewBot ${this.botId}: Extracting audio from video file: ${this.config.videoFile}`);
      logger.debug(`🎤 ViewBot ${this.botId}: ContentType is: "${this.config.contentType}"`);
      logger.debug(`🎤 ViewBot ${this.botId}: Video file path: "${this.config.videoFile}"`);
      
      // Check if file exists and is actually a file (not a directory)
      const path = require('path');
      
      if (!fs.existsSync(this.config.videoFile)) {
        logger.error(`❌ ViewBot ${this.botId}: Video file does not exist: ${this.config.videoFile}`);
        throw new Error(`Video file not found: ${this.config.videoFile}`);
      }
      
      const stats = fs.statSync(this.config.videoFile);
      if (stats.isDirectory()) {
        logger.error(`❌ ViewBot ${this.botId}: Path is a directory, not a file: ${this.config.videoFile}`);
        throw new Error(`Path is a directory, not a video file: ${this.config.videoFile}`);
      }
      
      logger.debug(`✅ ViewBot ${this.botId}: Video file exists, audio will be extracted`);
      
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
    
    logger.debug(`🎤 ViewBot ${this.botId}: Audio FFmpeg command: ffmpeg ${args.join(' ')}`);
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
      logger.error(`❌ ViewBot ${this.botId}: FFmpeg ${kind} error:`, error);
      this.lastError = `FFmpeg ${kind} error: ${error.message}`;
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        logger.error(`❌ ViewBot ${this.botId}: FFmpeg ${kind} stderr:`, output);
      } else if (output.includes('frame=')) {
        // Occasionally log frame info for video
        if (kind === 'video' && Math.random() < 0.01) {
          logger.debug(`🎬 ViewBot ${this.botId}: FFmpeg video progress:`, output.trim().split('\n').pop());
        }
      }
    });

    ffmpegProcess.on('close', (code) => {
      logger.debug(`🛑 ViewBot ${this.botId}: FFmpeg ${kind} process exited with code ${code}`);
      
      // Handle video end when FFmpeg exits normally for video files
      if (kind === 'video' && code === 0 && this.config.contentType === 'videoFile' && this.streaming && !this.handlingVideoEnd) {
        logger.debug(`🎬 ViewBot ${this.botId}: Video file reached end (FFmpeg ${kind} exit)`);
        this.handleVideoEnd();
      }
    });
  }

  /**
   * Creates MediaSoup plain RTP transport and producer for FFmpeg RTP stream
   */
  async createWebRTCProducer(kind, rtpParameters) {
    logger.debug(`📡 ViewBot ${this.botId}: Creating plain RTP transport for ${kind}...`);
    
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
          logger.debug(`✅ ViewBot ${this.botId}: Plain RTP ${kind} producer created:`, data.producerId);
          logger.debug(`📡 ViewBot ${this.botId}: Server allocated port ${data.rtpPort} for ${kind} RTP`);
          
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
          logger.error(`❌ ViewBot ${this.botId}: Plain RTP ${kind} producer creation failed:`, data.error);
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
    logger.debug(`🤝 ViewBot ${this.botId}: Handling stream request from viewer ${viewerId}`);
    
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
    
    logger.debug(`📤 ViewBot ${this.botId}: Sent ViewBot offer to viewer ${viewerId}`);
  }

  /**
   * Initializes media generation based on configuration
   */
  async initializeMediaGeneration() {
    logger.debug(`🎬 ViewBot ${this.botId}: Initializing media generation (${this.config.contentType})`);
    
    switch (this.config.contentType) {
      case 'testPattern':
        await this.initializeTestPatternGeneration();
        break;
      case 'customText':
        await this.initializeTestPatternGeneration(); // Use same canvas system as test patterns
        break;
      case 'videoFile':
        // NEW: Skip old video file streaming - use RTP streaming instead
        logger.debug(`📹 ViewBot ${this.botId}: Video file streaming handled by RTP system, skipping old method`);
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
    logger.debug(`🎨 ViewBot ${this.botId}: Setting up test pattern generation`);
    
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
    
    logger.debug(`✅ ViewBot ${this.botId}: Test pattern generation ready`);
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
    
    logger.debug(`🎬 ViewBot ${this.botId}: Setting up video file streaming from ${this.config.videoFile}`);
    
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
      logger.error(`❌ ViewBot ${this.botId}: FFmpeg error:`, error);
      this.lastError = `FFmpeg error: ${error.message}`;
    });
    
    this.ffmpegProcess.stderr.on('data', (data) => {
      // Log FFmpeg output for debugging
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        logger.error(`❌ ViewBot ${this.botId}: FFmpeg stderr:`, output);
      }
    });
    
    logger.debug(`✅ ViewBot ${this.botId}: Video file streaming initialized`);
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
    logger.debug(`🎬 ViewBot ${this.botId}: Starting streaming process...`);
    
    if (this.streaming) {
      logger.debug(`⚠️ ViewBot ${this.botId}: Already streaming, aborting start`);
      return { success: false, message: 'Already streaming' };
    }
    
    // CRITICAL: Check if another bot is already streaming
    const parentService = this.getParentService();
    if (parentService && parentService.currentLiveBot && parentService.currentLiveBot !== this.botId) {
      logger.debug(`❌❌❌ ViewBot ${this.botId}: BLOCKED - Another bot is already streaming: ${parentService.currentLiveBot}`);
      return { success: false, message: `Another bot is already streaming: ${parentService.currentLiveBot}` };
    }
    
    // Set flag to indicate we're starting
    this.isStartingStream = true;

    if (!this.isConnected) {
      logger.debug(`❌ ViewBot ${this.botId}: Not connected to server, cannot start streaming`);
      logger.debug(`💡 ViewBot ${this.botId}: Socket connection status: ${this.socket ? 'exists' : 'missing'}`);
      this.isStartingStream = false;
      return { success: false, message: 'Not connected to server' };
    }
    
    logger.debug(`✅ ViewBot ${this.botId}: Pre-flight checks passed, proceeding with stream start`);
    
    // CRITICAL: Reset the handlingVideoEnd flag when starting a new stream
    // This ensures the bot can properly handle the next video end
    this.handlingVideoEnd = false;
    
    // SAFETY CHECK: Double-check real streamer protection before attempting to stream
    if (this.parentService && this.parentService.realStreamerActive) {
      logger.debug(`🚫 ViewBot ${this.botId}: Cannot start - real streamer is active (safety check)`);
      this.isStartingStream = false; // Clear the flag
      return { success: false, message: 'Real streamer is active - ViewBot cannot start' };
    }

    try {
      logger.debug(`🎬 ViewBot ${this.botId}: Starting stream (${this.config.contentType})...`);
      
      // Initialize media generation for content types that need it
      if (this.config.contentType === 'testPattern' || this.config.contentType === 'customText') {
        logger.debug(`🎨 ViewBot ${this.botId}: Initializing media generation for ${this.config.contentType}`);
        await this.initializeMediaGeneration();
      } else {
        logger.debug(`🎬 ViewBot ${this.botId}: Skipping media generation for ${this.config.contentType}, using synthetic producers`);
      }
      
      // IMPORTANT: Use the same event flow as real users to trigger takeover logic
      // This will go through the takeover service and properly notify viewers
      if (this.socket) {
        // Log socket state before emitting
        logger.debug(`📡 ViewBot ${this.botId}: Socket state before request-to-stream:`);
        logger.debug(`   - Socket ID: ${this.socket.id}`);
        logger.debug(`   - Connected: ${this.socket.connected}`);
        logger.debug(`   - Transport: ${this.socket.io?.engine?.transport?.name || 'unknown'}`);
        
        // Add a small delay to ensure socket is fully ready
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Double-check connection before emitting
        if (!this.socket.connected) {
          logger.error(`❌ ViewBot ${this.botId}: Socket not connected, cannot request streaming`);
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
        
        logger.debug(`📨 ViewBot ${this.botId}: Emitting request-to-stream from socket ${this.socket.id}`);
        logger.debug(`📨 ViewBot ${this.botId}: Request data:`, JSON.stringify(requestData));
        
        this.socket.emit('request-to-stream', requestData, (ack) => {
          if (ack) {
            logger.debug(`✅ ViewBot ${this.botId}: Server acknowledged request-to-stream`);
          }
        });
        
        logger.debug(`📨 ViewBot ${this.botId}: Emitted request-to-stream, waiting for server approval...`);
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
            logger.debug(`💾 ViewBot ${this.botId}: Started database session ${this.currentSessionId}`);
          }
        } catch (dbError) {
          logger.error(`⚠️ ViewBot ${this.botId}: Failed to start database session:`, dbError);
        }
      }
      
      // Wait for streaming approval with timeout
      const approvalTimeout = setTimeout(() => {
        if (!this.streaming) {
          logger.error(`⏰ ViewBot ${this.botId}: Timeout waiting for streaming-approved after 5 seconds`);
          logger.error(`📡 ViewBot ${this.botId}: Socket state at timeout:`);
          logger.error(`   - Socket ID: ${this.socket?.id}`);
          logger.error(`   - Connected: ${this.socket?.connected}`);
          this.lastError = 'Timeout waiting for streaming approval';
        }
      }, 5000);
      
      // Store timeout so we can clear it when approved
      this.approvalTimeout = approvalTimeout;
      
      logger.debug(`✅ ViewBot ${this.botId}: Streaming request sent via request-to-stream`);
      
      return {
        success: true,
        message: `ViewBot ${this.botId} requested streaming, waiting for approval`,
        streamId: this.botId,
        startTime: this.startTime
      };
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start streaming:`, error);
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
      logger.debug(`⏹️ ViewBot ${this.botId}: Stopping stream...`);
      
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
        logger.debug(`⏱️ ViewBot ${this.botId}: Cleared video end timer`);
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
          logger.debug(`💾 ViewBot ${this.botId}: Ended database session ${this.currentSessionId}`);
          this.currentSessionId = null;
          this.sessionStartTime = null;
        } catch (dbError) {
          logger.error(`⚠️ ViewBot ${this.botId}: Failed to end database session:`, dbError);
        }
      }
      
      // CRITICAL: Stop FFmpeg processes to actually stop broadcasting
      await this.cleanupMediaGeneration();
      
      // CRITICAL: Use ProcessManager for guaranteed cleanup
      await processManager.killBotProcesses(this.botId);
      
      // CRITICAL: Clear the GStreamer starting flag to allow next bot to start
      this.gstreamerStarting = false;
      
      logger.debug(`✅ ViewBot ${this.botId}: Streaming stopped (duration: ${duration}ms)`);
      
      return {
        success: true,
        message: `ViewBot ${this.botId} stopped streaming`,
        duration
      };
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to stop streaming:`, error);
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
          logger.debug(`⏱️ ViewBot ${this.botId}: Updated time allotment to ${newConfig.streamDuration} minutes`);
        } else {
          // If duration is 0, remove time allotment (infinite streaming)
          newConfig.timeAllotment = null;
          this.timeAllotment = this.generateRandomTimeAllotment(); // Use random time for rotation
          this.timeRemaining = this.timeAllotment;
          logger.debug(`⏱️ ViewBot ${this.botId}: Set to infinite streaming (using random rotation time)`);
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
      logger.error(`❌ ViewBot ${this.botId}: Failed to update config:`, error);
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
    logger.debug(`🧹 ViewBot ${this.botId}: Cleaning up media generation processes...`);
    
    // Clean up Puppeteer resources first (if they exist)
    if (this.page) {
      logger.debug(`🌐 ViewBot ${this.botId}: Closing Puppeteer page`);
      try {
        await this.page.close();
      } catch (error) {
        logger.warn(`⚠️ ViewBot ${this.botId}: Error closing page:`, error.message);
      }
      this.page = null;
    }
    
    if (this.browser) {
      logger.debug(`🌐 ViewBot ${this.botId}: Closing Puppeteer browser`);
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
        logger.warn(`⚠️ ViewBot ${this.botId}: Error closing browser:`, error.message);
        // Force kill the browser process if normal close failed
        try {
          if (this.browser.process() && !this.browser.process().killed) {
            this.browser.process().kill('SIGKILL');
          }
        } catch (killError) {
          logger.warn(`⚠️ ViewBot ${this.botId}: Could not force kill browser:`, killError.message);
        }
      }
      this.browser = null;
    }
    
    // Clean up GStreamer processes if they exist
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      logger.debug(`🛑 ViewBot ${this.botId}: Killing GStreamer video process`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      logger.debug(`🛑 ViewBot ${this.botId}: Killing GStreamer audio process`);
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
    
    // Original cleanup for single process with aggressive killing
    if (this.gstreamerProcess) {
      const pid = this.gstreamerProcess.pid;
      logger.debug(`🛑 ViewBot ${this.botId}: Killing GStreamer process (PID: ${pid})`);
      
      try {
        // First try SIGTERM
        this.gstreamerProcess.kill('SIGTERM');
        
        // Set timeout for SIGKILL if process doesn't die
        setTimeout(() => {
          if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
            logger.debug(`⚠️ ViewBot ${this.botId}: Force killing GStreamer with SIGKILL`);
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
        logger.debug(`⚠️ ViewBot ${this.botId}: Error killing GStreamer:`, error.message);
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
      logger.debug(`🛑 ViewBot ${this.botId}: Killing combined FFmpeg process`);
      this.combinedFFmpeg.kill('SIGTERM');
      this.combinedFFmpeg = null;
      this.videoFFmpeg = null;
      this.audioFFmpeg = null;
    } else {
      // Clean up video FFmpeg process
      if (this.videoFFmpeg && !this.videoFFmpeg.killed) {
        logger.debug(`🛑 ViewBot ${this.botId}: Killing video FFmpeg process`);
        this.videoFFmpeg.kill('SIGTERM');
        this.videoFFmpeg = null;
      }
      
      // Clean up audio FFmpeg process (only if it's different from video)
      if (this.audioFFmpeg && this.audioFFmpeg !== this.videoFFmpeg && !this.audioFFmpeg.killed) {
        logger.debug(`🛑 ViewBot ${this.botId}: Killing audio FFmpeg process`);
        this.audioFFmpeg.kill('SIGTERM');
        this.audioFFmpeg = null;
      }
    }
    
    // Clean up legacy FFmpeg process (for backward compatibility)
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      logger.debug(`🛑 ViewBot ${this.botId}: Killing legacy FFmpeg process`);
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
    
    logger.debug(`✅ ViewBot ${this.botId}: Media generation cleanup complete`);
  }

  /**
   * Destroys the bot and cleans up all resources
   */
  async destroy() {
    logger.debug(`🗑️ ViewBot ${this.botId}: Destroying bot...`);
    
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
      
      logger.debug(`✅ ViewBot ${this.botId}: Destroyed successfully`);
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Error during destruction:`, error);
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
        logger.error(`❌ ViewBot ${this.botId}: Video not found: ${videoPath}`);
        return;
      }
      
      logger.debug(`🎥 ViewBot ${this.botId}: Playing video: ${videoPath}`);
      
      // For now, just log that we're "playing" the video
      // The important part is that we're registered as a streamer
      this.videoPlaying = true;
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start video:`, error);
      this.lastError = error.message;
    }
  }
  
  /**
   * Notifies viewers that ViewBot stream is ready for consumption
   * This triggers the stream switching mechanism without page refresh
   */
  notifyViewersOfReadyStream() {
    if (!this.socket) {
      logger.error(`❌ ViewBot ${this.botId}: Cannot notify viewers - no socket connection`);
      return;
    }

    try {
      logger.debug(`📺 ViewBot ${this.botId}: Notifying viewers that stream is ready...`);
      
      // Emit a custom event to trigger stream switching
      if (this.socket) {
        this.socket.emit('viewbot-stream-ready', {
          botId: this.botId,
          streamType: 'viewbot',
          timestamp: Date.now()
        });
      }
      
      logger.debug(`✅ ViewBot ${this.botId}: Stream ready notification sent to server`);
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to notify viewers:`, error);
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
      logger.debug(`⏸️ ViewBot ${this.botId}: Rotation disabled - no checks will be performed`);
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
    
    logger.debug(`⏱️ ViewBot ${this.botId}: Next rotation check in ${interval/1000} seconds (using ${minInterval/1000}-${maxInterval/1000}s range)`);
    
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
      logger.debug(`🚫 ViewBot ${this.botId}: Rotation check skipped - conditions not met`);
      return;
    }
    
    // Get probability from parent service (which loads from config)
    const rotationProbability = parentService.rotationProbability || 0.31;
    
    // Roll the dice
    const roll = Math.random();
    logger.debug(`🎲 ViewBot ${this.botId}: Rotation check - rolled ${(roll * 100).toFixed(2)}% vs ${(rotationProbability * 100).toFixed(2)}% threshold`);
    
    if (roll < rotationProbability) {
      logger.debug(`✅ ViewBot ${this.botId}: Rotation triggered! Requesting rotation...`);
      this.requestRotation();
    } else {
      logger.debug(`⏭️ ViewBot ${this.botId}: No rotation this time, scheduling next check`);
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
      logger.debug(`⏹️ ViewBot ${this.botId}: Stopped rotation check timer`);
    }
  }
  
  /**
   * Updates the rotation probability
   */
  updateRotationProbability(probability) {
    // Bot now uses parent service values directly, just log the update
    const parentService = this.getParentService();
    if (parentService) {
      logger.debug(`🎲 ViewBot ${this.botId}: Parent service rotation probability updated to ${(parentService.rotationProbability * 100).toFixed(1)}%`);
    }
  }
  
  /**
   * Updates the rotation check interval
   */
  updateRotationInterval(minInterval, maxInterval) {
    // Bot now uses parent service values directly, restart timer with new intervals
    const parentService = this.getParentService();
    if (parentService) {
      logger.debug(`⏱️ ViewBot ${this.botId}: Parent service rotation interval updated to ${parentService.rotationCheckIntervalMin/1000}-${parentService.rotationCheckIntervalMax/1000} seconds`);
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
      logger.debug(`🚫 ViewBot ${this.botId}: Rotation request ignored - rotation system disabled, continuing to stream`);
      return;
    }
    
    // Use the queue system to prevent race conditions
    logger.debug(`🔄 ViewBot ${this.botId}: Probability check passed, queueing rotation request`);
    
    if (parentService && parentService.queueRotationRequest) {
      // Queue the rotation request instead of calling directly
      const result = parentService.queueRotationRequest(this.botId, 'probability-triggered');
      
      if (result.success) {
        logger.debug(`✅ ViewBot ${this.botId}: Rotation request queued successfully`);
      } else {
        logger.debug(`⚠️ ViewBot ${this.botId}: Rotation request rejected: ${result.message}`);
        // Schedule next check if request was rejected
        if (this.streaming) {
          this.scheduleNextRotationCheck();
        }
      }
    } else {
      logger.error(`❌ ViewBot ${this.botId}: Cannot queue rotation - parent service handler not available`);
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
          logger.debug(`⏱️ ViewBot ${this.botId}: Video duration: ${durationSeconds} seconds`);
          this.videoDuration = durationSeconds;
          
          // Set up a fallback timer for video end
          if (durationSeconds > 0 && !isNaN(durationSeconds)) {
            this.videoEndTimer = setTimeout(() => {
              logger.debug(`⏰ ViewBot ${this.botId}: Video duration timer expired, triggering rotation`);
              this.handleVideoEnd();
            }, (durationSeconds * 1000) + 2000); // Add 2 second buffer
          }
        } else {
          logger.warn(`⚠️ ViewBot ${this.botId}: Could not determine video duration`);
        }
        resolve();
      });
      
      ffprobe.on('error', (error) => {
        logger.error(`❌ ViewBot ${this.botId}: ffprobe error:`, error);
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
      logger.debug(`⚠️ ViewBot ${this.botId}: Already handling video end or stopping`);
      return;
    }
    this.handlingVideoEnd = true;
    
    logger.debug(`🎬 ViewBot ${this.botId}: Video file has ended - triggering rotation`);
    
    // First, clean up all running processes to prevent crashes
    logger.debug(`🧹 ViewBot ${this.botId}: Cleaning up before rotation...`);
    
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
      logger.debug(`🔄 ViewBot ${this.botId}: Requesting rotation from parent service`);
      parentService.handleVideoEnd(this.botId);
    } else {
      logger.warn(`⚠️ ViewBot ${this.botId}: No parent service, attempting direct rotation`);
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

module.exports = ViewBotInstance;
