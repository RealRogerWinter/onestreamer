/**
 * SimpleViewBotMediaSoup - Integrates viewbot rotation with MediaSoup streaming
 * Streams directly through MediaSoup Plain Transport (RTP)
 */

const { spawn } = require('child_process');
const processManager = require('./ProcessManager');

class SimpleViewBotMediaSoup {
  constructor(mediasoupService) {
    console.log('🎯 SimpleViewBotMediaSoup: Starting initialization...');
    
    if (!mediasoupService) {
      console.error('❌ SimpleViewBotMediaSoup: No MediaSoup service provided!');
      throw new Error('MediaSoup service is required');
    }
    
    if (!mediasoupService.router) {
      console.error('❌ SimpleViewBotMediaSoup: MediaSoup router not available!');
      throw new Error('MediaSoup router is required');
    }
    
    this.mediasoupService = mediasoupService;
    this.currentBot = null;
    this.currentTransport = null;
    this.currentProducer = null;
    this.gstreamerProcess = null;
    this.rotationTimer = null;
    this.errorCount = 0;
    
    // Bot pool
    this.availableBots = [];
    this.cooldowns = new Map();
    
    // Settings
    this.settings = {
      minRotationInterval: 60000,   // 1 minute
      maxRotationInterval: 300000,  // 5 minutes
      cooldownDuration: 1800000,    // 30 minutes
      enabled: true
    };
    
    console.log('✅ SimpleViewBotMediaSoup: Initialized successfully');
  }
  
  /**
   * Initialize with bot list
   */
  async initialize(bots) {
    console.log('📦 SimpleViewBotMediaSoup: Starting bot initialization...');
    this.availableBots = bots;
    console.log(`📦 SimpleViewBotMediaSoup: Loaded ${bots.length} viewbots for MediaSoup streaming`);
    console.log(`📦 SimpleViewBotMediaSoup: Settings enabled: ${this.settings.enabled}`);
    console.log(`📦 SimpleViewBotMediaSoup: Available bots count: ${this.availableBots.length}`);
    
    if (this.settings.enabled && this.availableBots.length > 0) {
      console.log('🚀 SimpleViewBotMediaSoup: Rotation enabled, calling startRotation()...');
      try {
        await this.startRotation();
        console.log('🚀 SimpleViewBotMediaSoup: startRotation() completed');
      } catch (error) {
        console.error('❌ SimpleViewBotMediaSoup: Error in startRotation():', error);
      }
    } else {
      console.log(`⏸️ SimpleViewBotMediaSoup: Not starting rotation (enabled: ${this.settings.enabled}, bots: ${this.availableBots.length})`);
    }
  }
  
  /**
   * Start rotation system
   */
  async startRotation() {
    console.log('🎬 Starting MediaSoup viewbot rotation');
    await this.stopCurrentBot();
    await this.rotateToNextBot();
  }
  
  /**
   * Stop rotation system
   */
  async stopRotation() {
    console.log('⏹️ Stopping MediaSoup viewbot rotation');
    
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    await this.stopCurrentBot();
  }
  
  /**
   * Rotate to next bot
   */
  async rotateToNextBot() {
    console.log('🔄 Rotating to next MediaSoup viewbot');
    
    // Emit stream-ending event before stopping
    if (this.currentBot && global.io) {
      global.io.emit('stream-ending', {
        streamerId: this.currentBot.id,
        reason: 'rotation'
      });
    }
    
    // Stop current
    await this.stopCurrentBot();
    
    // Select next bot
    const nextBot = this.selectNextBot();
    
    if (!nextBot) {
      console.log('⚠️ No available bots (all on cooldown)');
      this.scheduleNextRotation(30000);
      return;
    }
    
    // Start the bot (stream-ready will be emitted from startBot)
    await this.startBot(nextBot);
    
    // Skip duplicate stream-ready emission (already done in startBot)
    if (false && global.io && this.currentProducer) {
      // Use the existing stream-ready event that clients already listen for
      global.io.emit('stream-ready', {
        streamerId: nextBot.id,
        isViewBot: true,
        streamType: 'viewbot',
        botId: nextBot.id,
        timestamp: Date.now(),
        // Include producer IDs for MediaSoup consumption
        videoProducerId: this.currentProducer.video?.id,
        audioProducerId: this.currentProducer.audio?.id
      });
      
      console.log('📢 Emitted stream-ready event to trigger client stream switch');
    }
    
    // Schedule next rotation
    const interval = this.getRandomInterval();
    this.scheduleNextRotation(interval);
  }
  
