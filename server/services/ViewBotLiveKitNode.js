/**
 * ViewBotLiveKitNode.js - ViewBot implementation using LiveKit Node SDK with FFmpeg
 * 
 * Uses FFmpeg to read video files and stream them directly to LiveKit using the Node SDK
 */

const { AccessToken, RoomServiceClient, TrackPublishOptions, VideoPresets } = require('livekit-server-sdk');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

class ViewBotLiveKitNode {
  constructor(livekitService) {
    this.livekitService = livekitService;
    this.bots = new Map();
    this.videoFolder = '/root/onestreamer/server/uploads';
    
    console.log('🤖 LIVEKIT NODE VIEWBOT: Service initialized');
  }
  
  /**
   * Create and start a ViewBot using FFmpeg to stream to LiveKit
   */
  async createAndStartViewBot(config) {
    const botId = config.botId || `viewbot-${Date.now()}`;
    
    if (this.bots.has(botId)) {
      return {
        success: false,
        message: 'ViewBot already exists'
      };
    }
    
    try {
      console.log(`🤖 LIVEKIT NODE VIEWBOT: Creating ViewBot: ${botId}`);
      
      // Create access token for the bot
      const apiKey = process.env.LIVEKIT_API_KEY || 'REDACTED-LIVEKIT-API-KEY';
      const apiSecret = process.env.LIVEKIT_API_SECRET || 'REDACTED-LIVEKIT-API-SECRET';
      
      const token = new AccessToken(apiKey, apiSecret, {
        identity: botId,
        name: `ViewBot ${botId}`,
        ttl: '24h',
      });
      
      token.addGrant({
        roomJoin: true,
        room: config.roomName || 'main',
        canPublish: true,
        canSubscribe: false,
      });
      
      const jwt = await token.toJwt();
      
      // Get video file path
      const videoFile = config.videoFile || '/root/onestreamer/server/uploads/test_10sec.mp4';
      
      // Check if video file exists
      await fs.access(videoFile);
      
      console.log(`📹 LIVEKIT NODE VIEWBOT ${botId}: Video file: ${videoFile}`);
      
      // Create WHIP endpoint URL with token
      const serverUrl = process.env.LIVEKIT_URL || 'wss://onestreamer.live:7880';
      const whipUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://') + '/rtc';
      
      // Use FFmpeg with WHIP output
      console.log(`🎬 LIVEKIT NODE VIEWBOT ${botId}: Starting FFmpeg with WHIP output...`);
      
      const ffmpegArgs = [
        '-re', // Read input at native frame rate
        '-stream_loop', '-1', // Loop the video indefinitely
        '-i', videoFile,
        '-c:v', 'libx264', // H.264 video codec
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '1M', // Video bitrate
        '-maxrate', '1M',
        '-bufsize', '2M',
        '-pix_fmt', 'yuv420p',
        '-g', '30', // GOP size (keyframe interval)
        '-c:a', 'libopus', // Opus audio codec for WebRTC
        '-b:a', '96k', // Audio bitrate
        '-ar', '48000', // Audio sample rate
        '-ac', '2', // Stereo audio
        '-f', 'whip', // WHIP output format
        '-authorization', `Bearer ${jwt}`, // Pass token as authorization
        whipUrl
      ];
      
      console.log(`🚀 LIVEKIT NODE VIEWBOT ${botId}: FFmpeg command:`);
      console.log(`ffmpeg ${ffmpegArgs.slice(0, -2).join(' ')} [TOKEN] ${whipUrl}`);
      
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      // Handle FFmpeg output
      let streamingStarted = false;
      
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        
        // Log errors
        if (output.includes('error') || output.includes('Error')) {
          console.error(`❌ VIEWBOT ${botId} FFmpeg error:`, output);
        }
        
        // Check if streaming started
        if (output.includes('Output #0, whip') || output.includes('Sending WHIP')) {
          if (!streamingStarted) {
            console.log(`✅ VIEWBOT ${botId}: FFmpeg streaming to WHIP`);
            streamingStarted = true;
          }
        }
        
        // Log progress periodically
        if (output.includes('frame=')) {
          const frameMatch = output.match(/frame=\s*(\d+)/);
          if (frameMatch && parseInt(frameMatch[1]) % 300 === 0) {
            console.log(`📊 VIEWBOT ${botId}: Streaming... (frame ${frameMatch[1]})`);
          }
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        console.error(`❌ FFmpeg process error for ${botId}:`, error);
        this.bots.delete(botId);
      });
      
      ffmpegProcess.on('exit', (code, signal) => {
        console.log(`🛑 FFmpeg process for ${botId} exited (code: ${code}, signal: ${signal})`);
        this.bots.delete(botId);
      });
      
      // Store bot info
      const bot = {
        id: botId,
        ffmpegProcess: ffmpegProcess,
        videoFile: videoFile,
        isStreaming: false
      };
      
      this.bots.set(botId, bot);
      
      // Wait a bit for streaming to start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      if (streamingStarted) {
        bot.isStreaming = true;
        console.log(`✅ LIVEKIT NODE VIEWBOT ${botId}: Streaming started successfully!`);
        
        return {
          success: true,
          botId: botId,
          message: 'ViewBot streaming started'
        };
      } else {
        // If streaming didn't start, clean up
        ffmpegProcess.kill('SIGTERM');
        this.bots.delete(botId);
        
        return {
          success: false,
          message: 'Failed to start streaming - check if FFmpeg supports WHIP output'
        };
      }
      
    } catch (error) {
      console.error(`❌ LIVEKIT NODE VIEWBOT: Failed to create ViewBot:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }
  
  /**
   * Stop a ViewBot
   */
  async stopViewBot(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      return {
        success: false,
        message: 'ViewBot not found'
      };
    }
    
    try {
      console.log(`⏹️ LIVEKIT NODE VIEWBOT: Stopping ${botId}`);
      
      // Kill FFmpeg process
      if (bot.ffmpegProcess) {
        bot.ffmpegProcess.kill('SIGTERM');
        
        // Wait a bit for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      bot.isStreaming = false;
      this.bots.delete(botId);
      
      console.log(`✅ LIVEKIT NODE VIEWBOT ${botId}: Stopped`);
      
      return {
        success: true,
        message: 'ViewBot stopped'
      };
      
    } catch (error) {
      console.error(`❌ LIVEKIT NODE VIEWBOT: Failed to stop ViewBot:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }
  
  /**
   * Get ViewBot status
   */
  async getStatus(botId) {
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
  
  /**
   * Clean up all ViewBots
   */
  async cleanup() {
    console.log('🧹 Cleaning up all LiveKit Node ViewBots');
    
    for (const botId of this.bots.keys()) {
      await this.stopViewBot(botId);
    }
    
    console.log('✅ All ViewBots cleaned up');
  }
}

module.exports = ViewBotLiveKitNode;