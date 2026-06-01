const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const ViewBotLiveKitService = require('./ViewBotLiveKitService');

const logger = require('../bootstrap/logger').child({ svc: 'ViewbotService' });

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

    // LiveKit is the sole WebRTC backend (ADR-0024): RTMP-ingress viewbot.
    this.webrtcService = new ViewBotLiveKitService(livekitService);
    this.backendType = 'livekit';
    
    this.useWebRTC = true; // Use WebRTC mode for proper integration
  }

  /**
   * Updates the viewbot configuration for custom content generation
   */
  updateViewbotConfig(newConfig) {
    if (newConfig) {
      logger.debug('🎨 VIEWBOT: Updating configuration with:', newConfig);
      
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
      logger.debug('✅ VIEWBOT: Configuration updated to:', this.viewbotConfig);
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
        logger.debug('🤖 VIEWBOT: Starting WebRTC ViewBot...');
        
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
      }

      this.isViewbotActive = true;
      this.streamStartTime = Date.now();
      
      logger.debug(`🤖 VIEWBOT: Started viewbot stream ${this.viewbotStreamId} (${this.useWebRTC ? 'WebRTC' : 'HLS'})`);
      
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
      logger.error('❌ VIEWBOT: Failed to start viewbot:', error);
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
      logger.error('❌ VIEWBOT: Error stopping viewbot:', error);
      return {
        success: false,
        message: 'Error stopping viewbot: ' + error.message
      };
    }
  }

  // Lifecycle entry point — uniform name across services for the bootstrap
  // shutdown loop (PR 1.2). Delegates to the existing teardown.
  async stop() {
    await this.cleanup();
  }

  async cleanup() {
    logger.debug('🧹 VIEWBOT: Cleaning up viewbot resources...');
    
    this.isViewbotActive = false;
    
    // Stop simulation timer
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
      logger.debug('⏹️ VIEWBOT: Simulation timer stopped');
    }
    
    // Stop FFmpeg process
    if (this.viewbotProcess && !this.viewbotProcess.killed) {
      try {
        this.viewbotProcess.kill('SIGTERM');
        
        // Wait for graceful shutdown
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (!this.viewbotProcess.killed) {
              logger.debug('🔪 VIEWBOT: Force killing FFmpeg process');
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
        logger.warn('⚠️ VIEWBOT: Error stopping FFmpeg process:', error);
      }
      
      this.viewbotProcess = null;
    }
    
    // Clean up MediaSoup resources
    if (this.viewbotStreamId && this.mediasoupService) {
      try {
        await this.mediasoupService.cleanupSocketResources(this.viewbotStreamId);
        logger.debug('✅ VIEWBOT: MediaSoup resources cleaned up');
      } catch (error) {
        logger.warn('⚠️ VIEWBOT: Error cleaning up MediaSoup resources:', error);
      }
    }
    
    // Clean up pipeline file
    if (this.pipelinePath && fs.existsSync(this.pipelinePath)) {
      try {
        fs.unlinkSync(this.pipelinePath);
      } catch (error) {
        logger.warn('⚠️ VIEWBOT: Error removing pipeline file:', error);
      }
    }
    
    // Reset state
    this.viewbotStreamId = null;
    this.streamStartTime = null;
    this.pipelinePath = null;
    this.currentViewbots.clear();
    
    logger.debug('✅ VIEWBOT: Cleanup completed');
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
      
      logger.debug(`🤖 VIEWBOT: Spawned additional viewbot ${viewbotId}`);
      
      return {
        success: true,
        message: 'Additional viewbot spawned',
        viewbotId,
        config: viewbotConfig
      };
    } catch (error) {
      logger.error('❌ VIEWBOT: Failed to spawn additional viewbot:', error);
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
    logger.debug(`🔄 VIEWBOT: Handling takeover by ${newStreamerId}`);
    
    if (this.isViewbotActive) {
      // Gracefully stop viewbot when taken over
      await this.stopViewbot();
      logger.debug('🔄 VIEWBOT: Viewbot stopped due to takeover');
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
    logger.debug(`🎬 ViewbotService: Handling video end for bot ${botId}`);
    
    // Always trigger rotation on video end - rotation is enabled by default
    logger.debug(`🔄 ViewbotService: Triggering rotation after video end for ${botId}`);
    
    // Use ViewBotClientService's rotation mechanism directly
    if (this.viewBotClientService && this.viewBotClientService.handleRotation) {
      logger.debug(`📤 ViewbotService: Delegating rotation to ViewBotClientService`);
      this.viewBotClientService.handleRotation(botId);
    } else {
      // Fallback: stop current bot and start another
      logger.debug(`🔀 ViewbotService: Using fallback rotation mechanism`);
      
      if (this.viewBotClientService) {
        // Stop the current bot
        const bot = this.viewBotClientService.bots.get(botId);
        if (bot) {
          logger.debug(`🛑 ViewbotService: Stopping bot ${botId}`);
          bot.stopStreaming();
        }
        
        // Start another random bot after a short delay
        setTimeout(() => {
          const availableBots = Array.from(this.viewBotClientService.bots.values())
            .filter(b => !b.streaming && b.connected && b.botId !== botId);
          
          if (availableBots.length > 0) {
            const randomBot = availableBots[Math.floor(Math.random() * availableBots.length)];
            logger.debug(`🎲 ViewbotService: Starting random bot ${randomBot.botId} for rotation`);
            randomBot.requestToStream();
          } else {
            logger.debug(`⚠️ ViewbotService: No available bots for rotation`);
          }
        }, 2000);
      }
    }
  }
}

module.exports = ViewbotService;
