/**
 * UnifiedViewBotRotation.js - Unified rotation system for both Plain RTP and WebRTC viewbots
 * 
 * This controller manages rotation for both types of viewbots and can switch between them
 * based on configuration or runtime requirements
 */

// SimpleViewBotRotation is a singleton instance, not a class
const simpleViewBotRotationInstance = require('./SimpleViewBotRotation');
const WebRTCViewBotRotation = require('./WebRTCViewBotRotation');

class UnifiedViewBotRotation {
  constructor(io, streamService, mediasoupService) {
    this.io = io;
    this.streamService = streamService;
    this.mediasoupService = mediasoupService;
    
    // Current mode - default to WebRTC for mobile compatibility
    this.mode = 'webrtc'; // 'plainrtp' or 'webrtc'
    
    // Rotation instances
    this.plainRtpRotation = null;
    this.webRtcRotation = null;
    this.activeRotation = null;
    
    // Shared state
    this.videoFiles = [];
    this.isRotating = false;
    
    console.log('🎮 UnifiedViewBotRotation: Initialized');
  }
  
  /**
   * Initialize both rotation systems
   */
  async initialize(videoFiles) {
    this.videoFiles = videoFiles;
    console.log(`📦 UnifiedViewBotRotation: Loading ${videoFiles.length} video files`);
    
    // Initialize Plain RTP rotation (existing system - use singleton)
    if (!this.plainRtpRotation) {
      this.plainRtpRotation = simpleViewBotRotationInstance;
      // It's already initialized as a singleton, just update with video files
      await this.plainRtpRotation.initialize(videoFiles.map(f => ({
        id: `viewbot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        mediaFile: f
      })));
    }
    
    // Initialize WebRTC rotation (new system)
    if (!this.webRtcRotation) {
      this.webRtcRotation = new WebRTCViewBotRotation(this.io, this.streamService);
      await this.webRtcRotation.initialize(videoFiles);
    }
    
    // Set default mode
    await this.setMode(this.mode);
    
    console.log('✅ UnifiedViewBotRotation: Both systems initialized');
  }
  
  /**
   * Set rotation mode
   */
  async setMode(mode) {
    if (mode !== 'plainrtp' && mode !== 'webrtc') {
      throw new Error(`Invalid mode: ${mode}. Must be 'plainrtp' or 'webrtc'`);
    }
    
    console.log(`🔄 UnifiedViewBotRotation: Switching to ${mode} mode`);
    
    // Stop current rotation
    if (this.activeRotation) {
      await this.activeRotation.stopRotation();
    }
    
    // Switch mode
    this.mode = mode;
    
    if (mode === 'webrtc') {
      this.activeRotation = this.webRtcRotation;
      console.log('📱 Using WebRTC viewbots (mobile compatible)');
    } else {
      this.activeRotation = this.plainRtpRotation;
      console.log('🖥️ Using Plain RTP viewbots (desktop only)');
    }
    
    // Restart rotation if it was running
    if (this.isRotating && this.activeRotation) {
      await this.activeRotation.startRotation();
    }
    
    // Emit mode change event
    if (this.io) {
      this.io.emit('viewbot-mode-changed', {
        mode: mode,
        mobileCompatible: mode === 'webrtc',
        timestamp: Date.now()
      });
    }
    
    return {
      success: true,
      mode: mode,
      mobileCompatible: mode === 'webrtc'
    };
  }
  
  /**
   * Start rotation
   */
  async startRotation() {
    console.log(`🎬 UnifiedViewBotRotation: Starting rotation in ${this.mode} mode`);
    
    if (!this.activeRotation) {
      throw new Error('Rotation system not initialized');
    }
    
    this.isRotating = true;
    await this.activeRotation.startRotation();
  }
  
  /**
   * Stop rotation
   */
  async stopRotation() {
    console.log('⏹️ UnifiedViewBotRotation: Stopping rotation');
    
    this.isRotating = false;
    
    if (this.activeRotation) {
      await this.activeRotation.stopRotation();
    }
  }
  
  /**
   * Force rotation to next bot
   */
  async forceRotation() {
    if (!this.activeRotation) {
      throw new Error('Rotation system not initialized');
    }
    
    await this.activeRotation.forceRotation();
  }
  
  /**
   * Get current status
   */
  getStatus() {
    const baseStatus = {
      mode: this.mode,
      mobileCompatible: this.mode === 'webrtc',
      isRotating: this.isRotating,
      totalVideos: this.videoFiles.length
    };
    
    if (this.activeRotation && this.activeRotation.getStatus) {
      return {
        ...baseStatus,
        ...this.activeRotation.getStatus()
      };
    }
    
    return baseStatus;
  }
  
  /**
   * Update settings for active rotation
   */
  updateSettings(settings) {
    if (this.activeRotation && this.activeRotation.updateSettings) {
      this.activeRotation.updateSettings(settings);
    }
    
    // Also update the inactive rotation for consistency
    if (this.mode === 'webrtc' && this.plainRtpRotation) {
      this.plainRtpRotation.updateSettings(settings);
    } else if (this.mode === 'plainrtp' && this.webRtcRotation) {
      this.webRtcRotation.updateSettings(settings);
    }
  }
  
  /**
   * Check if mobile clients should be warned
   */
  shouldWarnMobileClients() {
    return this.mode === 'plainrtp';
  }
  
  /**
   * Auto-detect and switch mode based on client types
   */
  async autoDetectMode(clientStats) {
    const mobileClientCount = clientStats.mobile || 0;
    const desktopClientCount = clientStats.desktop || 0;
    
    console.log(`📊 Client stats - Mobile: ${mobileClientCount}, Desktop: ${desktopClientCount}`);
    
    // If we have mobile clients and currently in Plain RTP mode, switch to WebRTC
    if (mobileClientCount > 0 && this.mode === 'plainrtp') {
      console.log('📱 Mobile clients detected, switching to WebRTC mode');
      await this.setMode('webrtc');
      return true;
    }
    
    // If only desktop clients and currently in WebRTC mode, optionally switch to Plain RTP
    // to save resources (optional optimization)
    if (mobileClientCount === 0 && desktopClientCount > 0 && this.mode === 'webrtc') {
      console.log('🖥️ Only desktop clients, could switch to Plain RTP to save resources');
      // Uncomment to enable auto-switch to Plain RTP:
      // await this.setMode('plainrtp');
      // return true;
    }
    
    return false;
  }
  
  /**
   * Cleanup
   */
  async shutdown() {
    console.log('🛑 UnifiedViewBotRotation: Shutting down');
    
    await this.stopRotation();
    
    if (this.plainRtpRotation) {
      await this.plainRtpRotation.shutdown();
    }
    
    if (this.webRtcRotation) {
      await this.webRtcRotation.shutdown();
    }
  }
}

module.exports = UnifiedViewBotRotation;