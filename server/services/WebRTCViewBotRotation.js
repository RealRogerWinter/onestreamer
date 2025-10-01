/**
 * WebRTCViewBotRotation.js - Rotation system for WebRTC viewbots
 * 
 * Integrates with existing rotation logic but uses WebRTC viewbots
 * that work with mobile clients
 */

const WebRTCViewBot = require('./WebRTCViewBot');
const ViewBotManager = require('./ViewBotManager');

class WebRTCViewBotRotation {
  constructor(io, streamService) {
    this.io = io;
    this.streamService = streamService;
    this.viewBotManager = null;
    this.currentBot = null;
    this.rotationTimer = null;
    this.videoFiles = [];
    this.currentVideoIndex = 0;
    
    // Settings matching existing rotation system
    this.settings = {
      minRotationInterval: 60000,   // 1 minute
      maxRotationInterval: 300000,  // 5 minutes
      cooldownDuration: 600000,     // 10 minutes
      enabled: true,
      useWebRTC: true  // This is the key difference
    };
    
    // Cooldowns - Map of videoFile -> lastPlayedTimestamp
    this.cooldowns = new Map();
    
    console.log('🌐 WebRTCViewBotRotation: Initialized');
  }
  
  /**
   * Initialize with video files
   */
  async initialize(videoFiles) {
    this.videoFiles = videoFiles;
    console.log(`📦 Loaded ${videoFiles.length} videos for WebRTC rotation`);
    
    // Detect backend to determine if we should use WebRTC mode
    // When LiveKit is enabled, we use Plain RTP mode (ViewBotSocketClient)
    // which internally uses the appropriate backend service
    const useAdapter = process.env.USE_WEBRTC_ADAPTER === 'true';
    const backend = process.env.WEBRTC_BACKEND || 'mediasoup';
    const isLiveKit = useAdapter && backend === 'livekit';
    
    // Initialize ViewBot Manager
    this.viewBotManager = new ViewBotManager({
      // When LiveKit is enabled, use Plain RTP mode (ViewBotSocketClient handles backend)
      // When MediaSoup, use WebRTC mode for browser compatibility
      useWebRTCViewBots: !isLiveKit,  
      videoFolder: '/root/onestreamer/server/uploads'
    });
    
    await this.viewBotManager.initialize();
    
    // Setup event listeners for stream events
    this.setupEventListeners();
    
    if (this.settings.enabled && this.videoFiles.length > 0) {
      await this.startRotation();
    }
  }
  
  /**
   * Setup event listeners for stream coordination
   */
  setupEventListeners() {
    // Listen for video end events from WebRTC viewbots
    if (this.io) {
      this.io.on('connection', (socket) => {
        socket.on('viewbot-video-ended', async (data) => {
          if (data.botId === this.currentBot?.id) {
            console.log(`🔄 WebRTC ViewBot video ended, rotating...`);
            await this.rotateToNextBot();
          }
        });
        
        // Handle stream takeover coordination
        socket.on('viewbot-stream-ready', (data) => {
          if (data.botId === this.currentBot?.id) {
            console.log(`📢 WebRTC ViewBot ${data.botId} stream ready`);
            
            // Notify all clients about new stream
            this.io.emit('stream-ready', {
              streamerId: data.botId,
              isViewBot: true,
              isWebRTC: true,  // Important: This is WebRTC
              streamType: 'webrtc-viewbot',
              hasVideo: true,
              hasAudio: true,
              timestamp: Date.now()
            });
          }
        });
      });
    }
  }
  
  /**
   * Start rotation system
   */
  async startRotation() {
    console.log('🎬 Starting WebRTC viewbot rotation');
    
    // Stop any existing rotation
    await this.stopRotation();
    
    // Start first bot
    await this.rotateToNextBot();
  }
  
  /**
   * Rotate to next viewbot
   */
  async rotateToNextBot() {
    console.log('🔄 Rotating to next WebRTC viewbot');
    
    // Emit stream-ending event for smooth transition
    if (this.currentBot && this.io) {
      this.io.emit('stream-ending', {
        streamerId: this.currentBot.id,
        reason: 'rotation'
      });
    }
    
    // Stop current bot
    await this.stopCurrentBot();
    
    // Select next video respecting cooldowns
    const nextVideo = this.selectNextVideo();
    
    if (!nextVideo) {
      console.log('⚠️ No available videos (all on cooldown)');
      this.scheduleNextRotation(30000);
      return;
    }
    
    // Create new WebRTC viewbot
    const botId = `webrtc-viewbot-${Date.now()}`;
    
    try {
      // Check if stream is available (no real user streaming)
      const currentStreamer = this.streamService?.getCurrentStreamer();
      if (currentStreamer && !currentStreamer.includes('viewbot')) {
        console.log('🚫 Real user is streaming, waiting...');
        this.scheduleNextRotation(60000);
        return;
      }
      
      // Create and start the WebRTC viewbot
      const bot = await this.viewBotManager.createBot(botId, nextVideo);
      
      // The bot will handle stream takeover like a real user
      await this.viewBotManager.startBot(botId);
      
      this.currentBot = { id: botId, videoFile: nextVideo, bot };
      this.cooldowns.set(nextVideo, Date.now());
      
      console.log(`✅ WebRTC ViewBot ${botId} is now streaming`);
      
      // Schedule next rotation
      const interval = this.getRandomInterval();
      this.scheduleNextRotation(interval);
      
    } catch (error) {
      console.error(`❌ Failed to start WebRTC viewbot:`, error);
      this.handleBotError(botId);
    }
  }
  
