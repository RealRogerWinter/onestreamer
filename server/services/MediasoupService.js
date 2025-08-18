const mediasoup = require('mediasoup');

class MediasoupService {
  constructor() {
    this.worker = null;
    this.router = null;
    this.transports = new Map(); // socketId -> transport
    this.producers = new Map(); // socketId -> Map of producers by kind
    this.consumers = new Map(); // socketId -> Set of consumers
    this.rooms = new Map(); // roomId -> room info
    this.currentStreamer = null;
    
    // Optimized resource limits for better performance
    this.maxTransports = 200; // Increased for better scalability
    this.maxProducersPerUser = 10; // Support more media tracks
    this.maxConsumersPerUser = 20; // Support more viewers
    this.transportTimeout = 90000; // 90 seconds for slower connections
    this.cleanupInterval = 30000; // 30 seconds
    
    // Performance optimization settings
    this.rtpCapabilities = null; // Cache RTP capabilities
    this.transportOptions = {
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || null
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      enableSctp: false, // Disable SCTP as we don't use DataChannels
      initialAvailableOutgoingBitrate: 600000,
      minimumAvailableOutgoingBitrate: 200000,
      maxSctpMessageSize: 262144,
      maxIncomingBitrate: 5000000
    }
    
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  async initialize() {
    console.log('🎬 MEDIASOUP: Initializing mediasoup worker...');
    
    try {
      // Create mediasoup worker with optimized settings
      this.worker = await mediasoup.createWorker({
        logLevel: process.env.NODE_ENV === 'production' ? 'error' : 'warn',
        rtcMinPort: 50000, // Reduced port range for better management
        rtcMaxPort: 50199, // 200 ports should be sufficient
        dtlsCertificateFile: process.env.DTLS_CERT_FILE,
        dtlsPrivateKeyFile: process.env.DTLS_KEY_FILE,
        appData: { workerId: Date.now() }
      });

      this.worker.on('died', () => {
        console.error('❌ MEDIASOUP: Worker died unexpectedly!');
        console.error('❌ MEDIASOUP: This is usually due to port conflicts or system resource issues');
        // Don't exit immediately, let the server continue without mediasoup
        this.worker = null;
      });

      console.log('✅ MEDIASOUP: Worker created successfully');
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to create worker:', error.message);
      console.log('⚠️ MEDIASOUP: Server will continue without mediasoup functionality');
      this.worker = null;
      return;
    }

    // Only create router if worker was created successfully
    if (!this.worker) {
      return;
    }

    // Create router
    const mediaCodecs = [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        parameters: {
          'minptime': 10,
          'useinbandfec': 1,
          'usedtx': 0,  // Disabled DTX to prevent audio cutoff
          'sprop-maxcapturerate': 48000,
          'stereo': 1,
          'sprop-stereo': 1,
          'cbr': 0,
          'maxaveragebitrate': 128000,
          'maxplaybackrate': 48000,
          'ptime': 20
        }
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 2500, // Higher initial bitrate
          'x-google-max-bitrate': 5000,
          'x-google-min-bitrate': 500,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: {
          'profile-id': 2,
          'x-google-start-bitrate': 2500, // Higher initial bitrate
          'x-google-max-bitrate': 5000,
          'x-google-min-bitrate': 500,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 2500, // Higher initial bitrate
          'x-google-max-bitrate': 5000,
          'x-google-min-bitrate': 500,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 2500, // Higher initial bitrate
          'x-google-max-bitrate': 5000,
          'x-google-min-bitrate': 500,
        },
      },
    ];

    this.router = await this.worker.createRouter({ mediaCodecs });
    console.log('✅ MEDIASOUP: Router created successfully');
  }

  async getRouterRtpCapabilities() {
    if (!this.router) {
      throw new Error('MediaSoup router not available');
    }
    return this.router.rtpCapabilities;
  }

