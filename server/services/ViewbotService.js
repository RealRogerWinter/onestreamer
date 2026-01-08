const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ViewBotWebRTCService = require('./ViewBotWebRTCService');
const ViewBotLiveKitService = require('./ViewBotLiveKitService');

class ViewbotService {
  constructor(mediasoupService, livekitService) {
    this.mediasoupService = mediasoupService;
    this.livekitService = livekitService;
    this.isViewbotActive = false;
    this.viewbotStreamId = null;
    this.streamStartTime = null;
    this.viewbotProcess = null;
    this.viewbotConfig = {
      type: 'viewbot',
      content: 'color-bars',
      width: 1280,
      height: 720,
      frameRate: 30,
      videoBitrate: '1000k',
      audioBitrate: '128k'
    };
    this.pipelinePath = null;
    this.currentViewbots = new Set();
    // Remove ViewBot limits - allow unlimited ViewBots
    this.maxViewbots = Infinity;
    this.rtmpUrl = null;
    
    // Detect which backend to use
    const useAdapter = process.env.USE_WEBRTC_ADAPTER === 'true';
    const backend = process.env.WEBRTC_BACKEND || 'mediasoup';
    
    if (useAdapter && backend === 'livekit' && livekitService) {
      // Use LiveKit ViewBot service
      this.webrtcService = new ViewBotLiveKitService(livekitService);
      this.backendType = 'livekit';
      console.log('🤖 VIEWBOT: Using LiveKit backend for ViewBots');
    } else {
      // Use MediaSoup ViewBot service (default)
      this.webrtcService = new ViewBotWebRTCService(mediasoupService);
      this.backendType = 'mediasoup';
      console.log('🤖 VIEWBOT: Using MediaSoup backend for ViewBots');
    }
    
    this.useWebRTC = true; // Use WebRTC mode for proper integration
    
    // FFmpeg path for Windows
    this.ffmpegPath = 'C:\\Users\\18084\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
  }

  /**
   * Updates the viewbot configuration for custom content generation
   */
  updateViewbotConfig(newConfig) {
    if (newConfig) {
      console.log('🎨 VIEWBOT: Updating configuration with:', newConfig);
      
      // Map ViewBotClientService config to ViewbotService format
      const mappedConfig = {
        type: 'viewbot',
        width: newConfig.width || 1280,
        height: newConfig.height || 720,
        frameRate: newConfig.frameRate || 30,
        videoBitrate: newConfig.videoBitrate || '1000k',
        audioBitrate: newConfig.audioBitrate || '128k'
      };

      // Handle content type mapping
      if (newConfig.contentType === 'customText') {
        mappedConfig.content = 'custom-text';
        mappedConfig.customText = newConfig.customText;
        mappedConfig.textColor = newConfig.textColor;
        mappedConfig.backgroundColor = newConfig.backgroundColor;
        mappedConfig.fontSize = newConfig.fontSize;
      } else if (newConfig.contentType === 'testPattern') {
        mappedConfig.content = newConfig.testPattern || 'color-bars';
      } else {
        mappedConfig.content = 'color-bars'; // Default fallback
      }

      this.viewbotConfig = { ...this.viewbotConfig, ...mappedConfig };
      console.log('✅ VIEWBOT: Configuration updated to:', this.viewbotConfig);
    }
  }

