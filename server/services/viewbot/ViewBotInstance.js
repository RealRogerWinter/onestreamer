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
const { buildTestPatternVideoArgs, buildTestPatternAudioArgs } = require('./testPatternFfmpegArgs');
const { buildCanvasHTML } = require('./canvasHtml');
const RotationScheduler = require('./rotationScheduler');
const durationProbe = require('./durationProbe');

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
    
    // ViewBot rotation system - probability-based. The live timer is owned by
    // this.rotationScheduler; this field is retained as documented state shape.
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

    // FFmpeg processes and RTP ports (read by the test-pattern ffmpeg arg builders)
    this.videoFFmpeg = null;
    this.audioFFmpeg = null;
    this.videoRtpPort = null;
    this.audioRtpPort = null;

    // Legacy properties (kept for backward compatibility)
    this.mediaGenerator = null;
    this.ffmpegProcess = null;

    // Rotation-check scheduling (the rotate action stays here in requestRotation)
    this.rotationScheduler = new RotationScheduler({
      botId: this.botId,
      logger,
      getParentService: () => this.getParentService(),
      isStreaming: () => this.streaming,
      onRotate: () => this.requestRotation(),
    });

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
      // admin video-file streaming (MediaSoup/GStreamer) was removed — dead under backend=livekit
      logger.debug(`🎬 ViewBot ${this.botId}: Content type ${this.config.contentType} - starting media generation`);
      await this.initializeMediaGeneration();
      
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
   * Set up duration-based rotation as a failsafe
   */
  async setupDurationBasedRotation(videoFile) {
    return durationProbe.setupDurationBasedRotation(this, videoFile, logger);
  }
  
  /**
   * Creates FFmpeg arguments for video test pattern generation
   */
  createVideoFFmpegArgs(width, height, frameRate, pattern) {
    return buildTestPatternVideoArgs({
      videoRtpPort: this.videoRtpPort,
      config: this.config,
      width, height, frameRate, pattern,
      botId: this.botId,
      logger,
    });
  }

  /**
   * Creates FFmpeg arguments for audio generation
   */
  createAudioFFmpegArgs() {
    return buildTestPatternAudioArgs({
      audioRtpPort: this.audioRtpPort,
      config: this.config,
      botId: this.botId,
      logger,
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
    return buildCanvasHTML(this.config, this.botId);
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
    this.rotationScheduler.start();
  }

  /**
   * Schedules the next rotation probability check
   */
  scheduleNextRotationCheck() {
    this.rotationScheduler.scheduleNext();
  }
  
  /**
   * Stops the rotation check timer
   */
  stopRotationCheckTimer() {
    this.rotationScheduler.stop();
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
    if (this.streaming && this.rotationScheduler.timer) {
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
    return durationProbe.getVideoDuration(this, videoPath, logger);
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

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    if (this.videoDurationTimer) {
      clearTimeout(this.videoDurationTimer);
      this.videoDurationTimer = null;
    }

    // Clean up media generation (Puppeteer/ffmpeg) before rotating
    await this.cleanupMediaGeneration();

    // Wait for cleanup to complete
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