  async createWebRtcTransport(socketId) {
    console.log(`📡 MEDIASOUP: Creating transport for ${socketId} (current streamer: ${this.currentStreamer})`);
    
    // Check if MediaSoup is properly initialized
    if (!this.worker || !this.router) {
      console.error('❌ MEDIASOUP: Worker or router not initialized');
      throw new Error('MediaSoup not initialized. Worker or router is null.');
    }
    
    // Check if worker is still alive
    if (this.worker.closed) {
      console.error('❌ MEDIASOUP: Worker is closed');
      throw new Error('MediaSoup worker is closed');
    }
    
    // Check resource limits
    if (this.transports.size >= this.maxTransports) {
      throw new Error('Maximum number of transports reached');
    }
    
    // Clean up existing transport for this socket
    await this.cleanupSocketResources(socketId);
    
    // Small delay to ensure cleanup completes
    await new Promise(resolve => setTimeout(resolve, 50));
    
    console.log(`📡 MEDIASOUP: Creating WebRTC transport for ${socketId}...`);
    
    // Use optimized transport options from constructor
    const transportConfig = {
      ...this.transportOptions,
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1', // Use env var for production
        },
      ],
      initialAvailableOutgoingBitrate: 1000000, // 1 Mbps initial
      minimumAvailableOutgoingBitrate: 300000, // 300 kbps minimum
      maxIncomingBitrate: 5000000, // 5 Mbps max incoming
      iceServers: process.env.NODE_ENV === 'production' ? [] : [ // Skip TURN in local dev
        {
          urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
        }
      ],
      appData: {
        socketId,
        createdAt: Date.now()
      }
    };
    
    const transport = await this.router.createWebRtcTransport(transportConfig);

    transport.on('dtlsstatechange', (dtlsState) => {
      console.log(`🔄 MEDIASOUP: Transport DTLS state changed for ${socketId}: ${dtlsState}`);
      if (dtlsState === 'closed') {
        this.cleanupTransport(socketId);
      }
    });

    transport.on('close', () => {
      console.log(`🔒 MEDIASOUP: Transport closed for ${socketId}`);
      this.cleanupTransport(socketId);
    });

    // Set creation timestamp for timeout tracking
    transport.createdAt = Date.now();
    transport.socketId = socketId;
    
    this.transports.set(socketId, transport);
    console.log(`📡 MEDIASOUP: Created WebRTC transport for ${socketId} (${this.transports.size}/${this.maxTransports})`);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(socketId, dtlsParameters) {
    console.log(`🔗 MEDIASOUP: Attempting to connect transport for ${socketId}`);
    console.log(`🔗 MEDIASOUP: Current transports:`, Array.from(this.transports.keys()));
    console.log(`🔗 MEDIASOUP: Total transports: ${this.transports.size}`);
    
    // Add retry logic for race conditions
    let transport;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      attempts++;
      transport = this.transports.get(socketId);
      
      if (transport) {
        break;
      }
      
      if (attempts < maxAttempts) {
        console.log(`🔄 MEDIASOUP: Transport not found for ${socketId}, attempt ${attempts}/${maxAttempts}, waiting...`);
        await new Promise(resolve => setTimeout(resolve, 100 * attempts));
      }
    }
    
    if (!transport) {
      console.error(`❌ MEDIASOUP: Transport not found for ${socketId} after ${maxAttempts} attempts`);
      console.error(`❌ MEDIASOUP: Available transports: ${Array.from(this.transports.keys()).join(', ')}`);
      throw new Error(`Transport not found for ${socketId} after ${maxAttempts} attempts. Available: ${Array.from(this.transports.keys()).join(', ')}`);
    }

    if (transport.closed) {
      console.error(`❌ MEDIASOUP: Transport is already closed for ${socketId}`);
      throw new Error(`Transport is closed for ${socketId}`);
    }

    console.log(`🔗 MEDIASOUP: Transport found for ${socketId}, connecting...`);
    
    try {
      await transport.connect({ dtlsParameters });
      console.log(`✅ MEDIASOUP: Transport connected successfully for ${socketId}`);
    } catch (connectError) {
      console.error(`❌ MEDIASOUP: Failed to connect transport for ${socketId}:`, connectError);
      // Clean up the failed transport
      await this.cleanupSocketResources(socketId);
      throw connectError;
    }
  }

  async createProducer(socketId, rtpParameters, kind) {
    const transport = this.transports.get(socketId);
    if (!transport) {
      throw new Error(`Transport not found for ${socketId}`);
    }

    const producer = await transport.produce({
      kind,
      rtpParameters,
    });

    producer.on('transportclose', () => {
      producer.close();
    });

    // Store producer by socketId and kind
    if (!this.producers.has(socketId)) {
      this.producers.set(socketId, new Map());
    }
    this.producers.get(socketId).set(kind, producer);
    this.currentStreamer = socketId;

    console.log(`📺 MEDIASOUP: Producer created for ${socketId} (${kind})`);
    console.log(`🎯 MEDIASOUP: ${socketId} is now the active streamer`);

    return {
      id: producer.id,
    };
  }

  async createConsumer(consumerSocketId, producerSocketId, rtpCapabilities, kind = null) {
    const consumerTransport = this.transports.get(consumerSocketId);
    const producerMap = this.producers.get(producerSocketId);

    console.log(`📺 MEDIASOUP: Creating consumer for ${consumerSocketId} from producer ${producerSocketId}`);
    console.log(`📺 MEDIASOUP: Consumer transport exists: ${!!consumerTransport}`);
    console.log(`📺 MEDIASOUP: Producer map exists: ${!!producerMap}, size: ${producerMap?.size || 0}`);

    if (!consumerTransport || !producerMap) {
      console.error(`❌ MEDIASOUP: Missing components for consumer creation`);
      console.error(`Consumer transport: ${!!consumerTransport}`);
      console.error(`Producer map: ${!!producerMap}`);
      return null;
    }

    // If kind is specified, get the specific producer; otherwise get the first available
    let producer;
    if (kind) {
      producer = producerMap.get(kind);
      if (!producer) {
        console.error(`❌ MEDIASOUP: No ${kind} producer found for ${producerSocketId}`);
        return null;
      }
    } else {
      // Get first available producer (for backward compatibility)
      producer = producerMap.values().next().value;
      if (!producer) {
        console.error(`❌ MEDIASOUP: No producers found for ${producerSocketId}`);
        return null;
      }
    }

    if (!this.router.canConsume({
      producerId: producer.id,
      rtpCapabilities,
    })) {
      console.error(`❌ MEDIASOUP: Cannot consume producer ${producer.id} (${producer.kind})`);
      return null;
    }

    // Optimized consumer settings for better performance
    const consumer = await consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
      // Preferred layers for simulcast (if available)
      preferredLayers: {
        spatialLayer: 2, // Highest spatial layer
        temporalLayer: 2  // Highest temporal layer
      },
      // Consumer pipe for low latency
      pipe: false
    });

    consumer.on('transportclose', () => {
      consumer.close();
    });

    consumer.on('producerclose', () => {
      consumer.close();
    });

    // Store consumer
    if (!this.consumers.has(consumerSocketId)) {
      this.consumers.set(consumerSocketId, new Set());
    }
    this.consumers.get(consumerSocketId).add(consumer);

    console.log(`📺 MEDIASOUP: Consumer created for ${consumerSocketId} from ${producerSocketId} (${producer.kind})`);

    return {
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerId: producer.id,
    };
  }

  async resumeConsumer(socketId, consumerId) {
    const consumers = this.consumers.get(socketId);
    if (!consumers) {
      throw new Error(`No consumers found for socket ${socketId}`);
    }

    for (const consumer of consumers) {
      if (consumer.id === consumerId) {
        // Check if consumer is still valid before resuming
        if (consumer.closed) {
          throw new Error(`Consumer ${consumerId} is closed`);
        }
        
        try {
          await consumer.resume();
          console.log(`▶️ MEDIASOUP: Consumer ${consumerId} resumed for ${socketId}`);
          return;
        } catch (error) {
          console.error(`❌ MEDIASOUP: Failed to resume consumer ${consumerId}: ${error.message}`);
          throw error;
        }
      }
    }
    
    throw new Error(`Consumer ${consumerId} not found for socket ${socketId}`);
  }

  getCurrentStreamer() {
    return this.currentStreamer;
  }

  hasActiveProducer() {
    return this.currentStreamer && this.producers.has(this.currentStreamer) && 
           this.producers.get(this.currentStreamer).size > 0;
  }

  hasProducer(socketId, kind) {
    const producerMap = this.producers.get(socketId);
    if (!producerMap) return false;
    
    if (kind) {
      return producerMap.has(kind);
    }
    
    return producerMap.size > 0;
  }

  startPeriodicCleanup() {
    setInterval(() => {
      this.performPeriodicCleanup();
    }, this.cleanupInterval);
  }

  performPeriodicCleanup() {
    const now = Date.now();
    let cleanupCount = 0;

    // Clean up old unused transports
    for (const [socketId, transport] of this.transports.entries()) {
      if (transport.createdAt && (now - transport.createdAt) > this.transportTimeout) {
        if (!this.producers.has(socketId) && !this.consumers.has(socketId)) {
          console.log(`🧹 MEDIASOUP: Cleaning up stale transport for ${socketId}`);
          this.cleanupSocketResources(socketId);
          cleanupCount++;
        }
      }
    }

    if (cleanupCount > 0) {
      console.log(`🧹 MEDIASOUP: Periodic cleanup completed, removed ${cleanupCount} stale resources`);
    }
  }

  async cleanupSocketResources(socketId) {
    console.log(`🧹 MEDIASOUP: Cleaning up all resources for ${socketId}`);

    // Clean up consumers first
    const consumers = this.consumers.get(socketId);
    if (consumers) {
      for (const consumer of consumers) {
        try {
          if (!consumer.closed) {
            consumer.close();
          }
        } catch (error) {
          console.warn(`⚠️ MEDIASOUP: Error closing consumer: ${error.message}`);
        }
      }
      this.consumers.delete(socketId);
    }

    // Clean up producers
    const producerMap = this.producers.get(socketId);
    if (producerMap) {
      for (const [kind, producer] of producerMap.entries()) {
        try {
          if (!producer.closed) {
            producer.close();
            console.log(`🛑 MEDIASOUP: Closed ${kind} producer for ${socketId}`);
          }
        } catch (error) {
          console.warn(`⚠️ MEDIASOUP: Error closing producer: ${error.message}`);
        }
      }
      this.producers.delete(socketId);
      
      // Only clear currentStreamer if this socketId is still the current streamer
      // (Don't clear during takeovers where a new streamer has already been set)
      if (this.currentStreamer === socketId) {
        this.currentStreamer = null;
        console.log(`🎯 MEDIASOUP: Streamer ${socketId} disconnected, no active streamer`);
      } else if (this.currentStreamer) {
        console.log(`🎯 MEDIASOUP: Cleaning up ${socketId} but ${this.currentStreamer} is current streamer`);
      }
    }

    // Clean up transport last
    this.cleanupTransport(socketId);
  }

  cleanupTransport(socketId) {
    const transport = this.transports.get(socketId);
    if (transport) {
      try {
        if (!transport.closed) {
          transport.close();
        }
      } catch (error) {
        console.warn(`⚠️ MEDIASOUP: Error closing transport: ${error.message}`);
      }
      this.transports.delete(socketId);
      console.log(`🔒 MEDIASOUP: Transport cleaned up for ${socketId}`);
    }
  }

  // Backward compatibility
  cleanup(socketId) {
    this.cleanupSocketResources(socketId);
  }

  // Clean up all resources (for server shutdown)
  cleanupAll() {
    console.log('🧹 MEDIASOUP: Cleaning up all resources...');
    
    // Clear the cleanup interval
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    
    // Clean up all socket resources
    const socketIds = Array.from(this.producers.keys());
    for (const socketId of socketIds) {
      this.cleanupSocketResources(socketId);
    }
    
    // Clear all maps
    this.producers.clear();
    this.consumers.clear();
    this.transports.clear();
    this.currentStreamer = null;
    
    console.log('✅ MEDIASOUP: All resources cleaned up');
  }

  getStats() {
    const totalProducers = Array.from(this.producers.values()).reduce((total, producerMap) => total + producerMap.size, 0);
    return {
      activeStreamer: this.currentStreamer,
      transportCount: this.transports.size,
      producerCount: totalProducers,
      consumerCount: Array.from(this.consumers.values()).reduce((total, consumers) => total + consumers.size, 0),
    };
  }
}

module.exports = MediasoupService;