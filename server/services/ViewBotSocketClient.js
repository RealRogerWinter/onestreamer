/**
 * ViewBotSocketClient - Makes ViewBots connect as real Socket.IO clients
 * This ensures they follow the exact same flow as real users
 */

const io = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const logger = require('../bootstrap/logger').child({ svc: 'ViewBotSocketClient' });

class ViewBotSocketClient {
  constructor(botId, serverUrl, mediaFile = null) {
    this.botId = botId;
    this.serverUrl = serverUrl || 'https://127.0.0.1:8443';
    this.mediaFile = mediaFile;
    this.videoFile = mediaFile; // Track for video-ended event
    this.socket = null;
    this.gstreamerProcess = null;
    this.transport = null;
    this.producers = new Map();
    this.isStreaming = false;
    this.rtpPorts = {
      video: null,
      audio: null
    };
    
    // Disable SSL verification for local testing
    if (this.serverUrl.includes('127.0.0.1') || this.serverUrl.includes('localhost')) {
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
    }
    
    logger.debug(`🤖 ViewBotSocketClient: Created ${botId} for ${serverUrl}`);
  }
  
  /**
   * Connect to server as a Socket.IO client
   */
  async connect() {
    return new Promise((resolve, reject) => {
      logger.debug(`🔌 ViewBot ${this.botId}: Connecting to ${this.serverUrl}...`);
      logger.debug(`🔍 ViewBot ${this.botId}: Connection context - Timestamp: ${new Date().toISOString()}`);
      
      this.socket = io(this.serverUrl, {
        transports: ['websocket'],
        rejectUnauthorized: false,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
      });
      
      this.socket.on('connect', () => {
        logger.debug(`✅ ViewBot ${this.botId}: Connected to server - Socket ID: ${this.socket.id}`);
        logger.debug(`🔍 ViewBot ${this.botId}: Setting up handlers at ${new Date().toISOString()}`);
        this.setupSocketHandlers();
        resolve();
      });
      
      this.socket.on('connect_error', (error) => {
        logger.error(`❌ ViewBot ${this.botId}: Connection error:`, error.message);
        reject(error);
      });
      
      this.socket.on('disconnect', (reason) => {
        logger.debug(`🔌 ViewBot ${this.botId}: Disconnected - ${reason}`);
        this.cleanup();
      });
    });
  }
  
  /**
   * Setup Socket.IO event handlers
   */
  setupSocketHandlers() {
    // Handle stream approval (ViewBots are always approved)
    // Server sends 'streaming-approved' not 'stream-approved'
    this.socket.on('streaming-approved', () => {
      logger.debug(`✅ ViewBot ${this.botId}: Streaming approved`);
    });
    
    // Also listen for viewbot-specific approval
    this.socket.on('viewbot-stream-approved', (data) => {
      logger.debug(`✅ ViewBot ${this.botId}: ViewBot stream approved`);
    });
    
    // Handle stream denial (shouldn't happen for ViewBots)
    this.socket.on('stream-denied', (data) => {
      logger.warn(`⚠️ ViewBot ${this.botId}: Stream denied - ${data.reason}`);
    });
    
    // Handle becoming current streamer
    this.socket.on('current-streamer', (data) => {
      if (data.streamerId === this.socket.id) {
        logger.debug(`🎬 ViewBot ${this.botId}: Now current streamer`);
      }
    });
    
    // Handle stream-ready event (for verification)
    this.socket.on('stream-ready', (data) => {
      if (data.streamerId === this.socket.id) {
        logger.debug(`📢 ViewBot ${this.botId}: stream-ready event received!`);
      }
    });
  }
  
