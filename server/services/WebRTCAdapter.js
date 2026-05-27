/**
 * WebRTC Adapter - Abstraction layer for switching between MediaSoup and LiveKit
 * Provides a unified interface regardless of backend
 */

const MediasoupService = require('./MediasoupService');
const LiveKitService = require('./LiveKitService');

const logger = require('../bootstrap/logger').child({ svc: 'WebRTCAdapter' });
class WebRTCAdapter {
  constructor() {
    this.config = require('../config/webrtc.config');
    this.backend = null;
    this.backendType = this.config.backend;
    this.initialized = false;
    
    // Create backend instance immediately but don't initialize yet
    switch (this.backendType) {
      case 'livekit':
        this.backend = new LiveKitService();
        break;
      case 'mediasoup':
      default:
        this.backend = new MediasoupService();
        break;
    }
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    logger.debug(`🎬 WebRTC Adapter: Initializing with ${this.backendType.toUpperCase()} backend`);

    try {
      if (this.backendType === 'livekit') {
        await this.backend.initialize();
        logger.debug('✅ WebRTC Adapter: LiveKit backend ready');
      } else {
        // For MediaSoup, call its initialize method
        await this.backend.initialize();
        logger.debug('✅ WebRTC Adapter: MediaSoup backend ready');
      }

      this.initialized = true;
    } catch (error) {
      logger.error(`❌ WebRTC Adapter: Failed to initialize ${this.backendType}:`, error);
      
      // If LiveKit fails, fall back to MediaSoup
      if (this.backendType === 'livekit') {
        logger.debug('⚠️ WebRTC Adapter: Falling back to MediaSoup');
        this.backendType = 'mediasoup';
        this.backend = new MediasoupService();
        await this.backend.initialize();
        this.initialized = true;
      } else {
        throw error;
      }
    }
  }

  /**
   * Get the current backend type
   */
  getBackendType() {
    return this.backendType;
  }

  /**
   * Get the actual backend service instance
   * For compatibility with existing code that directly accesses mediasoupService
   */
  getBackend() {
    return this.backend;
  }

  /**
   * Check if using MediaSoup
   */
  isMediaSoup() {
    return this.backendType === 'mediasoup';
  }

  /**
   * Check if using LiveKit
   */
  isLiveKit() {
    return this.backendType === 'livekit';
  }

  /**
   * Proxy all method calls to the actual backend
   * This allows the adapter to be used as a drop-in replacement
   */
  
  // Initialization methods (MediaSoup compatibility)
  async initializeMediasoup() {
    // Alias for compatibility with code that calls initializeMediasoup directly
    return await this.initialize();
  }

  // Router/Capabilities methods
  async getRouterRtpCapabilities() {
    await this.ensureInitialized();
    return await this.backend.getRouterRtpCapabilities();
  }

  getRouter() {
    return this.backend.getRouter();
  }

  // Transport methods
  async createWebRtcTransport(socketId, isMobile = false) {
    await this.ensureInitialized();
    return await this.backend.createWebRtcTransport(socketId, isMobile);
  }

  async connectTransport(socketId, dtlsParameters) {
    return await this.backend.connectTransport(socketId, dtlsParameters);
  }

  async restartTransportIce(socketId, transportId) {
    return await this.backend.restartTransportIce(socketId, transportId);
  }

  // Producer methods
  async produce(socketId, kind, rtpParameters, appData) {
    return await this.backend.produce(socketId, kind, rtpParameters, appData);
  }

  async createProducer(socketId, rtpParameters, kind) {
    return await this.backend.createProducer(socketId, rtpParameters, kind);
  }

  // Consumer methods
  async consume(socketId, producerId, rtpCapabilities) {
    return await this.backend.consume(socketId, producerId, rtpCapabilities);
  }

  async createConsumer(consumerSocketId, producerSocketIdOrId, rtpCapabilities, kind = null) {
    // MediaSoup uses different signature - handle both cases
    if (this.isMediaSoup()) {
      return await this.backend.createConsumer(consumerSocketId, producerSocketIdOrId, rtpCapabilities, kind);
    } else {
      // LiveKit uses producerId, not socketId
      return await this.backend.consume(consumerSocketId, producerSocketIdOrId, rtpCapabilities);
    }
  }

  // Stream management
  getCurrentStreamer() {
    return this.backend.getCurrentStreamer();
  }

  // Cleanup methods
  async cleanup(socketId) {
    return await this.backend.cleanup(socketId);
  }

  // Statistics
  getStats() {
    const stats = this.backend.getStats();
    return {
      ...stats,
      adapterBackend: this.backendType
    };
  }

  // Direct property access for compatibility
  get currentStreamer() {
    return this.backend.currentStreamer;
  }

  set currentStreamer(value) {
    this.backend.currentStreamer = value;
  }

  get transports() {
    return this.backend.transports;
  }

  get producers() {
    return this.backend.producers;
  }

  get consumers() {
    return this.backend.consumers;
  }

  get worker() {
    if (this.isMediaSoup()) {
      return this.backend.worker;
    }
    // LiveKit doesn't have workers
    return { appData: { workerId: 'livekit-virtual-worker' } };
  }

  get router() {
    if (this.isMediaSoup()) {
      return this.backend.router;
    }
    // Return a mock router for LiveKit
    return { id: 'livekit-router' };
  }

  /**
   * Ensure the backend is initialized before operations
   */
  async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // For MediaSoup, also ensure the worker/router are initialized
    if (this.isMediaSoup() && !this.backend.router) {
      await this.backend.initializeMediasoup();
    }
  }

  /**
   * Get backend info for monitoring/debugging
   */
  getBackendInfo() {
    return {
      type: this.backendType,
      initialized: this.initialized,
      stats: this.getStats(),
      config: this.config[this.backendType]
    };
  }

  /**
   * Verify participant tracks are ready (proxied to backend)
   */
  async verifyParticipantTracks(participantIdentity, options = {}) {
    await this.ensureInitialized();

    if (this.isLiveKit() && this.backend.verifyParticipantTracks) {
      return await this.backend.verifyParticipantTracks(participantIdentity, options);
    }

    // MediaSoup doesn't need track verification - tracks are created synchronously
    // Just verify the producer exists
    if (this.isMediaSoup()) {
      const producerMap = this.backend.producers.get(participantIdentity);
      if (producerMap && producerMap.size > 0) {
        return {
          verified: true,
          hasVideo: producerMap.has('video'),
          hasAudio: producerMap.has('audio'),
          trackCount: producerMap.size,
          attempt: 1
        };
      }
      return {
        verified: false,
        hasVideo: false,
        hasAudio: false,
        trackCount: 0,
        attempt: 1
      };
    }

    // Fallback - assume ready
    return {
      verified: true,
      hasVideo: true,
      hasAudio: false,
      trackCount: 1,
      attempt: 1
    };
  }

  /**
   * Admin method to switch backend (requires server restart)
   */
  static getCurrentConfiguredBackend() {
    const config = require('../config/webrtc.config');
    return config.backend;
  }

  static setConfiguredBackend(backend) {
    if (!['mediasoup', 'livekit'].includes(backend)) {
      throw new Error(`Invalid backend: ${backend}`);
    }

    // This would typically update a config file or environment variable
    process.env.WEBRTC_BACKEND = backend;
    logger.debug(`📝 WebRTC Adapter: Backend configuration changed to ${backend}`);
    logger.debug('⚠️  Server restart required for changes to take effect');

    return {
      backend: backend,
      requiresRestart: true
    };
  }
}

module.exports = WebRTCAdapter;
