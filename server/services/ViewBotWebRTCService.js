const wrtc = require('@roamhq/wrtc');
const { createCanvas } = require('canvas');
const { v4: uuidv4 } = require('uuid');

/**
 * ViewBot service using native WebRTC with server-side media generation
 * This provides perfect A/V sync by generating media in a single pipeline
 */
class ViewBotWebRTCService {
  constructor(mediasoupService) {
    this.mediasoupService = mediasoupService;
    this.activeBots = new Map();
    this.frameRate = 30;
    this.sampleRate = 48000;
    this.audioChannels = 2;
  }

  /**
   * Creates a new ViewBot with WebRTC peer connection
   */
  async createViewBot(config = {}) {
    const botId = `webrtc-viewbot-${uuidv4()}`;
    
    console.log(`🤖 Creating WebRTC ViewBot: ${botId}`);
    
    const bot = {
      id: botId,
      config: {
        pattern: config.pattern || 'testsrc2',
        width: config.width || 1280,
        height: config.height || 720,
        frameRate: config.frameRate || this.frameRate,
        customText: config.customText || 'ViewBot Stream',
        ...config
      },
      peerConnection: null,
      videoTrack: null,
      audioTrack: null,
      canvas: null,
      audioContext: null,
      mediaStream: null,
      running: false,
      startTime: null
    };

    try {
      await this.initializeBot(bot);
      this.activeBots.set(botId, bot);
      
      console.log(`✅ WebRTC ViewBot created: ${botId}`);
      return {
        success: true,
        botId,
        message: 'WebRTC ViewBot created successfully'
      };
    } catch (error) {
      console.error(`❌ Failed to create WebRTC ViewBot:`, error);
      await this.cleanup(bot);
      return {
        success: false,
        message: `Failed to create ViewBot: ${error.message}`
      };
    }
  }

  /**
   * Initialize bot with WebRTC components
   */
  async initializeBot(bot) {
    console.log(`🔧 Initializing WebRTC components for ${bot.id}`);
    
    // Create WebRTC peer connection
    bot.peerConnection = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // Create canvas for video generation
    bot.canvas = createCanvas(bot.config.width, bot.config.height);
    bot.context = bot.canvas.getContext('2d');

    // Initialize synchronized A/V tracks
    await this.initializeSynchronizedTracks(bot);

    // Create media stream
    bot.mediaStream = new wrtc.MediaStream([bot.videoTrack, bot.audioTrack]);
    
    // Add tracks to peer connection
    bot.peerConnection.addTrack(bot.videoTrack, bot.mediaStream);
    bot.peerConnection.addTrack(bot.audioTrack, bot.mediaStream);

    console.log(`✅ WebRTC components initialized for ${bot.id}`);
  }

  /**
   * Initialize synchronized A/V tracks with shared timing
   */
  async initializeSynchronizedTracks(bot) {
    console.log(`🎨 Setting up synchronized A/V tracks for ${bot.id}`);
    
    // Create track sources
    const videoSource = new wrtc.nonstandard.RTCVideoSource();
    const audioSource = new wrtc.nonstandard.RTCAudioSource();
    
    bot.videoTrack = videoSource.createTrack();
    bot.audioTrack = audioSource.createTrack();
    
    // Synchronized timing parameters
    const audioFrameDurationMs = 10; // 10ms audio frames (standard)
    const videoFrameDurationMs = 1000 / bot.config.frameRate; // e.g., 33.33ms for 30fps
    const samplesPerAudioFrame = Math.floor(this.sampleRate * audioFrameDurationMs / 1000);
    
    // Shared timing state
    let globalTimestamp = 0; // Microseconds since start
    let audioSampleIndex = 0;
    let videoFrameIndex = 0;
    let nextVideoTime = 0;
    let nextAudioTime = 0;
    
    console.log(`🔊 Audio: ${samplesPerAudioFrame} samples per ${audioFrameDurationMs}ms frame`);
    console.log(`📺 Video: ${videoFrameDurationMs.toFixed(2)}ms per frame (${bot.config.frameRate}fps)`);
    
    // Master clock running at audio rate (10ms intervals)
    bot.masterClock = setInterval(() => {
      if (!bot.running) return;
      
      const currentTime = Date.now();
      const elapsedMs = bot.startTime ? currentTime - bot.startTime : 0;
      globalTimestamp = elapsedMs * 1000; // Convert to microseconds
      
      // Generate audio frame (every 10ms)
      this.generateSynchronizedAudio(audioSource, bot, audioSampleIndex, globalTimestamp, samplesPerAudioFrame);
      audioSampleIndex += samplesPerAudioFrame;
      nextAudioTime += audioFrameDurationMs;
      
      // Generate video frame when needed
      if (elapsedMs >= nextVideoTime) {
        this.generateSynchronizedVideo(videoSource, bot, videoFrameIndex, globalTimestamp);
        videoFrameIndex++;
        nextVideoTime += videoFrameDurationMs;
      }
      
    }, audioFrameDurationMs);

    console.log(`✅ Synchronized A/V tracks initialized for ${bot.id}`);
  }

