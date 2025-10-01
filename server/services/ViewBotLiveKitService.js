/**
 * ViewBot service for LiveKit backend
 * Uses FFmpeg to stream video files to LiveKit via WHIP
 */

const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class ViewBotLiveKitService {
  constructor(livekitService) {
    this.livekitService = livekitService;
    this.activeBots = new Map();
    this.roomClient = null;
    this.config = require('../config/webrtc.config').livekit;
    this.videoFiles = [];
    this.currentVideoIndex = 0;
  }

  async initialize() {
    if (!this.roomClient) {
      // Ensure host has protocol
      const host = this.config.host.startsWith('http') 
        ? this.config.host 
        : `http://${this.config.host}`;
        
      this.roomClient = new RoomServiceClient(
        host,
        this.config.apiKey,
        this.config.apiSecret
      );
      
      console.log('🤖 LIVEKIT VIEWBOT: Service initialized');
      
      // Load available video files
      await this.loadVideoFiles();
    }
  }

  /**
   * Load available video files from uploads directory
   */
  async loadVideoFiles() {
    const uploadsDir = path.join(__dirname, '../uploads');
    try {
      const files = fs.readdirSync(uploadsDir);
      this.videoFiles = files
        .filter(f => f.endsWith('.mp4'))
        .map(f => path.join(uploadsDir, f));
      
      if (this.videoFiles.length > 0) {
        console.log(`📹 LIVEKIT VIEWBOT: Found ${this.videoFiles.length} video files for rotation`);
      } else {
        console.warn('⚠️ LIVEKIT VIEWBOT: No video files found in uploads directory');
      }
    } catch (error) {
      console.error('❌ LIVEKIT VIEWBOT: Failed to load video files:', error);
    }
  }

  /**
   * Get next video file in rotation
   */
  getNextVideoFile() {
    if (this.videoFiles.length === 0) {
      return null;
    }
    
    const videoFile = this.videoFiles[this.currentVideoIndex];
    this.currentVideoIndex = (this.currentVideoIndex + 1) % this.videoFiles.length;
    return videoFile;
  }

  /**
   * Creates a new ViewBot that publishes to LiveKit using FFmpeg
   */
  async createViewBot(config = {}) {
    await this.initialize();
    
    const botId = `viewbot-${uuidv4().substring(0, 8)}`;
    
    console.log(`🤖 LIVEKIT VIEWBOT: Creating ViewBot: ${botId}`);
    
    // Get a video file if not provided
    let videoFile = config.videoFile || this.getNextVideoFile();
    
    if (!videoFile) {
      console.error('❌ LIVEKIT VIEWBOT: No video files available');
      return {
        success: false,
        message: 'No video files available for streaming'
      };
    }
    
    const bot = {
      id: botId,
      config: {
        videoFile: videoFile,
        width: config.width || 1280,
        height: config.height || 720,
        frameRate: config.frameRate || 30,
        videoBitrate: config.videoBitrate || 2000,
        audioBitrate: config.audioBitrate || 128,
        ...config
      },
      ffmpegProcess: null,
      participantId: null,
      running: false,
      startTime: null,
      token: null
    };

    try {
      // Generate access token for the viewbot
      bot.token = await this.generateBotToken(botId);
      
      // Start FFmpeg streaming
      await this.startFFmpegStream(bot);
      
      this.activeBots.set(botId, bot);
      
      console.log(`✅ LIVEKIT VIEWBOT: ViewBot created: ${botId}`);
      return {
        success: true,
        botId,
        message: 'LiveKit ViewBot created successfully'
      };
    } catch (error) {
      console.error(`❌ LIVEKIT VIEWBOT: Failed to create ViewBot:`, error);
      await this.cleanup(bot);
      return {
        success: false,
        message: `Failed to create ViewBot: ${error.message}`
      };
    }
  }

  /**
   * Generate access token for viewbot
   */
  async generateBotToken(botId) {
    const at = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: botId,
      name: `ViewBot ${botId}`,
      metadata: JSON.stringify({
        type: 'viewbot',
        createdAt: Date.now()
      })
    });

    at.addGrant({ 
      roomJoin: true, 
      room: this.config.roomName,
      canPublish: true,
      canSubscribe: false
    });

    return at.toJwt();
  }

  /**
   * Start GStreamer stream to LiveKit using WHIP
   */
  async startFFmpegStream(bot) {
    const { config } = bot;
    
    console.log(`🎬 LIVEKIT VIEWBOT: Starting GStreamer WHIP stream for ${bot.id}`);
    console.log(`📹 LIVEKIT VIEWBOT ${bot.id}: Streaming video: ${path.basename(config.videoFile)}`);
    
    return new Promise(async (resolve, reject) => {
      // Construct WHIP endpoint URL with token
      const whipUrl = `https://onestreamer.live/livekit/rtc?access_token=${bot.token}`;
      
      // Build GStreamer pipeline using whipclientsink
      const pipelineArgs = [
        // Video file source
        'filesrc', `location=${config.videoFile}`,
        '!', 'decodebin', 'name=dec',
        
        // Video processing
        'dec.',
        '!', 'queue',
        '!', 'videoconvert',
        '!', 'videoscale',
        '!', `video/x-raw,width=${config.width},height=${config.height},framerate=${config.frameRate}/1`,
        '!', 'x264enc',
        `bitrate=${config.videoBitrate}`,
        'tune=zerolatency',
        'speed-preset=ultrafast',
        'key-int-max=30',
        '!', 'video/x-h264,profile=baseline',
        '!', 'h264parse',
        '!', 'rtph264pay',
        'config-interval=-1',
        'pt=96',
        '!', 'application/x-rtp,media=video,encoding-name=H264,payload=96',
        '!', 'whipclientsink.sink_0',
        
        // Audio processing
        'dec.',
        '!', 'queue',
        '!', 'audioconvert',
        '!', 'audioresample',
        '!', 'audio/x-raw,rate=48000,channels=2',
        '!', 'opusenc',
        '!', 'rtpopuspay',
        'pt=97',
        '!', 'application/x-rtp,media=audio,encoding-name=OPUS,payload=97',
        '!', 'whipclientsink.sink_1',
        
        // WHIP client sink
        'whipclientsink',
        'name=whipclientsink',
        `signaller::whip-endpoint=${whipUrl}`,
        'signaller::use-link-headers=true'
      ];
      
      console.log(`🎥 LIVEKIT VIEWBOT ${bot.id}: Starting GStreamer pipeline with whipclientsink`);
      
      bot.gstreamerProcess = spawn('gst-launch-1.0', pipelineArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      bot.gstreamerProcess.on('error', (error) => {
        console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: GStreamer launch error:`, error);
        reject(error);
      });
      
      let pipelineStarted = false;
      
      bot.gstreamerProcess.stderr.on('data', (data) => {
        const output = data.toString();
        
        if (output.includes('ERROR')) {
          console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: GStreamer ERROR:`, output);
          if (!pipelineStarted) {
            reject(new Error('GStreamer pipeline error: ' + output));
          }
        } else if (output.includes('WARNING')) {
          console.warn(`⚠️ LIVEKIT VIEWBOT ${bot.id}: GStreamer WARNING:`, output);
        } else if (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED')) {
          console.log(`▶️ LIVEKIT VIEWBOT ${bot.id}: GStreamer pipeline PLAYING`);
          bot.running = true;
          bot.startTime = Date.now();
          if (!pipelineStarted) {
            pipelineStarted = true;
            console.log(`✅ LIVEKIT VIEWBOT ${bot.id}: Streaming to LiveKit via WHIP`);
            resolve();
          }
        } else if (output.includes('Setting pipeline to PLAYING')) {
          console.log(`🚀 LIVEKIT VIEWBOT ${bot.id}: Starting pipeline...`);
        }
        
        // Log other output for debugging
        if (!output.includes('WARNING') && !output.includes('ERROR') && output.trim()) {
          console.log(`📝 LIVEKIT VIEWBOT ${bot.id}: ${output.trim()}`);
        }
      });
      
      bot.gstreamerProcess.stdout.on('data', (data) => {
        console.log(`📝 LIVEKIT VIEWBOT ${bot.id} stdout: ${data.toString().trim()}`);
      });
      
      // Handle when GStreamer process exits (video file ends)
      bot.gstreamerProcess.on('exit', async (code, signal) => {
        console.log(`🎬 LIVEKIT VIEWBOT ${bot.id}: GStreamer process ended (code: ${code}, signal: ${signal})`);
        bot.running = false;
        
        // If video ended naturally, rotate to next
        if (code === 0 && this.videoFiles.length > 1) {
          console.log(`🔄 LIVEKIT VIEWBOT ${bot.id}: Video ended, rotating to next...`);
          await this.rotateVideo(bot);
        }
      });
      
      // Set a timeout to ensure we don't wait forever
      setTimeout(() => {
        if (!pipelineStarted) {
          reject(new Error('GStreamer pipeline startup timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Rotate to next video
   */
  async rotateVideo(bot) {
    if (!bot || !bot.running) return;
    
    const nextVideo = this.getNextVideoFile();
    if (!nextVideo) return;
    
    console.log(`🔄 LIVEKIT VIEWBOT ${bot.id}: Rotating to video: ${path.basename(nextVideo)}`);
    
    // Stop current process
    if (bot.gstreamerProcess) {
      bot.gstreamerProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Update config with new video
    bot.config.videoFile = nextVideo;
    
    // Start new stream
    try {
      await this.startFFmpegStream(bot);
    } catch (error) {
      console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: Failed to rotate video:`, error);
    }
  }

  /**
   * Stop a ViewBot
   */
  async stopViewBot(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: 'ViewBot not found' };
    }

    console.log(`🛑 LIVEKIT VIEWBOT: Stopping ViewBot: ${botId}`);
    
    bot.running = false;
    await this.cleanup(bot);
    
    return {
      success: true,
      message: 'ViewBot stopped successfully'
    };
  }

  /**
   * Cleanup bot resources
   */
  async cleanup(bot) {
    bot.running = false;
    
    // Kill streaming process
    if (bot.gstreamerProcess || bot.ffmpegProcess) {
      const process = bot.gstreamerProcess || bot.ffmpegProcess;
      try {
        process.kill('SIGTERM');
        // Give it time to cleanup
        await new Promise(resolve => setTimeout(resolve, 500));
        // Force kill if still running
        if (!process.killed) {
          process.kill('SIGKILL');
        }
      } catch (error) {
        console.error(`Error killing process: ${error.message}`);
      }
      bot.gstreamerProcess = null;
      bot.ffmpegProcess = null;
    }
    
    // Remove participant from room if still connected
    if (bot.participantId) {
      try {
        await this.roomClient.removeParticipant(this.config.roomName, bot.id);
        console.log(`✅ LIVEKIT VIEWBOT ${bot.id}: Removed from room`);
      } catch (error) {
        // Participant may have already disconnected
        console.log(`ℹ️ LIVEKIT VIEWBOT ${bot.id}: Already disconnected from room`);
      }
    }
  }

  /**
   * Get ViewBot status
   */
  getViewBotStatus(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { exists: false };
    }

    const uptime = bot.startTime ? Date.now() - bot.startTime : 0;
    
    return {
      exists: true,
      running: bot.running,
      config: bot.config,
      uptime: uptime,
      participantId: bot.participantId,
      processActive: (bot.gstreamerProcess && !bot.gstreamerProcess.killed) || 
                     (bot.ffmpegProcess && !bot.ffmpegProcess.killed),
      videoFile: bot.config.videoFile || 'none'
    };
  }

  /**
   * List all ViewBots
   */
  listViewBots() {
    return Array.from(this.activeBots.keys()).map(botId => ({
      botId,
      ...this.getViewBotStatus(botId)
    }));
  }

  /**
   * Remove ViewBot completely
   */
  async removeViewBot(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: 'ViewBot not found' };
    }

    await this.stopViewBot(botId);
    this.activeBots.delete(botId);
    
    return {
      success: true,
      message: 'ViewBot removed successfully'
    };
  }

  /**
   * Stop all ViewBots
   */
  async stopAllViewBots() {
    console.log(`🛑 LIVEKIT VIEWBOT: Stopping all ViewBots...`);
    
    const stopPromises = [];
    for (const [botId, bot] of this.activeBots) {
      stopPromises.push(this.cleanup(bot));
    }
    
    await Promise.all(stopPromises);
    this.activeBots.clear();
    
    console.log(`✅ LIVEKIT VIEWBOT: All ViewBots stopped`);
  }

  /**
   * Start a ViewBot that connects to the room
   */
  async startViewBot(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: 'ViewBot not found' };
    }

    if (bot.running) {
      return { success: false, message: 'ViewBot is already running' };
    }

    // Generate new token and restart streaming
    bot.token = await this.generateBotToken(botId);
    await this.startFFmpegStream(bot);

    return {
      success: true,
      message: 'ViewBot started successfully'
    };
  }
}

module.exports = ViewBotLiveKitService;