  async startViewbot(options = {}) {
    if (this.isViewbotActive) {
      return { success: false, message: 'Viewbot is already active' };
    }

    try {
      // Update config if provided
      if (options.config) {
        this.viewbotConfig = {
          ...this.viewbotConfig,
          ...options.config
        };
      }

      this.viewbotStreamId = `viewbot-${uuidv4()}`;
      
      let result;
      
      if (this.useWebRTC) {
        // Use WebRTC ViewBot service for proper A/V sync
        console.log('🤖 VIEWBOT: Starting WebRTC ViewBot...');
        
        // Map content types to WebRTC patterns
        const pattern = this.mapContentToPattern(this.viewbotConfig.content);
        
        const webrtcResult = await this.webrtcService.createViewBot({
          pattern: pattern,
          width: this.viewbotConfig.width,
          height: this.viewbotConfig.height,
          frameRate: this.viewbotConfig.frameRate,
          customText: this.viewbotConfig.customText || 'OneStreamer ViewBot',
          textColor: this.viewbotConfig.textColor,
          backgroundColor: this.viewbotConfig.backgroundColor,
          fontSize: this.viewbotConfig.fontSize
        });
        
        if (!webrtcResult.success) {
          throw new Error(webrtcResult.message);
        }
        
        const startResult = await this.webrtcService.startViewBot(webrtcResult.botId);
        if (!startResult.success) {
          throw new Error(startResult.message);
        }
        
        result = {
          success: true,
          producerInfo: {
            webrtc: true,
            botId: webrtcResult.botId,
            tracks: startResult.tracks,
            offer: startResult.offer
          }
        };
      } else {
        // Fallback to HLS/FFmpeg method
        result = await this.createViewbotProducer();
        if (!result.success) {
          return { success: false, message: result.error };
        }
      }

      this.isViewbotActive = true;
      this.streamStartTime = Date.now();
      
      console.log(`🤖 VIEWBOT: Started viewbot stream ${this.viewbotStreamId} (${this.useWebRTC ? 'WebRTC' : 'HLS'})`);
      
      return {
        success: true,
        message: `Viewbot started with ${this.useWebRTC ? 'WebRTC' : 'HLS'} integration`,
        streamId: this.viewbotStreamId,
        config: this.viewbotConfig,
        hasRealStream: true,
        producerInfo: result.producerInfo,
        mode: this.useWebRTC ? 'webrtc' : 'hls'
      };
    } catch (error) {
      console.error('❌ VIEWBOT: Failed to start viewbot:', error);
      this.cleanup();
      return { success: false, message: error.message };
    }
  }

  /**
   * Map content types to WebRTC patterns
   */
  mapContentToPattern(content) {
    const mapping = {
      'color-bars': 'color-bars',
      'moving-text': 'testsrc2',
      'clock': 'testsrc2',
      'custom-text': 'custom-text',
      'noise': 'testsrc2',
      'gradient': 'testsrc2'
    };
    
    return mapping[content] || 'testsrc2';
  }