  /**
   * Generate synchronized audio frame
   */
  generateSynchronizedAudio(audioSource, bot, sampleIndex, timestamp, samplesPerFrame) {
    const samples = new Int16Array(samplesPerFrame * this.audioChannels);
    const frequency = 440; // A4 note
    
    for (let i = 0; i < samplesPerFrame; i++) {
      const globalSample = sampleIndex + i;
      const sample = Math.sin(2 * Math.PI * frequency * globalSample / this.sampleRate) * 0.1 * 32767;
      samples[i * this.audioChannels] = sample; // Left channel
      samples[i * this.audioChannels + 1] = sample; // Right channel
    }
    
    audioSource.onData({
      samples: samples.buffer,
      sampleRate: this.sampleRate,
      bitsPerSample: 16,
      channelCount: this.audioChannels,
      numberOfFrames: samplesPerFrame
    });
  }

  /**
   * Generate synchronized video frame
   */
  generateSynchronizedVideo(videoSource, bot, frameIndex, timestamp) {
    const frame = this.generateVideoFrame(bot, frameIndex, timestamp);
    if (frame) {
      videoSource.onFrame(frame);
    }
  }

  /**
   * Initialize video track with canvas-based frame generation (legacy method)
   */
  async initializeVideoTrack(bot) {
    console.log(`🎨 Setting up video track for ${bot.id}`);
    
    // Create video track source
    const source = new wrtc.nonstandard.RTCVideoSource();
    bot.videoTrack = source.createTrack();
    bot.videoSource = source;

    console.log(`✅ Video track initialized for ${bot.id}`);
  }

  /**
   * Initialize audio track with tone generation (legacy method)
   */
  async initializeAudioTrack(bot) {
    console.log(`🔊 Setting up audio track for ${bot.id}`);
    
    // Create audio track source
    const source = new wrtc.nonstandard.RTCAudioSource();
    bot.audioTrack = source.createTrack();
    bot.audioSource = source;

    console.log(`✅ Audio track initialized for ${bot.id}`);
  }

  /**
   * Generate a single video frame with synchronized timing
   */
  generateVideoFrame(bot, frameIndex = 0, timestamp = null) {
    const { canvas, context, config, startTime } = bot;
    
    // Clear canvas
    context.fillStyle = '#000000';
    context.fillRect(0, 0, config.width, config.height);
    
    const now = timestamp ? timestamp / 1000000 : Date.now(); // Convert from microseconds if provided
    const elapsed = startTime ? (now - startTime) / 1000 : frameIndex / config.frameRate;
    
    switch (config.pattern) {
      case 'testsrc2':
        this.drawTestPattern(context, config, elapsed, frameIndex);
        break;
      case 'color-bars':
        this.drawColorBars(context, config, frameIndex);
        break;
      case 'custom-text':
        this.drawCustomText(context, config, elapsed, frameIndex);
        break;
      default:
        this.drawTestPattern(context, config, elapsed, frameIndex);
    }
    
    // Convert canvas to frame - need to convert RGBA to I420 format
    const imageData = context.getImageData(0, 0, config.width, config.height);
    const rgbaData = new Uint8ClampedArray(imageData.data.buffer);
    
    // Convert RGBA to I420 (YUV420p)
    const i420Data = this.convertRGBAToI420(rgbaData, config.width, config.height);
    
    return {
      width: config.width,
      height: config.height,
      data: i420Data,
      rotation: 0,
      timestamp: timestamp || (now * 1000) // Use provided timestamp for sync
    };
  }

