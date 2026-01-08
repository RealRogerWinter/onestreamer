/**
 * ViewBotManager.js - Manages both Plain RTP and WebRTC viewbots
 * 
 * This manager allows toggling between:
 * - Plain RTP viewbots (GStreamer-based, desktop only)
 * - WebRTC viewbots (Puppeteer-based, mobile compatible)
 */

const ViewBotSocketClient = require('./ViewBotSocketClient');
const WebRTCViewBot = require('./WebRTCViewBot');
const fs = require('fs').promises;
const path = require('path');

class ViewBotManager {
  constructor(config = {}) {
    // Configuration
    this.config = {
      useWebRTC: config.useWebRTCViewBots || false,
      videoFolder: config.videoFolder || '/root/onestreamer/server/uploads',
      maxConcurrentBots: config.maxConcurrentBots || 5,
      rotationInterval: config.rotationInterval || 60000, // 1 minute default
      ...config
    };
    
    // State
    this.bots = new Map();
    this.activeBots = new Set();
    this.videoFiles = [];
    this.currentVideoIndex = 0;
    this.rotationTimer = null;
    
    console.log(`🤖 ViewBotManager: Initialized with mode: ${this.config.useWebRTC ? 'WebRTC' : 'Plain RTP'}`);
  }
  
  /**
   * Initialize the manager and load video files
   */
  async initialize() {
    console.log(`📦 ViewBotManager: Loading video files from ${this.config.videoFolder}`);
    
    try {
      // Load video files
      const files = await fs.readdir(this.config.videoFolder);
      this.videoFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.mp4', '.webm', '.mkv', '.avi', '.mov'].includes(ext);
      }).map(file => path.join(this.config.videoFolder, file));
      
      console.log(`✅ ViewBotManager: Loaded ${this.videoFiles.length} video files`);
      
