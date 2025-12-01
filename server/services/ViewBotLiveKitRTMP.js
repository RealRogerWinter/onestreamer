/**
 * ViewBotLiveKitRTMP.js - ViewBot implementation using FFmpeg RTMP to LiveKit Ingress
 *
 * Uses FFmpeg to stream video files to LiveKit's RTMP Ingress endpoint
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { RoomServiceClient, IngressInput, IngressVideoEncodingPreset, IngressAudioEncodingPreset } = require('livekit-server-sdk');

class ViewBotLiveKitRTMP {
  constructor(livekitService) {
    this.livekitService = livekitService;
    this.bots = new Map();
    this.videoFolder = '/root/onestreamer/server/uploads';

    // Initialize LiveKit RoomServiceClient
    this.roomService = new RoomServiceClient(
      process.env.LIVEKIT_URL || 'https://onestreamer.live:7880',
      process.env.LIVEKIT_API_KEY || 'REDACTED-LIVEKIT-API-KEY',
      process.env.LIVEKIT_API_SECRET || 'REDACTED-LIVEKIT-API-SECRET'
    );

    console.log('🤖 LIVEKIT RTMP VIEWBOT: Service initialized');
  }

  /**
   * Create and start a ViewBot using FFmpeg RTMP streaming
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
      console.log(`🤖 LIVEKIT RTMP VIEWBOT: Creating ViewBot: ${botId}`);

      // Create RTMP ingress in LiveKit
      const roomName = config.roomName || 'main';
      const participantName = `ViewBot ${botId}`;

      console.log(`📡 Creating RTMP ingress for room: ${roomName}`);

      try {
        const ingress = await this.roomService.createIngress(
          IngressInput.RTMP_INPUT,
          {
            name: `viewbot-${botId}`,
            roomName: roomName,
            participantName: participantName,
            participantIdentity: botId,
            video: {
              preset: IngressVideoEncodingPreset.H264_1080P_30FPS_3_LAYERS
            },
            audio: {
              preset: IngressAudioEncodingPreset.OPUS_STEREO_96KBPS
            }
          }
        );

        console.log(`✅ Created RTMP ingress: ${ingress.ingressId}`);
        console.log(`📺 RTMP URL: ${ingress.url}`);
        console.log(`🔑 Stream Key: ${ingress.streamKey}`);

        // Get video file path
        const videoFile = config.videoFile || '/root/onestreamer/server/uploads/test_10sec.mp4';

        // Check if video file exists
        await fs.access(videoFile);

        console.log(`📹 LIVEKIT RTMP VIEWBOT ${botId}: Video file: ${videoFile}`);

        // Start FFmpeg with RTMP output
        console.log(`🎬 LIVEKIT RTMP VIEWBOT ${botId}: Starting FFmpeg with RTMP output...`);

        const rtmpUrl = `${ingress.url}/${ingress.streamKey}`;

        const ffmpegArgs = [
          '-re', // Read input at native frame rate
          '-stream_loop', '-1', // Loop the video indefinitely
          '-i', videoFile,
          '-c:v', 'libx264', // H.264 video codec
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-b:v', '2M', // Video bitrate
          '-maxrate', '2M',
          '-bufsize', '4M',
          '-pix_fmt', 'yuv420p',
          '-g', '60', // GOP size (keyframe interval)
          '-profile:v', 'high',
          '-level', '4.1',
          '-c:a', 'aac', // AAC audio codec
          '-b:a', '128k', // Audio bitrate
          '-ar', '48000', // Audio sample rate
          '-ac', '2', // Stereo audio
          '-f', 'flv', // FLV format for RTMP
          rtmpUrl
        ];

        console.log(`🚀 LIVEKIT RTMP VIEWBOT ${botId}: FFmpeg command:`);
        console.log(`ffmpeg ${ffmpegArgs.slice(0, -1).join(' ')} [RTMP_URL]`);

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
          if (output.includes('Stream #0') || output.includes('Output #0, flv')) {
            if (!streamingStarted) {
              console.log(`✅ VIEWBOT ${botId}: FFmpeg streaming to RTMP`);
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
          isStreaming: false,
          ingress: ingress
        };

        this.bots.set(botId, bot);

        // Wait a bit for streaming to start
        await new Promise(resolve => setTimeout(resolve, 5000));

        if (streamingStarted) {
          bot.isStreaming = true;
          console.log(`✅ LIVEKIT RTMP VIEWBOT ${botId}: Streaming started successfully!`);

          return {
            success: true,
            botId: botId,
            ingressId: ingress.ingressId,
            message: 'ViewBot streaming started via RTMP ingress'
          };
        } else {
          // If streaming didn't start, clean up
          ffmpegProcess.kill('SIGTERM');
          await this.roomService.deleteIngress(ingress.ingressId);
          this.bots.delete(botId);

          return {
            success: false,
            message: 'Failed to start RTMP streaming'
          };
        }

      } catch (ingressError) {
        // If ingress creation fails, fallback to direct RTMP to LiveKit
        console.log(`⚠️ Ingress API not available, using direct RTMP to LiveKit server`);
        console.log(`Error:`, ingressError.message);

        // Use direct RTMP URL (LiveKit may not have RTMP ingress enabled)
        return {
          success: false,
          message: `LiveKit Ingress not configured. Please enable Ingress in LiveKit config or use alternative streaming method. Error: ${ingressError.message}`
        };
      }

    } catch (error) {
      console.error(`❌ LIVEKIT RTMP VIEWBOT: Failed to create ViewBot:`, error);
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
      console.log(`⏹️ LIVEKIT RTMP VIEWBOT: Stopping ${botId}`);

      // Kill FFmpeg process
      if (bot.ffmpegProcess) {
        bot.ffmpegProcess.kill('SIGTERM');

        // Wait a bit for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Delete ingress
      if (bot.ingress && bot.ingress.ingressId) {
        try {
          await this.roomService.deleteIngress(bot.ingress.ingressId);
          console.log(`🗑️ Deleted ingress: ${bot.ingress.ingressId}`);
        } catch (e) {
          console.log(`⚠️ Could not delete ingress: ${e.message}`);
        }
      }

      bot.isStreaming = false;
      this.bots.delete(botId);

      console.log(`✅ LIVEKIT RTMP VIEWBOT ${botId}: Stopped`);

      return {
        success: true,
        message: 'ViewBot stopped'
      };

    } catch (error) {
      console.error(`❌ LIVEKIT RTMP VIEWBOT: Failed to stop ViewBot:`, error);
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
      videoFile: bot.videoFile,
      ingressId: bot.ingress?.ingressId
    };
  }

  /**
   * Clean up all ViewBots
   */
  async cleanup() {
    console.log('🧹 Cleaning up all LiveKit RTMP ViewBots');

    for (const botId of this.bots.keys()) {
      await this.stopViewBot(botId);
    }

    console.log('✅ All ViewBots cleaned up');
  }
}

module.exports = ViewBotLiveKitRTMP;