  /**
   * Convert RGBA data to I420 format
   */
  convertRGBAToI420(rgbaData, width, height) {
    const ySize = width * height;
    const uvSize = Math.floor(width / 2) * Math.floor(height / 2);
    const i420Data = new Uint8Array(ySize + 2 * uvSize);
    
    let yOffset = 0;
    let uOffset = ySize;
    let vOffset = ySize + uvSize;
    
    // Convert RGBA to YUV
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4;
        const r = rgbaData[pixelIndex];
        const g = rgbaData[pixelIndex + 1];
        const b = rgbaData[pixelIndex + 2];
        
        // Y component
        const yVal = Math.floor(0.299 * r + 0.587 * g + 0.114 * b);
        i420Data[yOffset++] = Math.max(0, Math.min(255, yVal));
        
        // U and V components (subsampled)
        if (x % 2 === 0 && y % 2 === 0) {
          const uVal = Math.floor(-0.169 * r - 0.331 * g + 0.5 * b + 128);
          const vVal = Math.floor(0.5 * r - 0.419 * g - 0.081 * b + 128);
          
          i420Data[uOffset++] = Math.max(0, Math.min(255, uVal));
          i420Data[vOffset++] = Math.max(0, Math.min(255, vVal));
        }
      }
    }
    
    return i420Data;
  }

  /**
   * Draw test pattern with moving elements and sync indicators
   */
  drawTestPattern(context, config, elapsed, frameIndex = 0) {
    const { width, height } = config;
    
    // Gradient background
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#ff0000');
    gradient.addColorStop(0.5, '#00ff00');
    gradient.addColorStop(1, '#0000ff');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    
    // Moving circle (position based on frame index for consistent movement)
    const normalizedTime = frameIndex / config.frameRate;
    const x = (Math.sin(normalizedTime * 0.5) + 1) * width * 0.4 + width * 0.1;
    const y = (Math.cos(normalizedTime * 0.3) + 1) * height * 0.4 + height * 0.1;
    
    context.beginPath();
    context.arc(x, y, 50, 0, 2 * Math.PI);
    context.fillStyle = 'white';
    context.fill();
    context.strokeStyle = 'black';
    context.lineWidth = 3;
    context.stroke();
    
    // Synchronized frame counter
    context.font = '48px Arial';
    context.fillStyle = 'white';
    context.strokeStyle = 'black';
    context.lineWidth = 2;
    const frameText = `Frame: ${frameIndex}`;
    context.strokeText(frameText, 50, height - 150);
    context.fillText(frameText, 50, height - 150);
    
    // Audio sync indicator (flashing bar based on audio phase)
    const audioPhase = (frameIndex * 44.1) % 48000; // Approximate audio sample position
    const barIntensity = Math.sin(2 * Math.PI * 440 * audioPhase / 48000) * 0.5 + 0.5;
    const barHeight = barIntensity * 100;
    
    context.fillStyle = `rgb(${Math.floor(255 * barIntensity)}, 255, 0)`;
    context.fillRect(width - 100, height - 150 - barHeight, 50, barHeight);
    
    // Timestamp
    context.font = '32px Arial';
    context.fillStyle = 'white';
    const timeText = `Time: ${elapsed.toFixed(2)}s`;
    context.strokeText(timeText, 50, height - 100);
    context.fillText(timeText, 50, height - 100);
    
    // Sync status
    context.font = '24px Arial';
    const syncText = `A/V SYNC: ${frameIndex}/${Math.floor(audioPhase / 480)}`;
    context.strokeText(syncText, 50, height - 50);
    context.fillText(syncText, 50, height - 50);
  }

  /**
   * Draw SMPTE color bars with frame counter
   */
  drawColorBars(context, config, frameIndex = 0) {
    const { width, height } = config;
    const colors = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const barWidth = width / colors.length;
    
    colors.forEach((color, i) => {
      context.fillStyle = color;
      context.fillRect(i * barWidth, 0, barWidth, height);
    });
    
    // Add text overlay with frame counter
    context.font = '64px Arial';
    context.fillStyle = 'black';
    context.strokeStyle = 'white';
    context.lineWidth = 3;
    const text = `SMPTE Color Bars - Frame ${frameIndex}`;
    const textWidth = context.measureText(text).width;
    const x = (width - textWidth) / 2;
    const y = height / 2;
    context.strokeText(text, x, y);
    context.fillText(text, x, y);
  }

  /**
   * Draw custom text with frame-accurate timing
   */
  drawCustomText(context, config, elapsed, frameIndex = 0) {
    const { width, height } = config;
    
    // Background color
    context.fillStyle = config.backgroundColor || '#000080';
    context.fillRect(0, 0, width, height);
    
    // Custom text
    context.font = `${config.fontSize || 72}px Arial`;
    context.fillStyle = config.textColor || 'white';
    context.strokeStyle = 'black';
    context.lineWidth = 2;
    
    const text = config.customText || 'ViewBot Stream';
    const textWidth = context.measureText(text).width;
    const x = (width - textWidth) / 2;
    const y = height / 2;
    
    context.strokeText(text, x, y);
    context.fillText(text, x, y);
    
    // Subtitle with frame-accurate timing
    context.font = '48px Arial';
    const subtitle = `Frame: ${frameIndex} | Time: ${elapsed.toFixed(2)}s`;
    const subtitleWidth = context.measureText(subtitle).width;
    const subX = (width - subtitleWidth) / 2;
    const subY = y + 100;
    
    context.strokeText(subtitle, subX, subY);
    context.fillText(subtitle, subX, subY);
  }

  /**
   * Start ViewBot streaming
   */
  async startViewBot(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: 'ViewBot not found' };
    }

    if (bot.running) {
      return { success: false, message: 'ViewBot already running' };
    }

    try {
      console.log(`🚀 Starting WebRTC ViewBot: ${botId}`);
      
      bot.running = true;
      bot.startTime = Date.now();
      
      // Create offer for MediaSoup integration
      const offer = await bot.peerConnection.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      
      await bot.peerConnection.setLocalDescription(offer);
      
      console.log(`✅ WebRTC ViewBot started: ${botId}`);
      
      return {
        success: true,
        message: 'ViewBot started successfully',
        offer: offer,
        tracks: {
          video: bot.videoTrack.id,
          audio: bot.audioTrack.id
        }
      };
    } catch (error) {
      console.error(`❌ Failed to start ViewBot ${botId}:`, error);
      bot.running = false;
      return {
        success: false,
        message: `Failed to start ViewBot: ${error.message}`
      };
    }
  }

  /**
   * Stop ViewBot streaming
   */
  async stopViewBot(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, message: 'ViewBot not found' };
    }

    console.log(`🛑 Stopping WebRTC ViewBot: ${botId}`);
    
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
    // Stop master clock (replaces individual video/audio intervals)
    if (bot.masterClock) {
      clearInterval(bot.masterClock);
      bot.masterClock = null;
    }
    
    // Legacy cleanup for old separate intervals
    if (bot.videoInterval) {
      clearInterval(bot.videoInterval);
      bot.videoInterval = null;
    }
    
    if (bot.audioInterval) {
      clearInterval(bot.audioInterval);
      bot.audioInterval = null;
    }
    
    if (bot.videoTrack) {
      bot.videoTrack.stop();
      bot.videoTrack = null;
    }
    
    if (bot.audioTrack) {
      bot.audioTrack.stop();
      bot.audioTrack = null;
    }
    
    if (bot.peerConnection) {
      bot.peerConnection.close();
      bot.peerConnection = null;
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
      tracks: {
        video: bot.videoTrack?.readyState || 'ended',
        audio: bot.audioTrack?.readyState || 'ended'
      },
      connection: bot.peerConnection?.connectionState || 'closed'
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
}

module.exports = ViewBotWebRTCService;