      // Start rotation if enabled
      if (this.config.autoRotate) {
        this.startRotation();
      }
      
    } catch (error) {
      console.error(`❌ ViewBotManager: Failed to initialize:`, error);
      throw error;
    }
  }
  
  /**
   * Create a new viewbot
   */
  async createBot(botId, videoFile = null) {
    if (this.bots.has(botId)) {
      console.log(`⚠️ ViewBotManager: Bot ${botId} already exists`);
      return this.bots.get(botId);
    }
    
    // Use provided video file or select next from rotation
    if (!videoFile) {
      videoFile = this.getNextVideoFile();
    }
    
    console.log(`🤖 ViewBotManager: Creating ${this.config.useWebRTC ? 'WebRTC' : 'Plain RTP'} bot ${botId}`);
    
    let bot;
    
    if (this.config.useWebRTC) {
      // Create WebRTC viewbot (mobile compatible)
      bot = new WebRTCViewBot(botId, videoFile);
      await bot.initialize();
    } else {
      // Create Plain RTP viewbot (uses appropriate backend service internally)
      // ViewBotSocketClient will detect if we're using LiveKit or MediaSoup
      // ViewBotSocketClient expects: botId, serverUrl, mediaFile
      const serverUrl = 'https://127.0.0.1:8443';
      bot = new ViewBotSocketClient(botId, serverUrl, videoFile);
      await bot.connect();
    }
    
    this.bots.set(botId, bot);
    console.log(`✅ ViewBotManager: Created bot ${botId}`);
    
    return bot;
  }
  
  /**
   * Start a viewbot streaming
   */
  async startBot(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      console.error(`❌ ViewBotManager: Bot ${botId} not found`);
      throw new Error(`Bot ${botId} not found`);
    }
    
    if (this.activeBots.has(botId)) {
      console.log(`⚠️ ViewBotManager: Bot ${botId} already streaming`);
      return;
    }
    
    console.log(`🎬 ViewBotManager: Starting bot ${botId}`);
    
    await bot.startStreaming();
    this.activeBots.add(botId);
    
    console.log(`✅ ViewBotManager: Bot ${botId} is now streaming`);
  }
  
  /**
   * Stop a viewbot streaming
   */
  async stopBot(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      console.error(`❌ ViewBotManager: Bot ${botId} not found`);
      return;
    }
    
    console.log(`⏹️ ViewBotManager: Stopping bot ${botId}`);
    
    await bot.stopStreaming();
    this.activeBots.delete(botId);
    
    console.log(`✅ ViewBotManager: Bot ${botId} stopped`);
  }
  
  /**
   * Destroy a viewbot completely
   */
  async destroyBot(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      console.log(`⚠️ ViewBotManager: Bot ${botId} not found`);
      return;
    }
    
    console.log(`🗑️ ViewBotManager: Destroying bot ${botId}`);
    
    // Stop if streaming
    if (this.activeBots.has(botId)) {
      await this.stopBot(botId);
    }
    
    // Cleanup
    if (bot.cleanup) {
      await bot.cleanup();
    } else if (bot.disconnect) {
      await bot.disconnect();
    }
    
    this.bots.delete(botId);
    console.log(`✅ ViewBotManager: Bot ${botId} destroyed`);
  }
  
  /**
   * Get next video file for rotation
   */
  getNextVideoFile() {
    if (this.videoFiles.length === 0) {
      console.warn(`⚠️ ViewBotManager: No video files available`);
      return null;
    }
    
    const videoFile = this.videoFiles[this.currentVideoIndex];
    this.currentVideoIndex = (this.currentVideoIndex + 1) % this.videoFiles.length;
    
    return videoFile;
  }
  
  /**
   * Start automatic rotation
   */
  startRotation() {
    console.log(`🔄 ViewBotManager: Starting rotation (interval: ${this.config.rotationInterval}ms)`);
    
    // Stop existing rotation
    this.stopRotation();
    
    // Start first bot
    this.rotateBot();
    
    // Schedule periodic rotation
    this.rotationTimer = setInterval(() => {
      this.rotateBot();
    }, this.config.rotationInterval);
  }
  
  /**
   * Stop automatic rotation
   */
  stopRotation() {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
      console.log(`⏹️ ViewBotManager: Rotation stopped`);
    }
  }
  
  /**
   * Rotate to next bot
   */
  async rotateBot() {
    console.log(`🔄 ViewBotManager: Rotating bots...`);
    
    try {
      // Stop all active bots
      for (const botId of this.activeBots) {
        await this.stopBot(botId);
        await this.destroyBot(botId);
      }
      
      // Create and start new bot
      const botId = `viewbot-${Date.now()}`;
      const videoFile = this.getNextVideoFile();
      
      if (videoFile) {
        await this.createBot(botId, videoFile);
        await this.startBot(botId);
      }
      
    } catch (error) {
      console.error(`❌ ViewBotManager: Rotation error:`, error);
    }
  }
  
  /**
   * Toggle between WebRTC and Plain RTP mode
   */
  async toggleMode(useWebRTC) {
    console.log(`🔄 ViewBotManager: Switching to ${useWebRTC ? 'WebRTC' : 'Plain RTP'} mode`);
    
    // Stop all bots
    for (const botId of this.activeBots) {
      await this.stopBot(botId);
    }
    
    // Destroy all bots
    for (const botId of this.bots.keys()) {
      await this.destroyBot(botId);
    }
    
    // Update config
    this.config.useWebRTC = useWebRTC;
    
    console.log(`✅ ViewBotManager: Mode switched to ${useWebRTC ? 'WebRTC' : 'Plain RTP'}`);
    
    // Restart rotation if it was running
    if (this.rotationTimer) {
      this.startRotation();
    }
    
    // Return result
    return {
      success: true,
      mode: useWebRTC ? 'WebRTC' : 'Plain RTP',
      message: `Switched to ${useWebRTC ? 'WebRTC (mobile compatible)' : 'Plain RTP (desktop only)'} mode`
    };
  }
  
  /**
   * Get manager status
   */
  getStatus() {
    return {
      mode: this.config.useWebRTC ? 'WebRTC' : 'Plain RTP',
      totalBots: this.bots.size,
      activeBots: this.activeBots.size,
      videoFiles: this.videoFiles.length,
      rotationActive: !!this.rotationTimer,
      config: this.config,
      bots: Array.from(this.bots.entries()).map(([id, bot]) => ({
        id,
        active: this.activeBots.has(id),
        status: bot.getStatus ? bot.getStatus() : { isStreaming: bot.isStreaming }
      }))
    };
  }
  
  /**
   * Cleanup all resources
   */
  async cleanup() {
    console.log(`🧹 ViewBotManager: Cleaning up...`);
    
    // Stop rotation
    this.stopRotation();
    
    // Stop and destroy all bots
    for (const botId of this.bots.keys()) {
      await this.destroyBot(botId);
    }
    
    console.log(`✅ ViewBotManager: Cleanup complete`);
  }
}

module.exports = ViewBotManager;