  /**
   * Select next bot respecting cooldowns
   */
  selectNextBot() {
    const now = Date.now();
    
    const availableBots = this.availableBots.filter(bot => {
      const lastPlayed = this.cooldowns.get(bot.id);
      if (!lastPlayed) return true;
      return (now - lastPlayed) > this.settings.cooldownDuration;
    });
    
    if (availableBots.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * availableBots.length);
    return availableBots[randomIndex];
  }
  
  /**
   * Start a bot streaming through MediaSoup
   */
  async startBot(bot) {
    try {
      console.log(`🚀 Starting MediaSoup viewbot: ${bot.id}`);
      console.log(`🚀 Bot details: ${JSON.stringify(bot)}`);
      console.log(`🚀 MediaSoup service available: ${!!this.mediasoupService}`);
      console.log(`🚀 MediaSoup router available: ${!!this.mediasoupService?.router}`);
      
      this.currentBot = bot;
      this.cooldowns.set(bot.id, Date.now());
      
      // Create Plain Transport for RTP
      const transport = await this.createPlainTransport();
      if (!transport) {
        throw new Error('Failed to create transport');
      }
      
      this.currentTransport = transport;
      
      // Get RTP ports
      const videoPort = transport.tuple.localPort;
      const audioPort = transport.rtcpTuple ? transport.rtcpTuple.localPort : videoPort + 2;
      
      console.log(`📡 RTP ports - Video: ${videoPort}, Audio: ${audioPort}`);
      
      // Create producers FIRST before starting GStreamer
      await this.createProducers(transport);
      
      // Start GStreamer pipeline after producers are ready
      await this.startGStreamerPipeline(bot, videoPort, audioPort);
      
      console.log(`✅ MediaSoup viewbot ${bot.id} is streaming`);
      
      // Stream-ready is now emitted in createProducers to match real user flow
      console.log('✅ Stream-ready handled in createProducers (like real users)');
      
    } catch (error) {
      console.error(`❌ Failed to start bot ${bot.id}:`, error);
      // Don't call handleBotError here as it triggers another rotation
      // Just clean up the current attempt
      // Clean up but don't trigger another rotation on error
      if (this.gstreamerProcess) {
        this.gstreamerProcess.kill('SIGKILL');
        this.gstreamerProcess = null;
      }
      if (this.currentTransport) {
        try { this.currentTransport.close(); } catch(e) {}
        this.currentTransport = null;
      }
      if (this.currentProducer) {
        try {
          if (this.currentProducer.video) this.currentProducer.video.close();
          if (this.currentProducer.audio) this.currentProducer.audio.close();
        } catch(e) {}
        this.currentProducer = null;
      }
      this.currentBot = null;
    }
  }
  