  async createViewbotProducer() {
    try {
      console.log('🤖 VIEWBOT: Creating MediaSoup producer for viewbot as normal streamer...');
      
      // Check if MediaSoup is available
      if (!this.mediasoupService) {
        throw new Error('MediaSoup service not available');
      }

      // Step 1: Create transport like a normal user
      console.log('📡 VIEWBOT: Creating WebRTC transport...');
      const transportOptions = await this.mediasoupService.createWebRtcTransport(this.viewbotStreamId);
      console.log('✅ VIEWBOT: Transport created:', transportOptions.id);

      // Step 2: Connect transport with proper DTLS parameters
      console.log('🔗 VIEWBOT: Connecting transport...');
      // Get the actual DTLS parameters from the transport
      const dtlsParameters = transportOptions.dtlsParameters;
      
      if (dtlsParameters) {
        await this.mediasoupService.connectTransport(this.viewbotStreamId, dtlsParameters);
        console.log('✅ VIEWBOT: Transport connected with valid DTLS parameters');
      } else {
        console.log('⚠️ VIEWBOT: No DTLS parameters available, skipping connection');
      }

      // Step 3: Create producers for video and audio
      console.log('🎬 VIEWBOT: Creating video producer...');
      const videoRtpParameters = this.generateVideoRtpParameters();
      const videoProducer = await this.mediasoupService.createProducer(
        this.viewbotStreamId, 
        videoRtpParameters, 
        'video'
      );
      console.log('✅ VIEWBOT: Video producer created:', videoProducer.id);

      console.log('🎤 VIEWBOT: Creating audio producer...');
      const audioRtpParameters = this.generateAudioRtpParameters();
      const audioProducer = await this.mediasoupService.createProducer(
        this.viewbotStreamId,
        audioRtpParameters,
        'audio'
      );
      console.log('✅ VIEWBOT: Audio producer created:', audioProducer.id);

      // Step 4: Start generating synthetic media (simulation)
      await this.startServerSideVideoGenerator();

      return {
        success: true,
        producerInfo: {
          transport: transportOptions,
          videoProducerId: videoProducer.id,
          audioProducerId: audioProducer.id,
          hasVideoGenerator: true,
          hasAudioGenerator: true
        }
      };

    } catch (error) {
      console.error('❌ VIEWBOT: Failed to create MediaSoup producer:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async startServerSideVideoGenerator() {
    console.log('🎨 VIEWBOT: Starting server-side video frame generator...');
    
    // Create a simple frame generation loop
    this.frameGenerator = setInterval(() => {
      this.generateVideoFrame();
    }, 1000 / this.viewbotConfig.frameRate);
    
    console.log(`🎨 VIEWBOT: Video generator running at ${this.viewbotConfig.frameRate} FPS`);
  }

  generateVideoFrame() {
    if (!this.isViewbotActive) {
      return;
    }

    const now = Date.now();
    const uptime = Math.floor((now - this.streamStartTime) / 1000);
    
    // Generate frame data based on content type
    const frameData = {
      timestamp: now,
      uptime,
      frameNumber: Math.floor(uptime * this.viewbotConfig.frameRate),
      content: this.generateFrameContent(uptime),
      resolution: `${this.viewbotConfig.width}x${this.viewbotConfig.height}`,
      type: this.viewbotConfig.content
    };

    // In a real implementation, this would generate actual video frame data
    // For now, we log the frame generation for debugging
    if (frameData.frameNumber % (this.viewbotConfig.frameRate * 5) === 0) {
      console.log(`🎨 VIEWBOT: Generated frame ${frameData.frameNumber} (${frameData.content.substring(0, 50)}...)`);
    }

    return frameData;
  }

  generateFrameContent(uptime) {
    switch (this.viewbotConfig.content) {
      case 'moving-text':
        return `OneStreamer Test Stream - Uptime: ${uptime}s - Frame: ${Math.floor(uptime * this.viewbotConfig.frameRate)}`;
      case 'clock':
        return `Current Time: ${new Date().toLocaleTimeString()} - Date: ${new Date().toLocaleDateString()}`;
      case 'color-bars':
        return `SMPTE Color Bars - Frame ${Math.floor(uptime * this.viewbotConfig.frameRate)}`;
      case 'noise':
        return `Random Noise Pattern - Seed: ${Math.random().toString(36).substring(7)}`;
      case 'gradient':
        return `Linear Gradient Animation - Position: ${(uptime * 10) % 100}%`;
      default:
        return `Test Pattern - Uptime: ${uptime}s`;
    }
  }

  async createSyntheticMediaStream() {
    try {
      console.log('🎬 VIEWBOT: Creating synthetic media stream...');

      // Check if FFmpeg is available
      const ffmpegAvailable = await this.checkFFmpegAvailability();
      
      if (!ffmpegAvailable) {
        console.log('⚠️ VIEWBOT: FFmpeg not available, using simulated stream');
        return await this.createSimulatedStream();
      }

      // Create named pipe for video data
      this.pipelinePath = path.join(__dirname, '../temp', `viewbot-${Date.now()}.pipe`);
      
      // Ensure temp directory exists
      const tempDir = path.dirname(this.pipelinePath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Generate synthetic video content based on config
      const videoSource = this.generateVideoSource();
      const audioSource = this.generateAudioSource();

      // Start FFmpeg process to generate synthetic stream
      const ffmpegArgs = [
        '-f', 'lavfi',
        '-i', videoSource,
        '-f', 'lavfi', 
        '-i', audioSource,
        '-c:v', 'libvpx',
        '-b:v', this.viewbotConfig.videoBitrate,
        '-c:a', 'libopus',
        '-b:a', this.viewbotConfig.audioBitrate,
        '-f', 'webm',
        '-cluster_size_limit', '2M',
        '-cluster_time_limit', '5100',
        '-content_type', 'video/webm',
        '-live', '1',
        'pipe:1'
      ];

      console.log('🎬 VIEWBOT: Starting FFmpeg with args:', ffmpegArgs.join(' '));

      this.viewbotProcess = spawn(this.ffmpegPath || 'ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.viewbotProcess.stdout.on('data', (data) => {
        // Stream data would be processed here for MediaSoup
        // For now, we simulate the stream generation
        console.log(`📊 VIEWBOT: Generated ${data.length} bytes of media data`);
      });

      this.viewbotProcess.stderr.on('data', (data) => {
        console.log(`🎬 VIEWBOT: FFmpeg: ${data}`);
      });

      this.viewbotProcess.on('close', (code) => {
        console.log(`🎬 VIEWBOT: FFmpeg process closed with code ${code}`);
        if (code !== 0 && this.isViewbotActive) {
          console.error('❌ VIEWBOT: FFmpeg process failed');
          this.cleanup();
        }
      });

      this.viewbotProcess.on('error', (error) => {
        console.error('❌ VIEWBOT: FFmpeg process error:', error);
        this.cleanup();
      });

      // Wait for process to start
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          if (this.viewbotProcess && !this.viewbotProcess.killed) {
            resolve(true);
          } else {
            reject(new Error('FFmpeg process failed to start'));
          }
        }, 1000);
      });

