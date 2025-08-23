/**
 * ViewBotRotationService - Manages ViewBot rotation using Socket.IO clients
 * Replaces SimpleViewBotMediaSoup with proper client connections
 */

const ViewBotSocketClient = require('./ViewBotSocketClient');
const path = require('path');
const fs = require('fs');

class ViewBotRotationService {
  constructor(serverUrl) {
    this.serverUrl = serverUrl || 'https://127.0.0.1:8443';
    this.bots = [];
    this.currentBot = null;
    this.rotationTimer = null;
    this.cooldowns = new Map();
    this.enabled = false;
    
    // Settings
    this.settings = {
      minRotationInterval: 60000,   // 1 minute
      maxRotationInterval: 180000,  // 3 minutes
      cooldownDuration: 600000      // 10 minutes
    };
    
    console.log('🔄 ViewBotRotationService: Initialized');
  }
  
  /**
   * Initialize with media files
   */
  async initialize() {
    console.log('📦 ViewBotRotationService: Loading media files...');
    
    // Load ALL MP4 files from uploads
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const mp4Files = files.filter(f => f.endsWith('.mp4'));  // No limit, use all MP4 files
      
      mp4Files.forEach((file, index) => {
        this.bots.push({
          id: `viewbot-${index + 1}`,
          name: path.basename(file, '.mp4'),
          mediaFile: path.join(uploadsDir, file),
          client: null
        });
      });
      
      console.log(`📹 Found ${mp4Files.length} video files in uploads folder`);
    }
    
    // Only use bots with real video files, no test patterns
    
    console.log(`✅ ViewBotRotationService: Loaded ${this.bots.length} bots`);
    
    // Start rotation if enabled
    if (this.enabled) {
      await this.startRotation();
    }
  }
  
  /**
   * Start rotation
   */
  async startRotation() {
    console.log('🎬 ViewBotRotationService: Starting rotation...');
    this.enabled = true;
    
    // Stop current bot if any
    await this.stopCurrentBot();
    
    // Start first rotation
    await this.rotateToNextBot();
  }
  
  /**
   * Stop rotation
   */
  async stopRotation() {
    console.log('⏹️ ViewBotRotationService: Stopping rotation...');
    this.enabled = false;
    
    // Clear rotation timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    // Stop current bot
    await this.stopCurrentBot();
  }
  
  /**
   * Rotate to next bot
   */
  async rotateToNextBot() {
    console.log('🔄 ViewBotRotationService: Rotating to next bot...');
    console.log(`🔍 ViewBotRotationService: Current bot before rotation:`, this.currentBot?.id);
    
    try {
      // Stop current bot
      console.log('🔍 ViewBotRotationService: Stopping current bot...');
      await this.stopCurrentBot();
      console.log('🔍 ViewBotRotationService: Current bot stopped');
      
      // Add a small delay to ensure cleanup completes
      await new Promise(resolve => setTimeout(resolve, 200));
      console.log('🔍 ViewBotRotationService: Cleanup delay completed');
      
      // Select next bot
      const nextBot = this.selectNextBot();
      
      if (!nextBot) {
        console.log('⚠️ No available bots (all on cooldown)');
        this.scheduleNextRotation(30000);
        return;
      }
      
      // Start the bot
      await this.startBot(nextBot);
      
      // Schedule next rotation
      const interval = this.getRandomInterval();
      this.scheduleNextRotation(interval);
      
    } catch (error) {
      console.error('❌ Rotation error:', error);
      // Retry in 30 seconds
      this.scheduleNextRotation(30000);
    }
  }
  
  /**
   * Select next bot respecting cooldowns
   */
  selectNextBot() {
    const now = Date.now();
    
    const availableBots = this.bots.filter(bot => {
      // Must have a media file
      if (!bot.mediaFile) {
        console.log(`⚠️ Skipping ${bot.id} - no media file`);
        return false;
      }
      
      // Check cooldown
      const lastPlayed = this.cooldowns.get(bot.id);
      if (!lastPlayed) return true;
      return (now - lastPlayed) > this.settings.cooldownDuration;
    });
    
    if (availableBots.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * availableBots.length);
    return availableBots[randomIndex];
  }
  
  /**
   * Start a bot
   */
  async startBot(bot) {
    console.log(`🚀 ViewBotRotationService: Starting ${bot.id} at ${new Date().toISOString()}`);
    console.log(`🔍 ViewBotRotationService: Current bot before start:`, this.currentBot?.id);
    console.log(`🔍 ViewBotRotationService: Server URL:`, this.serverUrl);
    
    // Create Socket.IO client for this bot
    bot.client = new ViewBotSocketClient(bot.id, this.serverUrl, bot.mediaFile);
    
    try {
      // Connect to server
      console.log(`🔍 ViewBotRotationService: Connecting ${bot.id}...`);
      await bot.client.connect();
      console.log(`🔍 ViewBotRotationService: ${bot.id} connected, starting stream...`);
      
      // Start streaming
      await bot.client.startStreaming();
      
      // Mark as current and update cooldown
      this.currentBot = bot;
      this.cooldowns.set(bot.id, Date.now());
      
      console.log(`✅ ViewBotRotationService: ${bot.id} is now streaming`);
      
    } catch (error) {
      console.error(`❌ Failed to start ${bot.id}:`, error);
      
      // Cleanup on failure
      if (bot.client) {
        bot.client.cleanup();
        bot.client = null;
      }
      
      throw error;
    }
  }
  
  /**
   * Stop current bot
   */
  async stopCurrentBot() {
    if (!this.currentBot) return;
    
    const bot = this.currentBot;
    console.log(`⏹️ ViewBotRotationService: Stopping ${bot.id}...`);
    
    if (bot.client) {
      try {
        await bot.client.stopStreaming();
      } catch (error) {
        console.error(`⚠️ Error stopping ${bot.id}:`, error.message);
      }
      
      // Always cleanup resources
      bot.client.cleanup();
      bot.client = null;
    }
    
    this.currentBot = null;
    console.log(`✅ ViewBotRotationService: ${bot.id} stopped and cleaned up`);
  }
  
  /**
   * Get random interval
   */
  getRandomInterval() {
    const { minRotationInterval, maxRotationInterval } = this.settings;
    const interval = Math.floor(Math.random() * (maxRotationInterval - minRotationInterval)) + minRotationInterval;
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
    
    if (!this.enabled) return;
    
    this.rotationTimer = setTimeout(() => {
      this.rotateToNextBot();
    }, interval);
  }
  
  /**
   * Force rotation
   */
  async forceRotation() {
    console.log('🔄 ViewBotRotationService: forceRotation() called at', new Date().toISOString());
    console.log('🔄 ViewBotRotationService: Forcing rotation...');
    
    // Clear existing timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    // Rotate immediately
    await this.rotateToNextBot();
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      currentBot: this.currentBot?.id || null,
      totalBots: this.bots.length,
      availableNow: this.bots.filter(bot => {
        const lastPlayed = this.cooldowns.get(bot.id);
        if (!lastPlayed) return true;
        return (Date.now() - lastPlayed) > this.settings.cooldownDuration;
      }).length,
      settings: this.settings,
      hasClient: this.currentBot?.client !== null,
      isStreaming: this.currentBot?.client?.isStreaming || false
    };
  }
  
  /**
   * Update settings
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    console.log('⚙️ Updated settings:', this.settings);
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    console.log('🧹 ViewBotRotationService: Cleaning up...');
    await this.stopRotation();
  }
}

module.exports = ViewBotRotationService;