  /**
   * Start streaming like a real user would
   */
  async startStreaming() {
    if (this.isStreaming) {
      logger.debug(`⚠️ ViewBot ${this.botId}: Already streaming`);
      return;
    }
    
    logger.debug(`🎬 ViewBot ${this.botId}: Starting stream...`);
    
    try {
      // Add small delay to ensure server handlers are ready
      logger.debug(`⏳ ViewBot ${this.botId}: Waiting for server to be ready...`);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Step 1: Request stream takeover (like real users)
      await this.requestStreamTakeover();
      
      // Step 2: Decide whether to use WebRTC (mobile-compatible) or Plain RTP
      // NOTE: WebRTC is not possible for viewbots because:
      // 1. GStreamer outputs Plain RTP, not WebRTC
      // 2. WebRTC requires ICE/DTLS negotiation which GStreamer doesn't support
      // 3. WebRTC producers need a connected client peer to negotiate with
      // Therefore, viewbots MUST use Plain RTP, which means mobile clients can't view them
      const USE_WEBRTC = false; // Can't use WebRTC with GStreamer
      
      if (USE_WEBRTC) {
        logger.debug(`📱 ViewBot ${this.botId}: Using WebRTC transport (mobile-compatible)`);
        
        // Step 2a: Create WebRTC transport
        const transportOptions = await this.createWebRtcTransport();
        
        // Step 2b: We still need Plain RTP locally for GStreamer
        // Create a local Plain RTP transport for GStreamer to send to
        const rtpPorts = await this.createLocalRtpPorts();
        
        // Step 3: Start GStreamer sending to local RTP ports
        await this.startGStreamer(rtpPorts);
        
        // Step 4: Create WebRTC producers and pipe GStreamer to them
        await this.createWebRtcProducers();
        
      } else {
        logger.debug(`🖥️ ViewBot ${this.botId}: Using Plain RTP transport (desktop only)`);
        
        // Step 2: Create MediaSoup Plain RTP transport and get ports
        const transportConfig = await this.createMediaSoupTransport();
        
        // Step 3: Start GStreamer (handles both LiveKit and MediaSoup)
        await this.startGStreamer(transportConfig);
        
        // Step 4: Create MediaSoup producers (only if not using LiveKit)
        if (!transportConfig.useLiveKit) {
          await this.createProducers(transportConfig);
        }
      }
      
      this.isStreaming = true;
      logger.debug(`✅ ViewBot ${this.botId}: Streaming started successfully`);
      
    } catch (error) {
      logger.error(`❌ ViewBot ${this.botId}: Failed to start streaming:`, error);
      this.cleanup();
      throw error;
    }
  }
  
  /**
   * Request stream takeover
   */
  async requestStreamTakeover() {
    return new Promise((resolve, reject) => {
      logger.debug(`📡 ViewBot ${this.botId}: Requesting stream takeover...`);
      logger.debug(`📡 ViewBot ${this.botId}: Socket connected: ${this.socket.connected}`);
      logger.debug(`📡 ViewBot ${this.botId}: Socket ID: ${this.socket.id}`);
      
      // Debug: Log the emit
      logger.debug(`📡 ViewBot ${this.botId}: Emitting 'request-to-stream' event with data:`, {
        isViewBot: true,
        streamType: 'viewbot',
        botId: this.botId
      });
      
      // Use the correct event name that server expects
      this.socket.emit('request-to-stream', {
        isViewBot: true,
        streamType: 'viewbot',
        botId: this.botId
      }, (acknowledged) => {
        logger.debug(`📡 ViewBot ${this.botId}: Callback received - acknowledged: ${acknowledged}`);
        if (acknowledged) {
          logger.debug(`✅ ViewBot ${this.botId}: Request acknowledged`);
        } else {
          logger.debug(`❌ ViewBot ${this.botId}: Request NOT acknowledged`);
        }
      });
      
      // Wait for approval or denial
      const approvalTimeout = setTimeout(() => {
        reject(new Error('Stream takeover timeout'));
      }, 2000);
      
      const handleApproval = () => {
        clearTimeout(approvalTimeout);
        this.socket.off('streaming-approved', handleApproval);
        this.socket.off('viewbot-stream-approved', handleApproval2);
        this.socket.off('takeover-denied', handleDenial);
        this.socket.off('stream-denied', handleDenial2);
        logger.debug(`✅ ViewBot ${this.botId}: Takeover approved`);
        resolve();
      };
      
      const handleApproval2 = () => {
        clearTimeout(approvalTimeout);
        this.socket.off('streaming-approved', handleApproval);
        this.socket.off('viewbot-stream-approved', handleApproval2);
        this.socket.off('takeover-denied', handleDenial);
        this.socket.off('stream-denied', handleDenial2);
        logger.debug(`✅ ViewBot ${this.botId}: ViewBot takeover approved`);
        resolve();
      };
      
      const handleDenial = (data) => {
        clearTimeout(approvalTimeout);
        this.socket.off('streaming-approved', handleApproval);
        this.socket.off('viewbot-stream-approved', handleApproval2);
        this.socket.off('takeover-denied', handleDenial);
        this.socket.off('stream-denied', handleDenial2);
        reject(new Error(`Stream denied: ${data.reason}`));
      };
      
      const handleDenial2 = (data) => {
        clearTimeout(approvalTimeout);
        this.socket.off('streaming-approved', handleApproval);
        this.socket.off('viewbot-stream-approved', handleApproval2);
        this.socket.off('takeover-denied', handleDenial);
        this.socket.off('stream-denied', handleDenial2);
        reject(new Error(`Stream denied: ${data.reason}`));
      };
      
      this.socket.once('streaming-approved', handleApproval);
      this.socket.once('viewbot-stream-approved', handleApproval2);
      this.socket.once('takeover-denied', handleDenial);
      this.socket.once('stream-denied', handleDenial2);
    });
  }
  
