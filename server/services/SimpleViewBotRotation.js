/**
 * SimpleViewBotRotation.js - Dead simple viewbot rotation system
 * 
 * Features:
 * - One viewbot streaming at a time
 * - Random rotation intervals
 * - Cooldown system to prevent replays
 * - Socket-based streaming through the platform
 */

const SimpleViewBotSocket = require('./SimpleViewBotSocket');

class SimpleViewBotRotation {
  constructor() {
    // Core state
    this.currentBot = null;
    this.rotationTimer = null;
    this.gstreamerProcess = null;
    
    // Bot pool - these should be loaded from config/database
    this.availableBots = [];
    
    // Cooldowns - Map of botId -> lastPlayedTimestamp
    this.cooldowns = new Map();
    
    // Settings
    this.settings = {
      minRotationInterval: 30000,  // 30 seconds minimum
      maxRotationInterval: 180000, // 3 minutes maximum
      cooldownDuration: 600000,    // 10 minute cooldown per bot
      enabled: true
    };
    
    // MediaSoup RTP ports (should match server config)
    this.rtpPorts = {
      video: 5004,
      audio: 5006
    };
    
    console.log('🎯 SimpleViewBotRotation: Initialized');
  }
  
  /**
   * Initialize the rotation system with available bots
   */
  async initialize(bots) {
    this.availableBots = bots;
    console.log(`📦 Loaded ${bots.length} viewbots into rotation pool`);
    
    if (this.settings.enabled && this.availableBots.length > 0) {
      await this.startRotation();
    }
  }
  
  /**
   * Start the rotation system
   */
  async startRotation() {
    console.log('🎬 Starting viewbot rotation system');
    
    // Stop any existing rotation
    await this.stopRotation();
    
    // Start first bot
    await this.rotateToNextBot();
  }
  
  /**
   * Stop the rotation system
   */
  async stopRotation() {
    console.log('⏹️ Stopping viewbot rotation');
    
    // Clear rotation timer
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    // Stop current bot
    await this.stopCurrentBot();
  }
  
  /**
   * Rotate to the next viewbot
   */
  async rotateToNextBot() {
    console.log('🔄 Rotating to next viewbot');
    
    // Stop current bot
    await this.stopCurrentBot();
    
    // Select next bot
    const nextBot = this.selectNextBot();
    
    if (!nextBot) {
      console.log('⚠️ No available bots for rotation (all on cooldown?)');
      // Retry in 30 seconds
      this.scheduleNextRotation(30000);
      return;
    }
    
    // Start the new bot
    await this.startBot(nextBot);
    
    // Schedule next rotation at random interval
    const interval = this.getRandomInterval();
    this.scheduleNextRotation(interval);
  }
  
  /**
   * Select next bot respecting cooldowns
   */
  selectNextBot() {
    const now = Date.now();
    
    // Filter available bots (not on cooldown)
    const availableBots = this.availableBots.filter(bot => {
      const lastPlayed = this.cooldowns.get(bot.id);
      if (!lastPlayed) return true;
      return (now - lastPlayed) > this.settings.cooldownDuration;
    });
    
    if (availableBots.length === 0) {
      return null;
    }
    
    // Random selection
    const randomIndex = Math.floor(Math.random() * availableBots.length);
    return availableBots[randomIndex];
  }
  
