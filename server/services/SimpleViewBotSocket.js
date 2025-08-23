/**
 * SimpleViewBotSocket - Handles socket connection for viewbots to stream through the platform
 */

const io = require('socket.io-client');
const { spawn } = require('child_process');

class SimpleViewBotSocket {
  constructor(botId, serverUrl = 'https://onestreamer.live:8443') {
    this.botId = botId;
    this.serverUrl = serverUrl;
    this.socket = null;
    this.gstreamerProcess = null;
    this.streaming = false;
    this.mediaFile = null;
  }
  
  /**
   * Connect to the streaming platform
   */
  async connect() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Connecting bot ${this.botId} to ${this.serverUrl}`);
      
      this.socket = io(this.serverUrl, {
        transports: ['websocket'],
        secure: true,
        rejectUnauthorized: false,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5
      });
      
      this.socket.on('connect', () => {
        console.log(`✅ Bot ${this.botId} connected with socket ID: ${this.socket.id}`);
        
        // Identify as a viewbot
        this.socket.emit('identify', {
          type: 'viewbot',
          botId: this.botId,
          username: `ViewBot-${this.botId.slice(-6)}`
        });
        
        resolve(this.socket.id);
      });
      
      this.socket.on('connect_error', (error) => {
        console.error(`❌ Bot ${this.botId} connection error:`, error.message);
        reject(error);
      });
      
      this.socket.on('disconnect', (reason) => {
        console.log(`🔌 Bot ${this.botId} disconnected: ${reason}`);
        this.streaming = false;
      });
      
      // Handle streaming events
      this.setupStreamingHandlers();
      
      // Set timeout for connection
      setTimeout(() => {
        if (!this.socket.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }
  
  /**
   * Setup handlers for streaming events
   */
  setupStreamingHandlers() {
    // Handle streaming approval
    this.socket.on('streaming-approved', () => {
      console.log(`🎬 Bot ${this.botId} approved to stream`);
      this.startGStreamer();
    });
    
    // Handle request acknowledgment
    this.socket.on('request-acknowledged', () => {
      console.log(`📡 Bot ${this.botId} stream request acknowledged`);
    });
    
    // Handle errors
    this.socket.on('error', (error) => {
      console.error(`❌ Bot ${this.botId} socket error:`, error);
    });
    
    // Handle stream status updates
    this.socket.on('stream-status', (status) => {
      if (status.isStreaming && status.streamerId === this.socket.id) {
        console.log(`📺 Bot ${this.botId} is now live`);
      }
    });
  }
  
  /**
   * Request to start streaming
   */
  async requestStream() {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Not connected');
    }
    
    console.log(`📨 Bot ${this.botId} requesting to stream`);
    
    // Request to stream
    this.socket.emit('request-to-stream');
    
    // Wait for approval
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Stream request timeout'));
      }, 10000);
      
      const approvalHandler = () => {
        clearTimeout(timeout);
        this.socket.off('streaming-approved', approvalHandler);
        resolve();
      };
      
      this.socket.once('streaming-approved', approvalHandler);
    });
  }
  
  /**
   * Start GStreamer pipeline
   */
  startGStreamer() {
    if (this.gstreamerProcess) {
      console.log(`⚠️ Bot ${this.botId} GStreamer already running`);
      return;
    }
    
    console.log(`🎥 Bot ${this.botId} starting GStreamer pipeline`);
    
    // Build pipeline based on media file
    let pipeline;
    
    if (this.mediaFile) {
      // Use actual video file
      pipeline = [
        'filesrc', `location=${this.mediaFile}`,
        '!', 'decodebin', 'name=decoder',
        
        // Video branch
        'decoder.',
        '!', 'videoconvert',
        '!', 'videoscale',
        '!', 'video/x-raw,width=1280,height=720',
        '!', 'x264enc', 'tune=zerolatency', 'bitrate=1000', 'key-int-max=30',
        '!', 'rtph264pay', 'config-interval=1', 'pt=102',
        '!', 'udpsink', 'host=127.0.0.1', 'port=5004',
        
        // Audio branch
        'decoder.',
        '!', 'audioconvert',
        '!', 'audioresample',
        '!', 'audio/x-raw,rate=48000,channels=2',
        '!', 'opusenc',
        '!', 'rtpopuspay', 'pt=101',
        '!', 'udpsink', 'host=127.0.0.1', 'port=5006'
      ];
    } else {
      // Use test pattern
      pipeline = [
        // Video test source
        'videotestsrc', 'pattern=smpte',
        '!', 'video/x-raw,width=1280,height=720,framerate=30/1',
        '!', 'x264enc', 'tune=zerolatency', 'bitrate=1000', 'key-int-max=30',
        '!', 'rtph264pay', 'config-interval=1', 'pt=102',
        '!', 'udpsink', 'host=127.0.0.1', 'port=5004',
        
        // Audio test source
        'audiotestsrc', 'wave=sine', 'freq=440',
        '!', 'audio/x-raw,rate=48000,channels=2',
        '!', 'opusenc',
        '!', 'rtpopuspay', 'pt=101',
        '!', 'udpsink', 'host=127.0.0.1', 'port=5006'
      ];
    }
    
    // Start GStreamer
    this.gstreamerProcess = spawn('gst-launch-1.0', pipeline, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    this.gstreamerProcess.on('error', (error) => {
      console.error(`❌ Bot ${this.botId} GStreamer error:`, error);
      this.stopGStreamer();
    });
    
    this.gstreamerProcess.on('exit', (code) => {
      console.log(`📤 Bot ${this.botId} GStreamer exited with code ${code}`);
      this.gstreamerProcess = null;
      
      // Notify server that streaming ended
      if (this.socket && this.socket.connected) {
        this.socket.emit('streaming-ended');
      }
    });
    
    this.streaming = true;
    console.log(`✅ Bot ${this.botId} GStreamer pipeline started`);
  }
  
  /**
   * Stop GStreamer pipeline
   */
  stopGStreamer() {
    if (this.gstreamerProcess) {
      console.log(`⏹️ Bot ${this.botId} stopping GStreamer`);
      this.gstreamerProcess.kill('SIGTERM');
      
      // Force kill after timeout
      setTimeout(() => {
        if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
          this.gstreamerProcess.kill('SIGKILL');
        }
      }, 2000);
      
      this.gstreamerProcess = null;
    }
    
    this.streaming = false;
  }
  
  /**
   * Start streaming with a media file
   */
  async startStreaming(mediaFile = null) {
    this.mediaFile = mediaFile;
    
    // Connect if not connected
    if (!this.socket || !this.socket.connected) {
      await this.connect();
    }
    
    // Request to stream
    await this.requestStream();
    
    // GStreamer will be started when we receive streaming-approved
    
    return true;
  }
  
  /**
   * Stop streaming
   */
  async stopStreaming() {
    console.log(`⏹️ Bot ${this.botId} stopping stream`);
    
    // Stop GStreamer
    this.stopGStreamer();
    
    // Notify server
    if (this.socket && this.socket.connected) {
      this.socket.emit('stop-streaming');
    }
    
    return true;
  }
  
  /**
   * Disconnect from server
   */
  disconnect() {
    this.stopGStreamer();
    
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    
    console.log(`🔌 Bot ${this.botId} disconnected`);
  }
  
  /**
   * Check if currently streaming
   */
  isStreaming() {
    return this.streaming && this.gstreamerProcess !== null;
  }
}

module.exports = SimpleViewBotSocket;