/**
 * ViewBotLiveKitFFmpeg.js - ViewBot implementation using FFmpeg for LiveKit
 * 
 * Uses FFmpeg to stream video files to LiveKit using WebRTC
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { AccessToken } = require('livekit-server-sdk');

class ViewBotLiveKitFFmpeg {
  constructor(livekitService) {
    this.livekitService = livekitService;
    this.bots = new Map();
    this.videoFolder = '/root/onestreamer/server/uploads';
    
    console.log('🤖 LIVEKIT FFMPEG VIEWBOT: Service initialized');
  }
  
  /**
   * Create a new ViewBot using FFmpeg
   */
  async createViewBot(config) {
    const botId = config.botId || `viewbot-${Date.now()}`;
    
    if (this.bots.has(botId)) {
      return {
        success: false,
        message: 'ViewBot already exists'
      };
    }
    
    try {
      console.log(`🤖 LIVEKIT FFMPEG VIEWBOT: Creating ViewBot: ${botId}`);
      
      // Create access token for the bot
      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;
      
      const token = new AccessToken(apiKey, apiSecret, {
        identity: botId,
        ttl: '24h',
      });
      
      token.addGrant({
        roomJoin: true,
        room: this.livekitService.roomName || 'main',
        canPublish: true,
        canSubscribe: false,
      });
      
      const jwt = await token.toJwt();
      
      // Store bot info
      const bot = {
        id: botId,
        token: jwt,
        videoFile: config.videoFile || '/root/onestreamer/server/uploads/test_10sec.mp4',
        isStreaming: false,
        ffmpegProcess: null
      };
      
      this.bots.set(botId, bot);
      
      console.log(`✅ LIVEKIT FFMPEG VIEWBOT: ViewBot ${botId} created`);
      
      return {
        success: true,
        botId: botId,
        message: 'ViewBot created successfully'
      };
      
    } catch (error) {
      console.error(`❌ LIVEKIT FFMPEG VIEWBOT: Failed to create ViewBot:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }
  
  /**
   * Start streaming video file using FFmpeg
   */
  async startViewBot(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      return {
        success: false,
        message: 'ViewBot not found'
      };
    }
    
    if (bot.isStreaming) {
      return {
        success: false,
        message: 'ViewBot already streaming'
      };
    }
    
    try {
      console.log(`🎬 LIVEKIT FFMPEG VIEWBOT: Starting stream for ${botId}`);
      
      // Check if video file exists
      try {
        await fs.access(bot.videoFile);
      } catch (error) {
        throw new Error(`Video file not found: ${bot.videoFile}`);
      }
      
      // LiveKit WebRTC URL with token
      const livekitUrl = process.env.LIVEKIT_URL || 'wss://onestreamer.live:7880';
      const roomName = this.livekitService.roomName || 'main';
      
      // Create WebRTC URL for FFmpeg
      // Note: FFmpeg's WebRTC support is limited and experimental
      // We'll use RTP streaming as an alternative
      
      // Start FFmpeg with RTP output
      const ffmpegArgs = [
        '-re', // Read input at native frame rate
        '-i', bot.videoFile,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '2M',
        '-maxrate', '2M',
        '-bufsize', '4M',
        '-pix_fmt', 'yuv420p',
        '-g', '30', // GOP size
        '-f', 'rtp',
        'rtp://127.0.0.1:5004', // Video RTP
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-f', 'rtp',
        'rtp://127.0.0.1:5006' // Audio RTP
      ];
      
      console.log(`🎥 LIVEKIT FFMPEG VIEWBOT ${botId}: Starting FFmpeg with RTP output`);
      
      bot.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      bot.ffmpegProcess.stdout.on('data', (data) => {
        // FFmpeg outputs SDP on stdout when using RTP
        const output = data.toString();
        if (output.includes('SDP:')) {
          console.log(`📋 LIVEKIT FFMPEG VIEWBOT ${botId}: SDP generated`);
          // In a real implementation, we would use this SDP to establish WebRTC connection
        }
      });
      
      bot.ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('error')) {
          console.error(`❌ LIVEKIT FFMPEG VIEWBOT ${botId}: FFmpeg error:`, output);
        } else if (output.includes('frame=')) {
          // Progress indicator
          const frameMatch = output.match(/frame=\s*(\d+)/);
          if (frameMatch && parseInt(frameMatch[1]) % 100 === 0) {
            console.log(`📊 LIVEKIT FFMPEG VIEWBOT ${botId}: Streaming... (frame ${frameMatch[1]})`);
          }
        }
      });
      
      bot.ffmpegProcess.on('error', (error) => {
        console.error(`❌ LIVEKIT FFMPEG VIEWBOT ${botId}: FFmpeg process error:`, error);
        bot.isStreaming = false;
      });
      
      bot.ffmpegProcess.on('exit', (code) => {
        console.log(`🎬 LIVEKIT FFMPEG VIEWBOT ${botId}: FFmpeg process ended (code: ${code})`);
        bot.isStreaming = false;
      });
      
      bot.isStreaming = true;
      
      // Note: This creates RTP streams but doesn't connect them to LiveKit
      // LiveKit requires proper WebRTC signaling which FFmpeg doesn't fully support
      console.log(`⚠️ LIVEKIT FFMPEG VIEWBOT ${botId}: FFmpeg is streaming RTP but not connected to LiveKit`);
      console.log(`💡 LIVEKIT FFMPEG VIEWBOT ${botId}: Full LiveKit integration requires WebRTC signaling`);
      
      return {
        success: true,
        message: 'ViewBot streaming started (RTP only)',
        note: 'LiveKit connection requires additional WebRTC signaling implementation'
      };
      
    } catch (error) {
      console.error(`❌ LIVEKIT FFMPEG VIEWBOT: Failed to start streaming:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }
  
  /**
   * Stop ViewBot streaming
   */
  async stopViewBot(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      return {
        success: false,
        message: 'ViewBot not found'
      };
    }
    
    console.log(`⏹️ LIVEKIT FFMPEG VIEWBOT: Stopping ${botId}`);
    
    // Stop FFmpeg process
    if (bot.ffmpegProcess) {
      bot.ffmpegProcess.kill('SIGTERM');
      bot.ffmpegProcess = null;
    }
    
    bot.isStreaming = false;
    
    return {
      success: true,
      message: 'ViewBot stopped'
    };
  }
  
  /**
   * Get ViewBot status
   */
  getStatus(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      return {
        exists: false
      };
    }
    
    return {
      exists: true,
      id: bot.id,
      isStreaming: bot.isStreaming,
      videoFile: bot.videoFile
    };
  }
}

module.exports = ViewBotLiveKitFFmpeg;