  /**
   * Create MediaSoup WebRTC transport (mobile-compatible)
   */
  async createWebRtcTransport() {
    return new Promise((resolve, reject) => {
      logger.debug(`🚀 ViewBot ${this.botId}: Requesting WebRTC transport (mobile-compatible)...`);
      
      this.socket.emit('viewbot-create-webrtc-transport', {
        botId: this.botId
      }, (response) => {
        if (response && response.success && response.transportOptions) {
          logger.debug(`✅ ViewBot ${this.botId}: Got WebRTC transport`);
          logger.debug(`   Transport ID: ${response.transportOptions.id}`);
          logger.debug(`   ICE candidates: ${response.transportOptions.iceCandidates?.length || 0}`);
          
          this.webrtcTransport = response.transportOptions;
          this.useWebRtc = true;
          
          // For WebRTC, we need to handle this differently
          // We'll create a Plain RTP transport locally to receive from GStreamer
          // Then pipe it to the WebRTC transport
          resolve(response.transportOptions);
        } else {
          logger.error(`❌ ViewBot ${this.botId}: WebRTC transport creation failed:`, response);
          reject(new Error('Failed to create WebRTC transport'));
        }
      });
    });
  }
  
  /**
   * Create MediaSoup Plain RTP transport (legacy, not mobile-compatible)
   */
  async createMediaSoupTransport() {
    return new Promise((resolve, reject) => {
      logger.debug(`🚚 ViewBot ${this.botId}: Requesting MediaSoup Plain RTP transport (LEGACY)...`);
      
      this.socket.emit('viewbot-create-transport', {
        botId: this.botId
      }, (response) => {
        // Check if server returned LiveKit configuration
        if (response && response.useLiveKit) {
          logger.debug(`🎮 ViewBot ${this.botId}: Server is using LiveKit, switching to whipsink pipeline`);
          this.transport = {
            useLiveKit: true,
            token: response.token,
            whipUrl: response.whipUrl
          };
          // Return special LiveKit indicator
          resolve({
            useLiveKit: true,
            token: response.token,
            whipUrl: response.whipUrl
          });
        } else if (response && response.videoPort && response.audioPort) {
          logger.debug(`✅ ViewBot ${this.botId}: Got MediaSoup ports - Video: ${response.videoPort}, Audio: ${response.audioPort}`);
          this.transport = response;
          this.rtpPorts = {
            video: response.videoPort,
            audio: response.audioPort
          };
          resolve({
            video: response.videoPort,
            audio: response.audioPort
          });
        } else {
          logger.error(`❌ ViewBot ${this.botId}: Transport creation failed:`, response);
          reject(new Error('Failed to create MediaSoup transport'));
        }
      });
    });
  }
  