  /**
   * Select next video respecting cooldowns
   */
  selectNextVideo() {
    const now = Date.now();
    
    // Filter available videos (not on cooldown)
    const availableVideos = this.videoFiles.filter(video => {
      const lastPlayed = this.cooldowns.get(video);
      if (!lastPlayed) return true;
      return (now - lastPlayed) > this.settings.cooldownDuration;
    });
    
    if (availableVideos.length === 0) return null;
    
    // Random selection
    const randomIndex = Math.floor(Math.random() * availableVideos.length);
    return availableVideos[randomIndex];
  }
  
  /**
   * Stop current bot
   */
  async stopCurrentBot() {
    if (!this.currentBot) return;
    
    const botId = this.currentBot.id;
    console.log(`⏹️ Stopping WebRTC viewbot: ${botId}`);
    
    // Emit stream-ended event
    if (this.io) {
      this.io.emit('stream-ended', {
        streamerId: botId,
        streamType: 'webrtc-viewbot'
      });
    }
    
    // Stop via ViewBot Manager
    await this.viewBotManager.stopBot(botId);
    await this.viewBotManager.destroyBot(botId);
    
    // Clear stream service
    if (this.streamService) {
      const currentStreamer = this.streamService.getCurrentStreamer();
      if (currentStreamer === botId) {
        this.streamService.clearStreamer();
      }
    }
    
    this.currentBot = null;
  }
  
  /**
   * Get random rotation interval
   */
  getRandomInterval() {
    const { minRotationInterval, maxRotationInterval } = this.settings;
    const interval = Math.floor(
      Math.random() * (maxRotationInterval - minRotationInterval)
    ) + minRotationInterval;
    console.log(`⏱️ Next rotation in ${Math.round(interval / 1000)} seconds`);
    return interval;
  }
  
  /**
   * Schedule next rotation
   */
  scheduleNextRotation(interval) {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }
    
    if (!this.settings.enabled) return;
    
    this.rotationTimer = setTimeout(() => {
      this.rotateToNextBot();
    }, interval);
  }
  
  /**
   * Handle bot error
   */
  handleBotError(botId) {
    console.error(`🔧 Handling error for WebRTC bot ${botId}`);
    
    // Add cooldown for errored video
    if (this.currentBot?.videoFile) {
      this.cooldowns.set(
        this.currentBot.videoFile, 
        Date.now() + this.settings.cooldownDuration * 2
      );
    }
    
    // Immediately rotate to next bot
    setTimeout(() => {
      this.rotateToNextBot();
    }, 5000);
  }
  
  /**
   * Stop rotation
   */
  async stopRotation() {
    console.log('⏹️ Stopping WebRTC viewbot rotation');
    
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    await this.stopCurrentBot();
  }
  
  /**
   * Force rotation
   */
  async forceRotation() {
    console.log('🔄 Forcing WebRTC viewbot rotation');
    await this.rotateToNextBot();
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      enabled: this.settings.enabled,
      mode: 'WebRTC',
      currentBot: this.currentBot?.id || null,
      currentVideo: this.currentBot?.videoFile || null,
      totalVideos: this.videoFiles.length,
      availableNow: this.videoFiles.filter(video => {
        const lastPlayed = this.cooldowns.get(video);
        if (!lastPlayed) return true;
        return (Date.now() - lastPlayed) > this.settings.cooldownDuration;
      }).length,
      settings: this.settings,
      nextRotation: this.rotationTimer ? 'scheduled' : 'none'
    };
  }
  
  /**
   * Update settings
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    console.log('⚙️ Updated WebRTC rotation settings:', this.settings);
    
    if (newSettings.enabled !== undefined) {
      if (newSettings.enabled && this.videoFiles.length > 0) {
        this.startRotation();
      } else if (!newSettings.enabled) {
        this.stopRotation();
      }
    }
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down WebRTC rotation');
    await this.stopRotation();
    
    if (this.viewBotManager) {
      await this.viewBotManager.cleanup();
    }
  }
}

module.exports = WebRTCViewBotRotation;