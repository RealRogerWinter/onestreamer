/**
 * Integration layer for the simple ViewBot rotation system
 * This replaces the complex ViewBotClientService rotation logic
 */

const SimpleViewBotRotation = require('./SimpleViewBotRotation');
const ViewBotDatabaseService = require('./ViewBotDatabaseService');
const path = require('path');
const fs = require('fs');

class ViewBotRotationIntegration {
  constructor() {
    this.dbService = new ViewBotDatabaseService();
    this.initialized = false;
    this.videoDirectory = '/root/onestreamer/server/uploads';
  }
  
  /**
   * Initialize the rotation system with database bots
   */
  async initialize() {
    try {
      console.log('🔄 Initializing ViewBot Rotation Integration...');
      
      // Initialize database
      await this.dbService.initialize();
      
      // Load viewbots from database
      const dbBots = await this.dbService.loadAllViewBots();
      console.log(`📊 Found ${dbBots.length} viewbots in database`);
      
      // Get available video files
      const videoFiles = await this.getAvailableVideos();
      console.log(`🎥 Found ${videoFiles.length} video files`);
      
      // Create bot configurations
      const bots = [];
      
      // If we have database bots, use them
      if (dbBots.length > 0) {
        dbBots.forEach((dbBot, index) => {
          // Assign a video file to each bot (cycling through available videos)
          const videoFile = videoFiles[index % videoFiles.length];
          
          bots.push({
            id: dbBot.bot_id,
            name: dbBot.username || `ViewBot ${index + 1}`,
            mediaFile: videoFile ? videoFile.path : null,
            dbRecord: dbBot
          });
        });
      } else {
        // Create default bots if none in database
        console.log('📝 No bots in database, creating defaults...');
        
        for (let i = 0; i < Math.min(videoFiles.length, 6); i++) {
          const botId = `viewbot-${Date.now()}-${i}`;
          bots.push({
            id: botId,
            name: `ViewBot ${i + 1}`,
            mediaFile: videoFiles[i].path
          });
          
          // Save to database
          await this.dbService.saveViewBot({
            bot_id: botId,
            username: `ViewBot ${i + 1}`,
            email: `bot${i+1}@viewbot.local`,
            is_placeholder: false,
            media_file: videoFiles[i].path
          });
        }
        
        // Add a test pattern bot
        const testBotId = `viewbot-test-${Date.now()}`;
        bots.push({
          id: testBotId,
          name: 'Test Pattern Bot',
          mediaFile: null
        });
        
        await this.dbService.saveViewBot({
          bot_id: testBotId,
          username: 'Test Pattern Bot',
          email: 'test@viewbot.local',
          is_placeholder: false,
          media_file: null
        });
      }
      
      // Load rotation settings from database
      const settings = await this.loadRotationSettings();
      
      // Update SimpleViewBotRotation settings
      SimpleViewBotRotation.updateSettings(settings);
      
      // Initialize the rotation system
      await SimpleViewBotRotation.initialize(bots);
      
      this.initialized = true;
      console.log('✅ ViewBot Rotation Integration initialized successfully');
      
      return {
        success: true,
        botCount: bots.length,
        settings
      };
      
    } catch (error) {
      console.error('❌ Failed to initialize ViewBot rotation:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get available video files
   */
  async getAvailableVideos() {
    const videos = [];
    
    // Check uploads directory
    if (fs.existsSync(this.videoDirectory)) {
      const files = fs.readdirSync(this.videoDirectory);
      const videoFiles = files.filter(f => 
        f.endsWith('.mp4') || 
        f.endsWith('.webm') || 
        f.endsWith('.avi') ||
        f.endsWith('.mov')
      );
      
      videoFiles.forEach(file => {
        videos.push({
          filename: file,
          path: path.join(this.videoDirectory, file),
          size: fs.statSync(path.join(this.videoDirectory, file)).size
        });
      });
    }
    
    // Also check /root/onestreamer/videos
    const altVideoDir = '/root/onestreamer/videos';
    if (fs.existsSync(altVideoDir)) {
      const files = fs.readdirSync(altVideoDir);
      const videoFiles = files.filter(f => 
        f.endsWith('.mp4') || 
        f.endsWith('.webm')
      );
      
      videoFiles.forEach(file => {
        videos.push({
          filename: file,
          path: path.join(altVideoDir, file),
          size: fs.statSync(path.join(altVideoDir, file)).size
        });
      });
    }
    
    return videos;
  }
  
  /**
   * Load rotation settings from database or use defaults
   */
  async loadRotationSettings() {
    try {
      // Try to load from database (could be stored in a settings table)
      // For now, use defaults that can be overridden
      
      const settings = {
        minRotationInterval: 60000,   // 1 minute minimum
        maxRotationInterval: 300000,  // 5 minutes maximum  
        cooldownDuration: 1800000,    // 30 minute cooldown
        enabled: true
      };
      
      // Check environment variables for overrides
      if (process.env.VIEWBOT_MIN_INTERVAL) {
        settings.minRotationInterval = parseInt(process.env.VIEWBOT_MIN_INTERVAL);
      }
      if (process.env.VIEWBOT_MAX_INTERVAL) {
        settings.maxRotationInterval = parseInt(process.env.VIEWBOT_MAX_INTERVAL);
      }
      if (process.env.VIEWBOT_COOLDOWN) {
        settings.cooldownDuration = parseInt(process.env.VIEWBOT_COOLDOWN);
      }
      if (process.env.VIEWBOT_ROTATION_ENABLED !== undefined) {
        settings.enabled = process.env.VIEWBOT_ROTATION_ENABLED === 'true';
      }
      
      return settings;
      
    } catch (error) {
      console.error('⚠️ Error loading rotation settings:', error);
      // Return defaults
      return {
        minRotationInterval: 60000,
        maxRotationInterval: 300000,
        cooldownDuration: 1800000,
        enabled: true
      };
    }
  }
  
  /**
   * Start rotation
   */
  async startRotation() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    console.log('▶️ Starting ViewBot rotation');
    SimpleViewBotRotation.updateSettings({ enabled: true });
    await SimpleViewBotRotation.startRotation();
  }
  
  /**
   * Stop rotation
   */
  async stopRotation() {
    console.log('⏹️ Stopping ViewBot rotation');
    await SimpleViewBotRotation.stopRotation();
  }
  
  /**
   * Force rotation to next bot
   */
  async forceRotation() {
    console.log('🔄 Forcing rotation to next bot');
    await SimpleViewBotRotation.rotateToNextBot();
  }
  
  /**
   * Get current status
   */
  getStatus() {
    return SimpleViewBotRotation.getStatus();
  }
  
  /**
   * Update settings
   */
  updateSettings(settings) {
    console.log('⚙️ Updating rotation settings:', settings);
    SimpleViewBotRotation.updateSettings(settings);
  }
  
  /**
   * Handle real streamer takeover
   */
  handleRealStreamerActive(isActive) {
    if (isActive) {
      console.log('👤 Real streamer active - pausing rotation');
      this.stopRotation();
    } else {
      console.log('👤 Real streamer inactive - resuming rotation');
      // Wait a bit before resuming to avoid conflicts
      setTimeout(() => {
        this.startRotation();
      }, 5000);
    }
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down ViewBot rotation integration');
    await SimpleViewBotRotation.shutdown();
  }
}

// Export singleton
module.exports = new ViewBotRotationIntegration();