  /**
   * Start a specific bot streaming
   */
  async startBot(bot) {
    try {
      console.log(`🚀 Starting viewbot: ${bot.id}`);
      
      // Update state
      this.currentBot = bot;
      this.cooldowns.set(bot.id, Date.now());
      
      // Build GStreamer pipeline
      const pipeline = this.buildGStreamerPipeline(bot);
      
      // Start GStreamer process
      this.gstreamerProcess = spawn('gst-launch-1.0', pipeline.split(' '), {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      // Track with ProcessManager if available
      if (processManager && typeof processManager.trackProcess === 'function') {
        processManager.trackProcess(this.gstreamerProcess.pid, 'gstreamer', bot.id);
      } else if (processManager && typeof processManager.addProcess === 'function') {
        processManager.addProcess(this.gstreamerProcess.pid, 'gstreamer', bot.id);
      }
      
      // Handle process events
      this.gstreamerProcess.on('error', (error) => {
        console.error(`❌ GStreamer error for ${bot.id}:`, error);
        this.handleBotError(bot);
      });
      
      this.gstreamerProcess.on('exit', (code) => {
        console.log(`📤 GStreamer exited for ${bot.id} with code ${code}`);
        if (code !== 0 && this.currentBot?.id === bot.id) {
          this.handleBotError(bot);
        }
      });
      
      // Log output for debugging
      this.gstreamerProcess.stdout.on('data', (data) => {
        console.log(`[GStreamer ${bot.id}]:`, data.toString());
      });
      
      this.gstreamerProcess.stderr.on('data', (data) => {
        if (data.toString().includes('ERROR')) {
          console.error(`[GStreamer ERROR ${bot.id}]:`, data.toString());
        }
      });
      
      console.log(`✅ Viewbot ${bot.id} is now streaming`);
      
      // Emit event for other systems
      this.emitEvent('viewbot-started', { botId: bot.id });
      
    } catch (error) {
      console.error(`❌ Failed to start bot ${bot.id}:`, error);
      this.handleBotError(bot);
    }
  }
  
  /**
   * Stop the current bot
   */
  async stopCurrentBot() {
    if (!this.currentBot) return;
    
    const botId = this.currentBot.id;
    console.log(`⏹️ Stopping viewbot: ${botId}`);
    
    // Kill GStreamer process
    if (this.gstreamerProcess) {
      try {
        // Use ProcessManager if available
        if (processManager && processManager.killProcessGroup) {
          await processManager.killProcessGroup(this.gstreamerProcess.pid);
        } else {
          this.gstreamerProcess.kill('SIGTERM');
          // Force kill after timeout
          setTimeout(() => {
            if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
              this.gstreamerProcess.kill('SIGKILL');
            }
          }, 2000);
        }
      } catch (error) {
        console.error(`⚠️ Error killing GStreamer for ${botId}:`, error);
      }
      
      this.gstreamerProcess = null;
    }
    
    // Emit event
    this.emitEvent('viewbot-stopped', { botId });
    
    // Clear current bot
    this.currentBot = null;
  }
  
  /**
   * Build GStreamer pipeline for a bot
   */
  buildGStreamerPipeline(bot) {
    // Use bot's media file or test pattern
    const videoSource = bot.mediaFile 
      ? `filesrc location="${bot.mediaFile}" ! decodebin name=decoder`
      : `videotestsrc pattern=smpte ! video/x-raw,width=1280,height=720,framerate=30/1`;
    
    const audioSource = bot.mediaFile
      ? `decoder. ! audioconvert ! audioresample`
      : `audiotestsrc wave=sine freq=440`;
    
    // Build pipeline for RTP streaming to MediaSoup
    const videoPipeline = `${videoSource} ! videoconvert ! x264enc tune=zerolatency bitrate=1000 ! rtph264pay config-interval=1 pt=102 ! udpsink host=127.0.0.1 port=${this.rtpPorts.video}`;
    
    const audioPipeline = `${audioSource} ! opusenc ! rtpopuspay pt=101 ! udpsink host=127.0.0.1 port=${this.rtpPorts.audio}`;
    
    // Combine pipelines
    return bot.mediaFile 
      ? `${videoSource} decoder. ! videoconvert ! x264enc tune=zerolatency bitrate=1000 ! rtph264pay config-interval=1 pt=102 ! udpsink host=127.0.0.1 port=${this.rtpPorts.video} ${audioPipeline}`
      : `${videoPipeline} ${audioPipeline}`;
  }
  
  /**
   * Get random rotation interval
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
    
    if (!this.settings.enabled) {
      console.log('🚫 Rotation disabled, not scheduling next rotation');
      return;
    }
    
    this.rotationTimer = setTimeout(() => {
      this.rotateToNextBot();
    }, interval);
  }
  
  /**
   * Handle bot streaming error
   */
  handleBotError(bot) {
    console.error(`🔧 Handling error for bot ${bot.id}`);
    
    // Mark bot with extended cooldown
    this.cooldowns.set(bot.id, Date.now() + this.settings.cooldownDuration);
    
    // Immediately rotate to next bot
    this.rotateToNextBot();
  }
  
  /**
   * Update rotation settings
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    console.log('⚙️ Updated rotation settings:', this.settings);
    
    // Restart rotation if enabled state changed
    if (newSettings.enabled !== undefined) {
      if (newSettings.enabled && this.availableBots.length > 0) {
        this.startRotation();
      } else if (!newSettings.enabled) {
        this.stopRotation();
      }
    }
  }
  
  /**
   * Get current status
   */
  getStatus() {
    return {
      enabled: this.settings.enabled,
      currentBot: this.currentBot?.id || null,
      totalBots: this.availableBots.length,
      availableNow: this.availableBots.filter(bot => {
        const lastPlayed = this.cooldowns.get(bot.id);
        if (!lastPlayed) return true;
        return (Date.now() - lastPlayed) > this.settings.cooldownDuration;
      }).length,
      settings: this.settings,
      nextRotation: this.rotationTimer ? 'scheduled' : 'none'
    };
  }
  
  /**
   * Simple event emitter for integration
   */
  emitEvent(event, data) {
    // This can be replaced with actual event emitter or socket.io emission
    console.log(`📡 Event: ${event}`, data);
  }
  
  /**
   * Clean shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down rotation system');
    await this.stopRotation();
  }
}

// Export singleton instance
module.exports = new SimpleViewBotRotation();