  /**
   * Create Plain Transport for RTP streaming
   */
  async createPlainTransport() {
    try {
      // Check if MediaSoup service is available
      if (!this.mediasoupService || !this.mediasoupService.router) {
        console.error('❌ MediaSoup router not available');
        return null;
      }
      
      // Create plain transport for RTP
      const transport = await this.mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '127.0.0.1',
          announcedIp: null
        },
        rtcpMux: false,
        comedia: true
      });
      
      console.log(`✅ Created Plain Transport: ${transport.id}`);
      return transport;
      
    } catch (error) {
      console.error('❌ Failed to create transport:', error);
      return null;
    }
  }
  
  /**
   * Start GStreamer pipeline
   */
  async startGStreamerPipeline(bot, videoPort, audioPort) {
    return new Promise((resolve, reject) => {
      let pipeline;
      
      // Use video files when available
      if (bot.mediaFile) {
        // Stream from video file with improved pipeline
        pipeline = [
          'filesrc', `location=${bot.mediaFile}`, 'do-timestamp=true',
          '!', 'qtdemux', 'name=demux',
          
          // Video branch
          'demux.',
          '!', 'queue',
          '!', 'h264parse',
          '!', 'avdec_h264',
          '!', 'videoconvert',
          '!', 'videoscale',
          '!', 'video/x-raw,width=1280,height=720',
          '!', 'videorate',
          '!', 'video/x-raw,framerate=30/1',
          '!', 'x264enc', 'tune=zerolatency', 'bitrate=2000', 'key-int-max=60',
          '!', 'rtph264pay', 'config-interval=1', 'pt=102', 'ssrc=11111111',
          '!', 'udpsink', 'host=127.0.0.1', `port=${videoPort}`,
          
          // Audio branch  
          'demux.',
          '!', 'queue',
          '!', 'aacparse',
          '!', 'avdec_aac',
          '!', 'audioconvert',
          '!', 'audioresample',
          '!', 'audio/x-raw,rate=48000,channels=2',
          '!', 'opusenc', 'bitrate=128000',
          '!', 'rtpopuspay', 'pt=101', 'ssrc=22222222',
          '!', 'udpsink', 'host=127.0.0.1', `port=${audioPort}`
        ];
      } else {
        // Test pattern with different patterns for variety
        const patterns = ['smpte', 'snow', 'black', 'white', 'red', 'green', 'blue', 'checkers-1', 'checkers-2', 'checkers-4', 'checkers-8', 'circular', 'blink', 'smpte75'];
        const pattern = patterns[Math.floor(Math.random() * patterns.length)];
        const freq = 440 + Math.floor(Math.random() * 440); // Random frequency between 440-880 Hz
        
        pipeline = [
          // Video test source
          'videotestsrc', `pattern=${pattern}`,
          '!', 'video/x-raw,width=1280,height=720,framerate=30/1',
          '!', 'x264enc', 'tune=zerolatency', 'bitrate=2000', 'key-int-max=60',
          '!', 'rtph264pay', 'config-interval=1', 'pt=102', 'ssrc=11111111',
          '!', 'udpsink', 'host=127.0.0.1', `port=${videoPort}`,
          
          // Audio test source
          'audiotestsrc', 'wave=sine', `freq=${freq}`,
          '!', 'audio/x-raw,rate=48000,channels=2',
          '!', 'opusenc', 'bitrate=128000',
          '!', 'rtpopuspay', 'pt=101', 'ssrc=22222222',
          '!', 'udpsink', 'host=127.0.0.1', `port=${audioPort}`
        ];
      }
      
      console.log(`🎥 Starting GStreamer for ${bot.id}`);
      
      this.gstreamerProcess = spawn('gst-launch-1.0', pipeline, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      // Track process
      if (processManager && processManager.addProcess) {
        processManager.addProcess(this.gstreamerProcess.pid, 'gstreamer', bot.id);
      }
      
      this.gstreamerProcess.on('error', (error) => {
        console.error(`❌ GStreamer error:`, error);
        this.gstreamerProcess = null;
        reject(error);
      });
      
      this.gstreamerProcess.on('exit', (code) => {
        console.log(`📤 GStreamer exited with code ${code}`);
        this.gstreamerProcess = null;
        
        // If unexpected exit during streaming, trigger rotation
        if (code !== 0 && this.currentBot?.id === bot.id) {
          this.handleBotError(bot);
        }
      });
      
      // Log stderr for debugging
      this.gstreamerProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('ERROR')) {
          console.error(`GStreamer ERROR:`, output);
        } else if (output.includes('Setting pipeline to PLAYING')) {
          console.log('✅ GStreamer pipeline playing');
          resolve();
        }
      });
      
      // Resolve after a timeout if no explicit playing message
      setTimeout(() => resolve(), 2000);
    });
  }
  
  /**
   * Create MediaSoup producers
   */
  async createProducers(transport) {
    try {
      // Video producer
      const videoProducer = await transport.produce({
        kind: 'video',
        rtpParameters: {
          codecs: [{
            mimeType: 'video/h264',
            payloadType: 102,
            clockRate: 90000,
            parameters: {
              'level-asymmetry-allowed': 1,
              'packetization-mode': 1,
              'profile-level-id': '42e01f'
            }
          }],
          encodings: [{ ssrc: 11111111 }]
        }
      });
      
      // Audio producer
      const audioProducer = await transport.produce({
        kind: 'audio',
        rtpParameters: {
          codecs: [{
            mimeType: 'audio/opus',
            payloadType: 101,
            clockRate: 48000,
            channels: 2,
            parameters: {
              'sprop-stereo': 1,
              'useinbandfec': 1
            }
          }],
          encodings: [{ ssrc: 22222222 }]
        }
      });
      
      this.currentProducer = { video: videoProducer, audio: audioProducer };
      
      console.log(`✅ Created MediaSoup producers - Video: ${videoProducer.id}, Audio: ${audioProducer.id}`);
      
      // Register as active stream
      if (global.streamManager) {
        global.streamManager.setActiveStream({
          streamerId: this.currentBot.id,
          producerId: videoProducer.id,
          audioProducerId: audioProducer.id,
          streamType: 'viewbot',
          isViewBot: true
        });
      }
      
      // Set as current streamer in StreamService
      if (global.streamService) {
        global.streamService.setStreamer(this.currentBot.id, 'viewbot');
      }
      
      // Register with MediaSoup service
      if (this.mediasoupService) {
        // Set current streamer
        this.mediasoupService.currentStreamer = this.currentBot.id;
        
        // Register producers in the service's producer map
        if (!this.mediasoupService.producers.has(this.currentBot.id)) {
          this.mediasoupService.producers.set(this.currentBot.id, new Map());
        }
        this.mediasoupService.producers.get(this.currentBot.id).set('video', videoProducer);
        this.mediasoupService.producers.get(this.currentBot.id).set('audio', audioProducer);
        
        // Also set the current producer IDs if they exist
        this.mediasoupService.currentProducerId = videoProducer.id;
        this.mediasoupService.currentAudioProducerId = audioProducer.id;
      }
      
      // CRITICAL: Notifying about ViewBot producers (matching real user flow)
      // Real users trigger this through socket.on('mediasoup:produce')
      // ViewBots must manually trigger the same notification
      
      if (this.mediasoupService && this.currentBot) {
        console.log('🔔 VIEWBOT: Checking notification conditions...');
        const streamService = global.streamService;
        
        if (streamService) {
          // Set this bot as the current streamer (like real users do)
          streamService.setStreamer(this.currentBot.id, 'viewbot');
          console.log(`✅ VIEWBOT: Set ${this.currentBot.id} as current streamer`);
          
          // Check if we should notify (matching the real user logic)
          const currentStreamer = streamService.getCurrentStreamer();
          const isCurrentStreamer = currentStreamer === this.currentBot.id;
          
          console.log(`🔍 VIEWBOT: Current streamer check - expected: ${this.currentBot.id}, actual: ${currentStreamer}, match: ${isCurrentStreamer}`);
          
          if (isCurrentStreamer && global.io) {
            // Emit stream-ready exactly like real users do (from line 6325 in index.js)
            console.log('📢 VIEWBOT: Emitting stream-ready event (matching real user pattern)');
            
            global.io.emit('stream-ready', {
              streamerId: this.currentBot.id,
              newStreamId: this.currentBot.id,
              isWebRTC: false,  // ViewBots use RTP, not WebRTC
              streamType: 'viewbot',
              hasVideo: true,
              hasAudio: true,
              producerVerified: true,
              streamStartTime: Date.now(),
              timestamp: Date.now(),
              streamerDisplayName: `ViewBot-${this.currentBot.id}`,
              isViewBot: true  // Additional flag for ViewBot identification
            });
            
            console.log('✅ VIEWBOT: stream-ready event emitted successfully');
            
            // Also emit viewer count update like real users
            global.io.emit('viewer-count-update', 0);
          } else {
            console.warn(`⚠️ VIEWBOT: Cannot emit stream-ready - not current streamer or no io`);
          }
        } else {
          console.error('❌ VIEWBOT: No streamService available');
        }
      }
      
    } catch (error) {
      console.error('❌ Failed to create producers:', error);
    }
  }
  
  /**
   * Stop current bot
   */
  async stopCurrentBot() {
    if (!this.currentBot) return;
    
    const botId = this.currentBot.id;
    console.log(`⏹️ Stopping MediaSoup viewbot: ${botId}`);
    
    // Emit stream-ended event
    if (global.io) {
      global.io.emit('stream-ended', {
        streamerId: botId,
        streamType: 'viewbot'
      });
    }
    
    // Stop GStreamer
    if (this.gstreamerProcess) {
      this.gstreamerProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
          this.gstreamerProcess.kill('SIGKILL');
        }
      }, 2000);
      this.gstreamerProcess = null;
    }
    
    // Close producers
    if (this.currentProducer) {
      try {
        if (this.currentProducer.video) this.currentProducer.video.close();
        if (this.currentProducer.audio) this.currentProducer.audio.close();
      } catch (e) {
        console.error('Error closing producers:', e);
      }
      this.currentProducer = null;
    }
    
    // Close transport
    if (this.currentTransport) {
      try {
        this.currentTransport.close();
      } catch (e) {
        console.error('Error closing transport:', e);
      }
      this.currentTransport = null;
    }
    
    // Clear active stream
    if (global.streamManager) {
      global.streamManager.clearActiveStream();
    }
    
    // Clear current streamer in StreamService
    if (global.streamService) {
      global.streamService.clearStreamer();
    }
    
    // Clear on MediaSoup service
    if (this.mediasoupService) {
      // Clear current streamer if it's still us
      if (this.mediasoupService.currentStreamer === botId) {
        this.mediasoupService.currentStreamer = null;
      }
      
      // Remove producers from the map
      if (this.mediasoupService.producers.has(botId)) {
        this.mediasoupService.producers.delete(botId);
      }
      
      this.mediasoupService.currentProducerId = null;
      this.mediasoupService.currentAudioProducerId = null;
    }
    
    // Notify streaming stopped
    if (global.io) {
      global.io.emit('viewbot-stopped', { botId });
      global.io.emit('stream-ended', { streamerId: botId });
    }
    
    this.currentBot = null;
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
    
    if (!this.settings.enabled) return;
    
    this.rotationTimer = setTimeout(() => {
      this.rotateToNextBot();
    }, interval);
  }
  
  /**
   * Handle bot error
   */
  handleBotError(bot) {
    this.errorCount = (this.errorCount || 0) + 1;
    
    // Prevent infinite error loops
    if (this.errorCount > 5) {
      console.error('❌ Too many errors, stopping rotation');
      this.settings.enabled = false;
      return;
    }
    console.error(`🔧 Handling error for bot ${bot.id}`);
    // Add extended cooldown for errored bot
    this.cooldowns.set(bot.id, Date.now() + this.settings.cooldownDuration * 2);
    
    // Schedule next rotation with a short delay to avoid rapid cycling
    setTimeout(() => {
      this.rotateToNextBot();
    }, 5000);
  }
  
  /**
   * Update settings
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    console.log('⚙️ Updated settings:', this.settings);
  }
  
  /**
   * Get status
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
      hasGStreamer: this.gstreamerProcess !== null,
      hasTransport: this.currentTransport !== null,
      hasProducers: this.currentProducer !== null
    };
  }
  
  /**
   * Force rotation
   */
  async forceRotation() {
    console.log('🔄 Forcing rotation');
    await this.rotateToNextBot();
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down MediaSoup rotation');
    await this.stopRotation();
  }
}

module.exports = SimpleViewBotMediaSoup;