  /**
   * Start GStreamer pipeline
   */
  async startGStreamer(transportConfig) {
    return new Promise((resolve, reject) => {
      // Only use real video files, no test patterns
      if (!this.mediaFile || !fs.existsSync(this.mediaFile)) {
        logger.error(`❌ ViewBot ${this.botId}: No video file available (${this.mediaFile})`);
        reject(new Error('No video file available for streaming'));
        return;
      }
      
      logger.debug(`📹 ViewBot ${this.botId}: Streaming video file: ${this.mediaFile}`);
      
      let pipelineArgs;
      
      // Check if we're using LiveKit
      if (transportConfig.useLiveKit) {
        logger.debug(`🎮 ViewBot ${this.botId}: Starting LiveKit GStreamer pipeline with whipsink`);
        
        // Build LiveKit pipeline with whipclientsink
        const whipUrl = `${transportConfig.whipUrl}?authorization=Bearer%20${encodeURIComponent(transportConfig.token)}`;
        
        pipelineArgs = [
          'filesrc', `location=${this.mediaFile}`,
          '!', 'decodebin', 'name=dec',
          
          // Video branch
          'dec.',
          '!', 'queue',
          '!', 'videoconvert',
          '!', 'videoscale',
          '!', 'video/x-raw,width=1280,height=720,framerate=30/1',
          '!', 'whipclientsink.video_0',
          
          // Audio branch  
          'dec.',
          '!', 'queue',
          '!', 'audioconvert',
          '!', 'audioresample',
          '!', 'audio/x-raw,rate=48000,channels=2',
          '!', 'whipclientsink.audio_0',
          
          // WHIP sink
          'whipclientsink',
          'name=whipclientsink',
          `signaller::whip-endpoint=${whipUrl}`,
          'signaller::use-link-headers=true'
        ];
        
      } else {
        // MediaSoup pipeline with RTP ports
        this.rtpPorts = transportConfig;
        logger.debug(`🎥 ViewBot ${this.botId}: Starting MediaSoup GStreamer pipeline - Video: ${transportConfig.video}, Audio: ${transportConfig.audio}`);
        
        pipelineArgs = [
          'filesrc', `location=${this.mediaFile}`,
          '!', 'decodebin', 'name=dec', 'use-buffering=false',
          'dec.',
          '!', 'queue', 'max-size-buffers=100', 'max-size-time=100000000', 'max-size-bytes=0', 'min-threshold-buffers=1',
          '!', 'videoconvert',
          '!', 'videoscale',
          '!', 'video/x-raw,width=1280,height=720',
          '!', 'x264enc', 'tune=zerolatency', 'bitrate=2000', 'speed-preset=ultrafast', 'key-int-max=30', 'bframes=0',
          '!', 'rtph264pay', 'pt=102', 'ssrc=11111111',
          '!', 'udpsink', 'host=127.0.0.1', `port=${this.rtpPorts.video}`,
          'dec.',
          '!', 'queue', 'max-size-buffers=100', 'max-size-time=100000000', 'max-size-bytes=0', 'min-threshold-buffers=1',
          '!', 'audioconvert',
          '!', 'audioresample',
          '!', 'audio/x-raw,rate=48000,channels=2',
          '!', 'opusenc',
          '!', 'rtpopuspay', 'pt=101', 'ssrc=22222222',
          '!', 'udpsink', 'host=127.0.0.1', `port=${this.rtpPorts.audio}`
        ];
      }
      
      logger.debug(`🎥 ViewBot ${this.botId}: GStreamer command:`, 'gst-launch-1.0', pipelineArgs.join(' '));
      
      this.gstreamerProcess = spawn('gst-launch-1.0', pipelineArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      this.gstreamerProcess.on('error', (error) => {
        logger.error(`❌ ViewBot ${this.botId}: GStreamer error:`, error);
        reject(error);
      });
      
      this.gstreamerProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('ERROR')) {
          logger.error(`❌ ViewBot ${this.botId}: GStreamer ERROR:`, output);
        } else if (output.includes('WARNING')) {
          logger.warn(`⚠️ ViewBot ${this.botId}: GStreamer WARNING:`, output);
        } else if (output.includes('PLAYING')) {
          logger.debug(`▶️ ViewBot ${this.botId}: GStreamer pipeline PLAYING`);
        }
      });
      
      // Handle when GStreamer process exits (video file ends)
      this.gstreamerProcess.on('exit', async (code, signal) => {
        logger.debug(`🎬 ViewBot ${this.botId}: GStreamer process ended (code: ${code}, signal: ${signal})`);
        
        // If we're still supposed to be streaming and the video file ended naturally
        if (this.isStreaming && code === 0 && this.videoFile) {
          logger.debug(`🔄 ViewBot ${this.botId}: Video file ended, triggering rotation...`);
          
          // Stop current stream
          await this.stopStreaming();
          
          // Trigger rotation to next video
          if (this.socket && this.socket.connected) {
            this.socket.emit('viewbot-video-ended', { 
              botId: this.botId,
              videoFile: this.videoFile 
            });
          }
        }
      });
      
      // Give GStreamer time to start
      setTimeout(() => {
        logger.debug(`✅ ViewBot ${this.botId}: GStreamer started`);
        resolve();
      }, 100);
    });
  }
  
  /**
   * Create local RTP ports for GStreamer (when using WebRTC)
   */
  async createLocalRtpPorts() {
    // For now, use fixed local ports - in production should be dynamic
    const ports = {
      video: 5004,
      audio: 5006
    };
    logger.debug(`🔌 ViewBot ${this.botId}: Using local RTP ports - Video: ${ports.video}, Audio: ${ports.audio}`);
    return ports;
  }
  
  /**
   * Create WebRTC producers (mobile-compatible)
   */
  async createWebRtcProducers() {
    logger.debug(`🎬 ViewBot ${this.botId}: Creating WebRTC producers...`);
    
    return new Promise((resolve, reject) => {
      this.socket.emit('viewbot-webrtc-produce', {
        botId: this.botId,
        transportId: this.webrtcTransport?.id
      }, (response) => {
        if (response && response.success) {
          logger.debug(`✅ ViewBot ${this.botId}: WebRTC producers created`);
          logger.debug(`   Video producer: ${response.videoProducerId}`);
          logger.debug(`   Audio producer: ${response.audioProducerId}`);
          
          // Emit stream-ready event
          logger.debug(`📢 ViewBot ${this.botId}: Emitting viewbot-stream-ready event`);
          this.socket.emit('viewbot-stream-ready', {
            botId: this.botId,
            timestamp: new Date().toISOString(),
            hasVideo: true,
            hasAudio: true,
            isWebRTC: true
          });
          
          logger.debug(`✅ ViewBot ${this.botId}: Stream ready notification sent`);
          resolve();
        } else {
          logger.error(`❌ ViewBot ${this.botId}: Failed to create WebRTC producers:`, response);
          reject(new Error('Failed to create WebRTC producers'));
        }
      });
    });
  }
  
  /**
   * Create MediaSoup producers and notify server (Plain RTP - legacy)
   */
  async createProducers(rtpPorts) {
    logger.debug(`🎤 ViewBot ${this.botId}: Creating MediaSoup producers...`);
    
    return new Promise((resolve, reject) => {
      // Request server to create producers for our Plain RTP transports
      this.socket.emit('viewbot-create-producers', {
        botId: this.botId,
        videoTransportId: this.transport.videoTransportId,
        audioTransportId: this.transport.audioTransportId,
        rtpPorts: rtpPorts
      }, (response) => {
        if (response && response.success) {
          logger.debug(`✅ ViewBot ${this.botId}: MediaSoup producers created`);
          
          // Now emit stream-ready since producers exist
          logger.debug(`📢 ViewBot ${this.botId}: Emitting viewbot-stream-ready event`);
          this.socket.emit('viewbot-stream-ready', {
            botId: this.botId,
            timestamp: new Date().toISOString(),
            hasVideo: true,
            hasAudio: true,
            videoProducerId: response.videoProducerId,
            audioProducerId: response.audioProducerId
          });
          
          logger.debug(`✅ ViewBot ${this.botId}: Stream ready notification sent`);
          resolve();
        } else {
          reject(new Error('Failed to create MediaSoup producers'));
        }
      });
    });
  }
  
  // Producer creation not needed - ViewBots emit stream-ready directly
  
  /**
   * Stop streaming
   */
  async stopStreaming() {
    logger.debug(`⏹️ ViewBot ${this.botId}: Stopping stream...`);
    
    this.isStreaming = false;
    
    // Notify server we're stopping
    if (this.socket && this.socket.connected) {
      this.socket.emit('stop-stream', { botId: this.botId });
    }
    
    this.cleanup();
  }
  
  /**
   * Cleanup resources
   */
  cleanup() {
    // Stop GStreamer
    if (this.gstreamerProcess) {
      this.gstreamerProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
          this.gstreamerProcess.kill('SIGKILL');
        }
      }, 1000);
      this.gstreamerProcess = null;
    }
    
    // Clear producers
    this.producers.clear();
    
    // IMPORTANT: Request server to close transports BEFORE disconnecting
    if (this.socket && this.socket.connected) {
      logger.debug(`🧹 ViewBot ${this.botId}: Requesting transport cleanup from server...`);
      this.socket.emit('viewbot-cleanup-transports', { 
        botId: this.botId,
        socketId: this.socket.id 
      });
      
      // Give server time to cleanup before disconnecting
      setTimeout(() => {
        if (this.socket) {
          this.socket.disconnect();
          this.socket = null;
        }
      }, 100);
    } else if (this.socket) {
      // If not connected, just clear the socket
      this.socket.disconnect();
      this.socket = null;
    }
    
    // Clear transport reference
    this.transport = null;
    this.rtpPorts = { video: null, audio: null };
    
    logger.debug(`🧹 ViewBot ${this.botId}: Cleaned up`);
  }
}

module.exports = ViewBotSocketClient;