      return { success: true };

    } catch (error) {
      console.error('❌ VIEWBOT: Failed to create synthetic media stream:', error);
      return { success: false, error: error.message };
    }
  }

  async checkFFmpegAvailability() {
    return new Promise((resolve) => {
      const testProcess = spawn(this.ffmpegPath || 'ffmpeg', ['-version'], {
        stdio: ['ignore', 'ignore', 'ignore']
      });

      testProcess.on('close', (code) => {
        resolve(code === 0);
      });

      testProcess.on('error', () => {
        resolve(false);
      });

      // Timeout after 2 seconds
      setTimeout(() => {
        testProcess.kill();
        resolve(false);
      }, 2000);
    });
  }

  async createSimulatedStream() {
    console.log('🎭 VIEWBOT: Creating simulated media stream (no FFmpeg)');
    
    // Create a simulation timer that generates fake data
    this.simulationTimer = setInterval(() => {
      if (this.isViewbotActive) {
        const frameData = this.generateSimulatedFrameData();
        console.log(`🎭 VIEWBOT: Simulated frame generated: ${frameData.timestamp}`);
      }
    }, 1000 / this.viewbotConfig.frameRate);
    
    return { success: true };
  }

  generateSimulatedFrameData() {
    const timestamp = Date.now();
    const uptime = this.streamStartTime ? Math.floor((timestamp - this.streamStartTime) / 1000) : 0;
    
    return {
      type: 'simulated-frame',
      timestamp: new Date(timestamp).toISOString(),
      uptime,
      frameNumber: Math.floor(uptime * this.viewbotConfig.frameRate),
      config: this.viewbotConfig,
      content: this.viewbotConfig.content,
      data: this.generateFrameContentData()
    };
  }

  generateFrameContentData() {
    const { content } = this.viewbotConfig;
    
    switch (content) {
      case 'color-bars':
        return {
          pattern: 'SMPTE color bars',
          colors: ['white', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue', 'black'],
          simulated: true
        };
      case 'noise':
        return {
          pattern: 'random noise',
          seed: Math.random(),
          simulated: true
        };
      case 'gradient':
        return {
          pattern: 'linear gradient',
          direction: 'horizontal',
          colors: ['#ff0000', '#00ff00', '#0000ff'],
          simulated: true
        };
      case 'moving-text':
        return {
          pattern: 'scrolling text',
          text: `OneStreamer Viewbot - Uptime: ${Math.floor((Date.now() - this.streamStartTime) / 1000)}s`,
          position: (Date.now() % 10000) / 100,
          simulated: true
        };
      case 'clock':
        return {
          pattern: 'digital clock',
          time: new Date().toLocaleTimeString(),
          date: new Date().toLocaleDateString(),
          simulated: true
        };
      default:
        return { 
          pattern: 'solid color', 
          color: '#808080',
          simulated: true
        };
    }
  }

  generateVideoSource() {
    const { content, width, height, frameRate, customText, textColor, backgroundColor, fontSize } = this.viewbotConfig;
    
    switch (content) {
      case 'color-bars':
        return `testsrc2=size=${width}x${height}:rate=${frameRate}:duration=3600`;
      
      case 'noise':
        return `noise=size=${width}x${height}:rate=${frameRate}:duration=3600`;
      
      case 'gradient':
        return `gradients=size=${width}x${height}:rate=${frameRate}:duration=3600`;
      
      case 'moving-text':
        const text = `OneStreamer Viewbot - ${new Date().toLocaleTimeString()}`;
        return `color=c=black:size=${width}x${height}:rate=${frameRate}:duration=3600,drawtext=text='${text}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2`;
      
      case 'custom-text':
        const userText = customText || 'Custom Text';
        const userTextColor = (textColor || '#ffffff').replace('#', '');
        const userBgColor = (backgroundColor || '#000000').replace('#', '');
        const userFontSize = fontSize || 48;
        return `color=c=${userBgColor}:size=${width}x${height}:rate=${frameRate}:duration=3600,drawtext=text='${userText}':fontcolor=${userTextColor}:fontsize=${userFontSize}:x=(w-text_w)/2:y=(h-text_h)/2`;
      
      case 'clock':
        return `color=c=navy:size=${width}x${height}:rate=${frameRate}:duration=3600,drawtext=text='%{localtime}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`;
      
      default:
        return `color=c=gray:size=${width}x${height}:rate=${frameRate}:duration=3600`;
    }
  }

  generateAudioSource() {
    // Generate sine wave tone at 440Hz (A note)
    return 'sine=frequency=440:sample_rate=48000:duration=3600';
  }

  generateVideoRtpParameters() {
    const timestamp = Date.now();
    return {
      mid: `0`,
      codecs: [
        {
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
        }
      ],
      headerExtensions: [
        {
          uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
          id: 1
        },
        {
          uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
          id: 4
        },
        {
          uri: 'urn:3gpp:video-orientation',
          id: 11
        }
      ],
      encodings: [
        {
          ssrc: Math.floor(Math.random() * 1000000000),
          maxBitrate: 300000,  // 300kbps - matches regular users for mobile compatibility
          minBitrate: 100000,  // 100kbps minimum
          maxFramerate: this.viewbotConfig.frameRate
        }
      ],
      rtcp: {
        cname: `viewbot-video-${timestamp}`,
        ssrc: Math.floor(Math.random() * 1000000000)
      }
    };
  }

  generateAudioRtpParameters() {
    const timestamp = Date.now();
    return {
      mid: `1`,
      codecs: [
        {
          mimeType: 'audio/opus',
          payloadType: 111,
          clockRate: 48000,
          channels: 2,
          parameters: {
            'minptime': '10',
            'useinbandfec': '1'
          },
          rtcpFeedback: []
        }
      ],
      headerExtensions: [
        {
          uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
          id: 1
        },
        {
          uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
          id: 10
        }
      ],
      encodings: [
        {
          ssrc: Math.floor(Math.random() * 1000000000),
          maxBitrate: 128000
        }
      ],
      rtcp: {
        cname: `viewbot-audio-${timestamp}`,
        ssrc: Math.floor(Math.random() * 1000000000)
      }
    };
  }

  async stopViewbot() {
    if (!this.isViewbotActive) {
      return { success: false, message: 'No active viewbot to stop' };
    }

    const stoppedStreamId = this.viewbotStreamId;
    
    try {
      if (this.useWebRTC) {
        // Stop WebRTC ViewBot
        const webrtcBots = this.webrtcService.listViewBots();
        for (const bot of webrtcBots) {
          if (bot.running) {
            await this.webrtcService.stopViewBot(bot.botId);
            await this.webrtcService.removeViewBot(bot.botId);
          }
        }
      }
      
      await this.cleanup();
      
      return {
        success: true,
        message: 'Viewbot stopped',
        streamId: stoppedStreamId
      };
    } catch (error) {
      console.error('❌ VIEWBOT: Error stopping viewbot:', error);
      return {
        success: false,
        message: 'Error stopping viewbot: ' + error.message
      };
    }
  }

  async cleanup() {
    console.log('🧹 VIEWBOT: Cleaning up viewbot resources...');
    
    this.isViewbotActive = false;
    
    // Stop simulation timer
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
      console.log('⏹️ VIEWBOT: Simulation timer stopped');
    }
    
    // Stop FFmpeg process
    if (this.viewbotProcess && !this.viewbotProcess.killed) {
      try {
        this.viewbotProcess.kill('SIGTERM');
        
        // Wait for graceful shutdown
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (!this.viewbotProcess.killed) {
              console.log('🔪 VIEWBOT: Force killing FFmpeg process');
              this.viewbotProcess.kill('SIGKILL');
            }
            resolve(true);
          }, 3000);
          
          this.viewbotProcess.on('exit', () => {
            clearTimeout(timeout);
            resolve(true);
          });
        });
      } catch (error) {
        console.warn('⚠️ VIEWBOT: Error stopping FFmpeg process:', error);
      }
      
      this.viewbotProcess = null;
    }
    
    // Clean up MediaSoup resources
    if (this.viewbotStreamId && this.mediasoupService) {
      try {
        await this.mediasoupService.cleanupSocketResources(this.viewbotStreamId);
        console.log('✅ VIEWBOT: MediaSoup resources cleaned up');
      } catch (error) {
        console.warn('⚠️ VIEWBOT: Error cleaning up MediaSoup resources:', error);
      }
    }
    
    // Clean up pipeline file
    if (this.pipelinePath && fs.existsSync(this.pipelinePath)) {
      try {
        fs.unlinkSync(this.pipelinePath);
      } catch (error) {
        console.warn('⚠️ VIEWBOT: Error removing pipeline file:', error);
      }
    }
    
    // Reset state
    this.viewbotStreamId = null;
    this.streamStartTime = null;
    this.pipelinePath = null;
    this.currentViewbots.clear();
    
    console.log('✅ VIEWBOT: Cleanup completed');
  }

  getViewbotStatus() {
    let processStatus = 'stopped';
    let webrtcStatus = null;
    
    if (this.useWebRTC && this.isViewbotActive) {
      const webrtcBots = this.webrtcService.listViewBots();
      const runningBots = webrtcBots.filter(bot => bot.running);
      processStatus = runningBots.length > 0 ? 'webrtc' : 'stopped';
      
      webrtcStatus = {
        totalBots: webrtcBots.length,
        runningBots: runningBots.length,
        bots: webrtcBots.map(bot => ({
          id: bot.botId,
          running: bot.running,
          uptime: bot.uptime,
          videoTrack: bot.tracks?.video,
          audioTrack: bot.tracks?.audio,
          connection: bot.connection
        }))
      };
    } else if (this.viewbotProcess) {
      processStatus = 'running';
    } else if (this.simulationTimer) {
      processStatus = 'simulation';
    }
    
    return {
      isActive: this.isViewbotActive,
      streamId: this.viewbotStreamId,
      startTime: this.streamStartTime,
      duration: this.streamStartTime ? Date.now() - this.streamStartTime : 0,
      config: this.viewbotConfig,
      activeViewbots: this.currentViewbots.size,
      maxViewbots: '∞', // Unlimited ViewBots
      hasMediaSoupProducer: this.isViewbotActive && this.mediasoupService && this.mediasoupService.hasActiveProducer(),
      processStatus: processStatus,
      mode: this.useWebRTC ? 'webrtc' : 'hls',
      webrtcStatus: webrtcStatus
    };
  }

  updateViewbotConfig(config) {
    const allowedTypes = ['viewbot'];
    const allowedContent = ['color-bars', 'noise', 'gradient', 'moving-text', 'clock'];

    if (config.type && !allowedTypes.includes(config.type)) {
      return { success: false, message: 'Invalid viewbot type' };
    }

    if (config.content && !allowedContent.includes(config.content)) {
      return { success: false, message: 'Invalid viewbot content type' };
    }

    // Validate resolution
    if (config.width && (config.width < 320 || config.width > 1920)) {
      return { success: false, message: 'Width must be between 320 and 1920' };
    }

    if (config.height && (config.height < 240 || config.height > 1080)) {
      return { success: false, message: 'Height must be between 240 and 1080' };
    }

    // Validate frame rate
    if (config.frameRate && (config.frameRate < 15 || config.frameRate > 60)) {
      return { success: false, message: 'Frame rate must be between 15 and 60' };
    }

    // Update configuration
    this.viewbotConfig = {
      ...this.viewbotConfig,
      ...config
    };

    return {
      success: true,
      message: 'Viewbot configuration updated',
      config: this.viewbotConfig
    };
  }

  isViewbotStream(streamId) {
    return streamId && streamId.startsWith('viewbot-');
  }

  getViewbotMetrics() {
    if (!this.isViewbotActive) {
      return null;
    }

    const now = Date.now();
    const duration = now - this.streamStartTime;
    const frames = Math.floor(duration / 1000 * this.viewbotConfig.frameRate);

    return {
      streamId: this.viewbotStreamId,
      duration,
      totalFrames: frames,
      frameRate: this.viewbotConfig.frameRate,
      resolution: `${this.viewbotConfig.width}x${this.viewbotConfig.height}`,
      videoBitrate: this.viewbotConfig.videoBitrate,
      audioBitrate: this.viewbotConfig.audioBitrate,
      lastFrameTime: now,
      activeViewbots: this.currentViewbots.size,
      processStatus: this.viewbotProcess ? 'running' : (this.simulationTimer ? 'simulation' : 'stopped')
    };
  }

  calculateEstimatedBitrate() {
    const { width, height, frameRate } = this.viewbotConfig;
    const pixelsPerFrame = width * height;
    const pixelsPerSecond = pixelsPerFrame * frameRate;
    // More realistic bitrate estimation for VP8 encoding
    const estimatedBitrate = Math.floor((pixelsPerSecond * 0.1) / 1000); // kbps
    return estimatedBitrate;
  }

  // Advanced viewbot management
  async spawnAdditionalViewbot(config = {}) {
    // ViewBot limits removed - allow unlimited creation

    const viewbotId = `viewbot-${uuidv4()}`;
    
    try {
      // Create additional viewbot with different content
      const viewbotConfig = {
        ...this.viewbotConfig,
        ...config,
        content: config.content || 'noise' // Different from main viewbot
      };

      this.currentViewbots.add(viewbotId);
      
      console.log(`🤖 VIEWBOT: Spawned additional viewbot ${viewbotId}`);
      
      return {
        success: true,
        message: 'Additional viewbot spawned',
        viewbotId,
        config: viewbotConfig
      };
    } catch (error) {
      console.error('❌ VIEWBOT: Failed to spawn additional viewbot:', error);
      this.currentViewbots.delete(viewbotId);
      return { success: false, message: error.message };
    }
  }

  async removeViewbot(viewbotId) {
    if (!this.currentViewbots.has(viewbotId)) {
      return { success: false, message: 'Viewbot not found' };
    }

    this.currentViewbots.delete(viewbotId);
    
    return {
      success: true,
      message: 'Viewbot removed',
      viewbotId
    };
  }

  // Takeover handling
  async handleTakeover(newStreamerId) {
    console.log(`🔄 VIEWBOT: Handling takeover by ${newStreamerId}`);
    
    if (this.isViewbotActive) {
      // Gracefully stop viewbot when taken over
      await this.stopViewbot();
      console.log('🔄 VIEWBOT: Viewbot stopped due to takeover');
    }
    
    return { success: true, message: 'Viewbot gracefully handled takeover' };
  }

  // Health check for viewbot process
  isHealthy() {
    const isProcessHealthy = this.viewbotProcess ? 
      !this.viewbotProcess.killed : 
      (this.simulationTimer !== null && this.simulationTimer !== undefined);
    
    return {
      active: this.isViewbotActive,
      processRunning: isProcessHealthy,
      simulationMode: !this.viewbotProcess && !!this.simulationTimer,
      ffmpegMode: this.viewbotProcess && !this.viewbotProcess.killed,
      mediasoupConnected: this.mediasoupService && this.mediasoupService.hasActiveProducer(),
      uptime: this.streamStartTime ? Date.now() - this.streamStartTime : 0,
      viewbotCount: this.currentViewbots.size
    };
  }
  /**
   * Handle video end from a ViewBot - trigger rotation
   * This method is called by ViewBotClientService when a video ends
   */
  handleVideoEnd(botId) {
    console.log(`🎬 ViewbotService: Handling video end for bot ${botId}`);
    
    // Always trigger rotation on video end - rotation is enabled by default
    console.log(`🔄 ViewbotService: Triggering rotation after video end for ${botId}`);
    
    // Use ViewBotClientService's rotation mechanism directly
    if (this.viewBotClientService && this.viewBotClientService.handleRotation) {
      console.log(`📤 ViewbotService: Delegating rotation to ViewBotClientService`);
      this.viewBotClientService.handleRotation(botId);
    } else {
      // Fallback: stop current bot and start another
      console.log(`🔀 ViewbotService: Using fallback rotation mechanism`);
      
      if (this.viewBotClientService) {
        // Stop the current bot
        const bot = this.viewBotClientService.bots.get(botId);
        if (bot) {
          console.log(`🛑 ViewbotService: Stopping bot ${botId}`);
          bot.stopStreaming();
        }
        
        // Start another random bot after a short delay
        setTimeout(() => {
          const availableBots = Array.from(this.viewBotClientService.bots.values())
            .filter(b => !b.streaming && b.connected && b.botId !== botId);
          
          if (availableBots.length > 0) {
            const randomBot = availableBots[Math.floor(Math.random() * availableBots.length)];
            console.log(`🎲 ViewbotService: Starting random bot ${randomBot.botId} for rotation`);
            randomBot.requestToStream();
          } else {
            console.log(`⚠️ ViewbotService: No available bots for rotation`);
          }
        }, 2000);
      }
    }
  }
  
  /**
   * Start a random ViewBot (used for rotations)
   */
  startRandomViewBot() {
    if (!this.viewBotClientService) return;
    
    const availableBots = Array.from(this.viewBotClientService.bots.values())
      .filter(bot => !bot.streaming && bot.connected);
    
    if (availableBots.length > 0) {
      const randomBot = availableBots[Math.floor(Math.random() * availableBots.length)];
      console.log(`🎲 ViewbotService: Starting random bot ${randomBot.botId} for rotation`);
      randomBot.requestToStream();
    } else {
      console.log(`⚠️ ViewbotService: No available bots for rotation`);
    }
  }
}

module.exports = ViewbotService;