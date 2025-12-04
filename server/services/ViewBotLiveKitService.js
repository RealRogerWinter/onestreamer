/**
 * ViewBot service for LiveKit backend
 * Uses FFmpeg to stream video files to LiveKit via WHIP
 */

const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Disable all non-essential logging for production
const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};

class ViewBotLiveKitService {
  constructor(livekitService) {
    this.livekitService = livekitService;
    this.activeBots = new Map();
    this.roomClient = null;
    this.config = require('../config/webrtc.config').livekit;
    this.videoFiles = [];
    this.currentVideoIndex = 0;
    this.streamService = null; // For real streamer protection
  }

  /**
   * Set StreamService reference for real streamer protection
   */
  setStreamService(streamService) {
    this.streamService = streamService;
    console.log('✅ LIVEKIT VIEWBOT: StreamService registered for real streamer protection');
  }

  /**
   * Check if a real streamer is currently active
   */
  isRealStreamerActive() {
    if (!this.streamService) {
      return false;
    }

    const currentStreamer = this.streamService.getCurrentStreamer();
    if (!currentStreamer) {
      return false;
    }

    // Check if current streamer is NOT a viewbot
    const isViewbot = currentStreamer.startsWith('viewbot-') ||
                      currentStreamer.includes('viewbot') ||
                      currentStreamer.startsWith('bot-');

    return !isViewbot;
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
    // CRITICAL: Check if real streamer is active before creating viewbot
    if (this.isRealStreamerActive()) {
      console.log('🛡️ LIVEKIT VIEWBOT: BLOCKED - Real streamer is active, cannot create viewbot');
      return {
        success: false,
        message: 'Real streamer is active - viewbot creation blocked'
      };
    }

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

      // Register viewbot as current streamer
      if (global.streamService) {
        global.streamService.setStreamer(botId, 'viewbot');
        console.log(`✅ LIVEKIT VIEWBOT: Registered ${botId} as current streamer`);
      }

      // CRITICAL: Emit stream-ready so clients know to switch to this stream
      // LiveKit viewbots don't use socket.io so they can't emit viewbot-stream-ready
      if (global.io) {
        console.log(`📢 LIVEKIT VIEWBOT ${botId}: Emitting stream-ready to all clients`);
        global.io.emit('stream-ready', {
          streamerId: botId,
          newStreamId: botId,
          isViewBot: true,
          streamType: 'viewbot',
          hasVideo: true,
          hasAudio: true,
          producerVerified: true,
          timestamp: Date.now()
        });
      }

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
   * Start streaming to LiveKit via RTMP ingress
   */
  async startFFmpegStream(bot) {
    const { config } = bot;

    // Use RTMP ingress for LiveKit streaming
    console.log(`🎬 LIVEKIT VIEWBOT: Using RTMP ingress for ${bot.id}`);
    return this.startRTMPStream(bot);
  }

  /**
   * Check if video has audio track using ffprobe
   */
  async hasAudioTrack(videoFile) {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoFile
      ]);

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        resolve(output.trim() === 'audio');
      });

      // Timeout after 1 second
      setTimeout(() => {
        ffprobe.kill();
        resolve(false);
      }, 1000);
    });
  }

  /**
   * Start RTMP stream to LiveKit ingress using GStreamer
   */
  async startRTMPStream(bot) {
    const { config } = bot;

    console.log(`📹 LIVEKIT VIEWBOT ${bot.id}: Streaming video via RTMP (GStreamer): ${path.basename(config.videoFile)}`);

    // Check if video has audio
    const hasAudio = await this.hasAudioTrack(config.videoFile);
    console.log(`🔊 LIVEKIT VIEWBOT ${bot.id}: Video has audio: ${hasAudio}`);

    // CRITICAL FIX: Delete old ingress before creating new one (for video rotation)
    // This prevents SIGPIPE errors when the same bot ID tries to create a new ingress
    if (bot.ingressId) {
      try {
        const { IngressClient } = require('livekit-server-sdk');
        const host = this.config.host.startsWith('http')
          ? this.config.host
          : `http://${this.config.host}`;
        const ingressClient = new IngressClient(host, this.config.apiKey, this.config.apiSecret);
        await ingressClient.deleteIngress(bot.ingressId);
        console.log(`🗑️ LIVEKIT VIEWBOT ${bot.id}: Deleted old ingress before video rotation`);
        bot.ingressId = null;
        bot.streamKey = null;
        // Small delay to allow LiveKit to clean up
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.log(`⚠️ LIVEKIT VIEWBOT ${bot.id}: Could not delete old ingress: ${error.message}`);
      }
    }

    // Create ingress for this viewbot
    const ingress = await this.createIngress(bot);
    if (!ingress) {
      throw new Error('Failed to create LiveKit ingress');
    }

    bot.ingressId = ingress.ingressId;
    bot.streamKey = ingress.streamKey;

    const rtmpUrl = `rtmp://127.0.0.1:1935/live/${bot.streamKey}`;

    console.log(`🎥 LIVEKIT VIEWBOT ${bot.id}: Streaming to RTMP URL: ${rtmpUrl}`);

    return new Promise((resolve, reject) => {
      // GStreamer pipeline for RTMP streaming - WORKING CONFIGURATION
      // Increased keyframe frequency (key-int-max=15 = ~0.5s at 30fps) to minimize freeze duration if layer switch occurs

      // Build audio pipeline based on whether video has audio
      const audioPipeline = hasAudio
        ? `d.audio_0 ! queue ! decodebin ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! voaacenc bitrate=${config.audioBitrate * 1000} ! queue ! mux.audio`
        : `audiotestsrc wave=silence ! audio/x-raw,rate=48000,channels=2 ! voaacenc bitrate=${config.audioBitrate * 1000} ! queue ! mux.audio`;

      const pipelineCmd = `filesrc location="${config.videoFile}" ! qtdemux name=d ` +
        `d.video_0 ! queue ! decodebin ! videoconvert ! video/x-raw,format=I420 ! ` +
        `x264enc bitrate=${config.videoBitrate} speed-preset=ultrafast tune=zerolatency key-int-max=15 ! ` +
        `video/x-h264,profile=baseline ! h264parse ! video/x-h264,stream-format=avc ! ` +
        `queue ! mux.video ` +
        audioPipeline + ` ` +
        `flvmux name=mux streamable=true ! rtmpsink location="${rtmpUrl}"`;

      console.log(`🎬 LIVEKIT VIEWBOT ${bot.id}: Starting GStreamer RTMP pipeline (audio: ${hasAudio ? 'real' : 'silent'})`);

      bot.gstreamerProcess = spawn('sh', ['-c', `gst-launch-1.0 -v ${pipelineCmd}`], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      bot.gstreamerProcess.on('error', (error) => {
        console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: GStreamer error:`, error);
        reject(error);
      });

      let streamStarted = false;

      // Monitor both stdout and stderr for GStreamer output
      const handleOutput = (data) => {
        const output = data.toString();

        if (output.includes('ERROR')) {
          console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: GStreamer ERROR:`, output);
          if (!streamStarted) {
            reject(new Error('GStreamer error: ' + output));
          }
        } else if (output.includes('WARNING')) {
          console.warn(`⚠️ LIVEKIT VIEWBOT ${bot.id}: GStreamer WARNING:`, output);
        } else if (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED')) {
          if (!streamStarted) {
            streamStarted = true;
            bot.running = true;
            bot.startTime = Date.now();
            console.log(`✅ LIVEKIT VIEWBOT ${bot.id}: GStreamer RTMP stream started successfully`);

            // Monitor how long it takes for the track to appear in the room
            this.monitorTrackPublishing(bot.id, bot.id, bot.startTime).catch(err => {
              console.error(`❌ Failed to monitor track publishing:`, err);
            });

            resolve();
          }
        }
      };

      bot.gstreamerProcess.stdout.on('data', handleOutput);
      bot.gstreamerProcess.stderr.on('data', handleOutput);

      bot.gstreamerProcess.on('exit', (code, signal) => {
        console.log(`🎬 LIVEKIT VIEWBOT ${bot.id}: GStreamer process ended (code: ${code}, signal: ${signal})`);
        bot.running = false;

        // Auto-restart on video end if still supposed to be running
        if (code === 0 && this.activeBots.has(bot.id)) {
          console.log(`🔄 LIVEKIT VIEWBOT ${bot.id}: Video ended, rotating to next video...`);

          // Get next video file
          const nextVideo = this.getNextVideoFile();
          if (nextVideo) {
            bot.config.videoFile = nextVideo;
            console.log(`🎥 LIVEKIT VIEWBOT ${bot.id}: Next video: ${path.basename(nextVideo)}`);
          }

          setTimeout(() => {
            this.startRTMPStream(bot).catch(err => {
              console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: Failed to restart:`, err);
            });
          }, 1000);
        }
      });

      setTimeout(() => {
        if (!streamStarted) {
          reject(new Error('GStreamer RTMP stream startup timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Create LiveKit ingress for RTMP streaming
   */
  async createIngress(bot) {
    try {
      const { IngressClient, IngressInput } = require('livekit-server-sdk');

      const host = this.config.host.startsWith('http')
        ? this.config.host
        : `http://${this.config.host}`;

      const ingressClient = new IngressClient(host, this.config.apiKey, this.config.apiSecret);

      // WORKING IMPLEMENTATION: Explicit single-layer encoding prevents simulcast layer switching (no freezing)
      // Manually configure single 720p layer at 2500kbps (no simulcast)
      const { TrackSource, IngressVideoOptions, IngressAudioOptions } = require('livekit-server-sdk');

      const ingress = await ingressClient.createIngress(IngressInput.RTMP_INPUT, {
        name: `viewbot-${bot.id}`,
        roomName: this.config.roomName,
        participantIdentity: bot.id,
        participantName: `ViewBot ${bot.id}`,
        // Explicit single layer configuration
        video: {
          source: TrackSource.CAMERA,
          encodingOptions: {
            case: 'options',
            value: {
              videoCodec: 0, // H264
              frameRate: 30,
              layers: [{
                quality: 2, // HIGH
                width: 1280,
                height: 720,
                bitrate: 2500000
              }]
            }
          }
        },
        audio: {
          source: TrackSource.MICROPHONE,
          encodingOptions: {
            case: 'options',
            value: {
              audioCodec: 1, // OPUS
              bitrate: 96000,
              channels: 2,
              disableDtx: false
            }
          }
        }
      });

      console.log(`✅ LIVEKIT VIEWBOT ${bot.id}: Created ingress with stream key: ${ingress.streamKey}`);

      return ingress;
    } catch (error) {
      console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: Failed to create ingress:`, error);
      return null;
    }
  }

  async startGStreamerWHIPStream_OLD(bot) {
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
    this.activeBots.delete(botId);  // Remove from active bots map

    // Deregister viewbot as current streamer
    if (global.streamService && global.streamService.getCurrentStreamer() === botId) {
      global.streamService.clearStreamer();
      console.log(`✅ LIVEKIT VIEWBOT: Deregistered ${botId} as current streamer`);
    }

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

    // Kill streaming process (GStreamer or FFmpeg)
    if (bot.gstreamerProcess || bot.ffmpegProcess) {
      const process = bot.gstreamerProcess || bot.ffmpegProcess;
      const processName = bot.gstreamerProcess ? 'GStreamer' : 'FFmpeg';

      try {
        console.log(`🛑 LIVEKIT VIEWBOT ${bot.id}: Stopping ${processName} process (PID: ${process.pid})...`);

        if (process.pid) {
          try {
            // First, kill all descendant processes by name (more aggressive)
            const { exec } = require('child_process');
            exec(`pkill -TERM -f "gst-launch-1.0.*${bot.streamKey || bot.id}"`, () => {});

            // Also try to kill by parent PID
            exec(`pkill -TERM -P ${process.pid}`, () => {});

            // Kill the parent process
            process.kill('SIGTERM');
          } catch (e) {
            console.log(`⚠️ LIVEKIT VIEWBOT ${bot.id}: Error sending SIGTERM:`, e.message);
          }
        }

        // Give processes time to cleanup gracefully
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Force kill everything that's left
        if (process.pid) {
          try {
            const { exec } = require('child_process');
            // Kill by stream key pattern (most reliable)
            exec(`pkill -KILL -f "gst-launch-1.0.*${bot.streamKey || bot.id}"`, () => {});
            // Kill children by PID
            exec(`pkill -KILL -P ${process.pid}`, () => {});
            // Force kill parent
            process.kill('SIGKILL');
            console.log(`🛑 LIVEKIT VIEWBOT ${bot.id}: Force killed ${processName} process tree`);
          } catch (e) {
            console.log(`⚠️ LIVEKIT VIEWBOT ${bot.id}: Process already terminated`);
          }
        }
      } catch (error) {
        console.error(`❌ LIVEKIT VIEWBOT ${bot.id}: Error killing ${processName}:`, error.message);
      }
      bot.gstreamerProcess = null;
      bot.ffmpegProcess = null;
    }

    // Delete ingress if it was created
    if (bot.ingressId) {
      try {
        const { IngressClient } = require('livekit-server-sdk');
        const host = this.config.host.startsWith('http')
          ? this.config.host
          : `http://${this.config.host}`;
        const ingressClient = new IngressClient(host, this.config.apiKey, this.config.apiSecret);

        await ingressClient.deleteIngress(bot.ingressId);
        console.log(`✅ LIVEKIT VIEWBOT ${bot.id}: Deleted ingress`);
      } catch (error) {
        console.log(`ℹ️ LIVEKIT VIEWBOT ${bot.id}: Failed to delete ingress:`, error.message);
      }
      bot.ingressId = null;
      bot.streamKey = null;
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

  /**
   * FFmpeg fallback - generates test pattern and streams to LiveKit via RTP/WebRTC
   * This is a simpler approach when GStreamer/WHIP is not available
   */
  async startFFmpegFallback(bot) {
    const { config } = bot;

    console.log(`🎬 LIVEKIT VIEWBOT (FFmpeg): Starting test pattern stream for ${bot.id}`);

    return new Promise((resolve, reject) => {
      // Use FFmpeg to generate test pattern with audio
      // Stream it as HLS segments that LiveKit can ingest
      const outputPath = `/tmp/livekit-viewbot-${bot.id}`;

      const ffmpegArgs = [
        // Video input: test pattern or video file
        '-re',
        '-f', 'lavfi',
        '-i', `testsrc=size=${config.width}x${config.height}:rate=${config.frameRate}`,
        // Audio input: sine wave
        '-f', 'lavfi',
        '-i', 'sine=frequency=1000:sample_rate=48000',
        // Video encoding
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', `${config.videoBitrate}k`,
        '-maxrate', `${config.videoBitrate}k`,
        '-bufsize', `${config.videoBitrate * 2}k`,
        '-pix_fmt', 'yuv420p',
        '-g', '30',
        '-keyint_min', '30',
        '-profile:v', 'baseline',
        '-level', '3.1',
        // Audio encoding
        '-c:a', 'aac',
        '-b:a', `${config.audioBitrate}k`,
        '-ar', '48000',
        '-ac', '2',
        // HLS output
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '3',
        '-hls_flags', 'delete_segments',
        `${outputPath}.m3u8`
      ];

      console.log(`🎥 LIVEKIT VIEWBOT (FFmpeg) ${bot.id}: Starting test pattern with HLS output`);

      bot.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let streamStarted = false;

      bot.ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();

        if (output.includes('error') || output.includes('Error')) {
          console.error(`❌ VIEWBOT ${bot.id} FFmpeg error:`, output);
          if (!streamStarted) {
            reject(new Error('FFmpeg error: ' + output));
          }
        }

        // Check if streaming started
        if (output.includes('Opening') || output.includes('muxer')) {
          if (!streamStarted) {
            console.log(`✅ VIEWBOT ${bot.id}: FFmpeg test pattern streaming`);
            streamStarted = true;
            bot.running = true;
            bot.startTime = Date.now();
            resolve();
          }
        }
      });

      bot.ffmpegProcess.on('error', (error) => {
        console.error(`❌ FFmpeg process error for ${bot.id}:`, error);
        if (!streamStarted) {
          reject(error);
        }
      });

      bot.ffmpegProcess.on('exit', (code, signal) => {
        console.log(`🛑 FFmpeg process for ${bot.id} exited (code: ${code}, signal: ${signal})`);
        bot.running = false;
      });

      // Timeout fallback
      setTimeout(() => {
        if (!streamStarted) {
          console.log(`⚠️ VIEWBOT ${bot.id}: FFmpeg may be running but no confirmation received`);
          bot.running = true;
          bot.startTime = Date.now();
          resolve();
        }
      }, 3000);
    });
  }

  /**
   * Monitor how long it takes for a viewbot's track to be published to the room
   */
  async monitorTrackPublishing(botId, participantIdentity, startTime) {
    console.log(`🔍 LIVEKIT VIEWBOT ${botId}: Starting track publishing monitor for ${participantIdentity}`);
    const maxAttempts = 20; // 20 seconds max
    let attempts = 0;

    const checkInterval = setInterval(async () => {
      attempts++;
      console.log(`🔍 LIVEKIT VIEWBOT ${botId}: Checking for tracks (attempt ${attempts}/${maxAttempts})`);

      try {
        const participants = await this.roomClient.listParticipants(this.config.roomName);
        console.log(`🔍 LIVEKIT VIEWBOT ${botId}: Found ${participants.length} participants in room`);
        const participant = participants.find(p => p.identity === participantIdentity);

        if (participant) {
          console.log(`🔍 LIVEKIT VIEWBOT ${botId}: Found participant ${participantIdentity}, checking tracks...`);
          console.log(`🔍 LIVEKIT VIEWBOT ${botId}: Participant tracks:`, participant.tracks.map(t => ({ type: t.type, width: t.width, height: t.height })));

          const videoTracks = participant.tracks.filter(t => t.type === 'video' || t.type === 1);

          if (videoTracks.length > 0) {
            const publishDelay = Date.now() - startTime;
            console.log(`⏱️ LIVEKIT VIEWBOT ${botId}: Video track published to room after ${publishDelay}ms`);
            clearInterval(checkInterval);
            return;
          } else {
            console.log(`🔍 LIVEKIT VIEWBOT ${botId}: Participant found but no video tracks yet`);
          }
        } else {
          console.log(`🔍 LIVEKIT VIEWBOT ${botId}: Participant ${participantIdentity} not found in room yet`);
        }

        if (attempts >= maxAttempts) {
          console.log(`⚠️ LIVEKIT VIEWBOT ${botId}: Track not published after ${maxAttempts} seconds`);
          clearInterval(checkInterval);
        }
      } catch (error) {
        console.error(`❌ Error monitoring track publishing:`, error);
        clearInterval(checkInterval);
      }
    }, 1000); // Check every second
  }
}

module.exports = ViewBotLiveKitService;