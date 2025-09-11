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
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      enableSctp: false, // Disable SCTP as we don't use DataChannels
      initialAvailableOutgoingBitrate: 300000, // 300kbps balanced
      minimumAvailableOutgoingBitrate: 100000,  // 100kbps minimum
      maxSctpMessageSize: 262144,
      maxIncomingBitrate: 1500000  // 1.5Mbps max - good for most connections
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

    // Create router with comprehensive codec support for all browsers and viewbots
    const mediaCodecs = [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'transport-cc' }
        ]
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1
        },
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1
        },
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '640032',
          'level-asymmetry-allowed': 1
        },
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      }
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

  // Add method to get router for debugging
  getRouter() {
    return this.router;
  }

  async createWebRtcTransport(socketId, isMobile = false) {
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
    
    // Use the isMobile parameter passed from client
    const isMobileClient = isMobile || false;
    
    console.log(`📡 MEDIASOUP: Creating WebRTC transport for ${socketId}...`);
    console.log(`   Transport type: WebRTC`);
    console.log(`   Client type: ${isMobileClient ? 'MOBILE' : 'Desktop'}`);
    console.log(`   TCP enabled: true, UDP enabled: true`);
    
    // Mobile-optimized transport configuration based on MediaSoup best practices
    const transportConfig = {
      ...this.transportOptions,
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>', // IPv4 address
        },
        {
          ip: '::',
          announcedIp: process.env.ANNOUNCED_IPV6 || '2001:db8::1', // IPv6 address for IPv6 clients
        },
      ],
      // Enable both TCP and UDP for compatibility
      enableUdp: true,
      enableTcp: true,
      preferUdp: true, // Prefer UDP for performance
      preferTcp: false,
      // Mobile-optimized bitrate settings as per MediaSoup recommendations
      initialAvailableOutgoingBitrate: isMobileClient ? 800000 : 1000000, // 800kbps mobile, 1Mbps desktop
      minimumAvailableOutgoingBitrate: isMobileClient ? 400000 : 100000, // 400kbps min for mobile stability
      maxIncomingBitrate: isMobileClient ? 2000000 : 3000000, // 2Mbps max mobile, 3Mbps desktop
      // Extended ICE consent timeout for mobile network instability and cell tower handovers
      iceConsentTimeout: isMobileClient ? 45 : 12, // 45 seconds mobile (for TURN relay), 12 desktop (default)
      // Extended DTLS handshake timeout for relay connections
      dtlsHandshakeTimeoutMs: isMobileClient ? 30000 : 5000, // 30s mobile, 5s desktop
      // Enable SCTP for data channels
      enableSctp: true,
      numSctpStreams: { OS: 1024, MIS: 1024 },
      // MediaSoup uses ICE-lite - TURN must be configured client-side only
      appData: {
        socketId,
        clientType: isMobileClient ? 'mobile' : 'desktop',
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

  async restartTransportIce(socketId, transportId) {
    const transport = this.transports.get(socketId);
    if (!transport || transport.id !== transportId) {
      throw new Error(`Transport not found for socket ${socketId}`);
    }
    
    // Generate new ICE parameters for the transport
    const iceParameters = await transport.restartIce();
    console.log(`🔄 MEDIASOUP: ICE restart for transport ${transportId} (socket: ${socketId})`);
    return iceParameters;
  }

  async produce(socketId, kind, rtpParameters, appData) {
    console.log('=== MEDIASOUP PRODUCE METHOD ===');
    console.log('Socket ID:', socketId);
    console.log('Kind:', kind);
    console.log('RTP Parameters MID:', rtpParameters?.mid);
    console.log('RTP Codecs:', rtpParameters?.codecs?.map(c => c.mimeType));
    
    const transport = this.transports.get(socketId);
    if (!transport) {
      console.error(`Transport not found for ${socketId}. Available transports:`, Array.from(this.transports.keys()));
      throw new Error(`Transport not found for ${socketId}`);
    }

    console.log('Transport found, attempting to produce...');
    console.log('Transport ID:', transport.id);
    console.log('Transport closed:', transport.closed);
    
    try {
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData
      });

      console.log('Producer created successfully!');
      console.log('Producer ID:', producer.id);
      console.log('Producer MID:', producer.rtpParameters?.mid);

      producer.on('transportclose', () => {
        console.log(`Producer ${producer.id} closed due to transport close`);
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
      console.log('Total producers for this socket:', this.producers.get(socketId).size);
      
      return producer.id;
    } catch (error) {
      console.error('Failed to create producer:');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('RTP Parameters that failed:', JSON.stringify(rtpParameters, null, 2));
      throw error;
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

  async consume(consumerSocketId, producerId, rtpCapabilities) {
    // Find the producer by ID
    let foundProducer = null;
    let producerSocketId = null;
    
    for (const [socketId, producerMap] of this.producers.entries()) {
      for (const [kind, producer] of producerMap.entries()) {
        if (producer.id === producerId) {
          foundProducer = producer;
          producerSocketId = socketId;
          break;
        }
      }
      if (foundProducer) break;
    }
    
    if (!foundProducer) {
      console.error(`❌ MEDIASOUP: Producer ${producerId} not found`);
      return null;
    }
    
    const consumerTransport = this.transports.get(consumerSocketId);
    if (!consumerTransport) {
      console.error(`❌ MEDIASOUP: No transport found for consumer ${consumerSocketId}`);
      return null;
    }
    
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      console.error(`❌ MEDIASOUP: Cannot consume producer ${producerId}`);
      return null;
    }
    
    const consumer = await consumerTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true
    });
    
    // Store consumer
    if (!this.consumers.has(consumerSocketId)) {
      this.consumers.set(consumerSocketId, new Set());
    }
    this.consumers.get(consumerSocketId).add(consumer);
    
    consumer.on('transportclose', () => {
      console.log(`🔌 MEDIASOUP: Consumer transport closed for ${consumerSocketId}`);
      consumer.close();
    });
    
    consumer.on('producerclose', () => {
      console.log(`🔌 MEDIASOUP: Producer closed for consumer ${consumerSocketId}`);
      consumer.close();
    });
    
    // Resume consumer
    await consumer.resume();
    
    console.log(`✅ MEDIASOUP: Consumer created for ${consumerSocketId} from producer ${producerId}`);
    
    return consumer;
  }

  async createConsumer(consumerSocketId, producerSocketId, rtpCapabilities, kind = null) {
    const consumerTransport = this.transports.get(consumerSocketId);
    let producerMap = this.producers.get(producerSocketId);

    console.log(`📺 MEDIASOUP: Creating consumer for ${consumerSocketId} from producer ${producerSocketId}`);
    console.log(`📺 MEDIASOUP: Consumer transport exists: ${!!consumerTransport}`);
    console.log(`📺 MEDIASOUP: Producer map exists: ${!!producerMap}, size: ${producerMap?.size || 0}`);

    // Validate transport state before attempting to create consumer
    if (!consumerTransport) {
      console.error(`❌ MEDIASOUP: No transport found for consumer ${consumerSocketId}`);
      return null;
    }

    if (consumerTransport.closed) {
      console.error(`❌ MEDIASOUP: Consumer transport is closed for ${consumerSocketId}`);
      return null;
    }

    // Check transport connection state
    if (consumerTransport.connectionState === 'failed') {
      console.error(`❌ MEDIASOUP: Consumer transport in failed state for ${consumerSocketId}`);
      return null;
    }

    // Check if this is a viewbot Plain RTP producer that needs bridging for mobile
    // The producer socket ID won't contain 'viewbot', but the producer will have isViewBot flag
    let isViewbotProducer = false;
    
    console.log(`🔍 MEDIASOUP: Checking if producer ${producerSocketId} is viewbot...`);
    console.log(`   Producer map exists: ${!!producerMap}`);
    console.log(`   Producer map size: ${producerMap?.size || 0}`);
    
    // Check if any producer has isViewBot flag in appData
    if (!isViewbotProducer && producerMap) {
      for (const producer of producerMap.values()) {
        console.log(`   Checking producer ${producer.id}:`, {
          kind: producer.kind,
          hasAppData: !!producer.appData,
          isViewBot: producer.appData?.isViewBot,
          appData: producer.appData
        });
        if (producer.appData && producer.appData.isViewBot) {
          isViewbotProducer = true;
          console.log(`🤖 MEDIASOUP: Detected viewbot producer via appData.isViewBot flag`);
          break;
        }
      }
    }
    
    console.log(`🔍 MEDIASOUP: Is viewbot producer: ${isViewbotProducer}`);
    
    // For viewbot producers, note the limitation
    // Plain RTP producers don't support ICE/TURN which mobile clients need
    if (isViewbotProducer) {
      console.log(`📱 MEDIASOUP: Viewbot producer detected - mobile clients may have issues`);
      console.log(`   Note: Plain RTP producers don't support ICE/TURN needed by mobile networks`);
      // Continue with normal consumption but note this may fail on mobile
    }
    
    if (isViewbotProducer && producerMap) {
      console.log(`🤖 MEDIASOUP: Viewbot Plain RTP producer detected - creating WebRTC bridge for mobile compatibility`);
      
      // For viewbot Plain RTP producers, ALL clients should consume normally
      // The issue is that Plain RTP doesn't support ICE/TURN for mobile
      // MediaSoup doesn't support producing to WebRTC transport from server side
      // So we'll just log the limitation
      console.log(`⚠️ MEDIASOUP: Viewbot Plain RTP producer detected`);
      console.log(`   Mobile clients may have connectivity issues due to lack of ICE/TURN support`);
      console.log(`   Plain RTP producers cannot be bridged to WebRTC automatically`);
      
      // Continue with normal consumption - will work for desktop, may fail for mobile
      // The real fix is to have viewbots use WebRTC from the start
    }

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

    // Validate producer state before creating consumer
    if (producer.closed) {
      console.error(`❌ MEDIASOUP: Producer is closed for ${producerSocketId} (${producer.kind})`);
      return null;
    }

    if (producer.paused) {
      console.warn(`⚠️ MEDIASOUP: Producer is paused for ${producerSocketId} (${producer.kind}), attempting to consume anyway`);
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

    // Also clean up any transports without active producers (likely from failed rotations)
    for (const [socketId, transport] of this.transports.entries()) {
      // Skip current streamer
      if (socketId === this.currentStreamer) continue;
      
      // Check if transport has any active consumers
      const hasConsumers = this.consumers.has(socketId) && this.consumers.get(socketId).size > 0;
      
      // If transport exists but no producers AND no consumers, and it's older than 30 seconds, clean it up
      if (!this.producers.has(socketId) && !hasConsumers && transport.appData?.createdAt && (now - transport.appData.createdAt) > 30000) {
        console.log(`🧹 MEDIASOUP: Cleaning up orphaned transport for ${socketId} (no producers or consumers)`);
        this.cleanupSocketResources(socketId);
        cleanupCount++;
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
        // Handle both single transport and ViewBot dual transport cases
        if (transport.video && transport.audio) {
          // ViewBot case with separate video and audio transports
          if (!transport.video.closed) {
            transport.video.close();
            console.log(`🔒 Closed video transport for ${socketId}`);
          }
          if (!transport.audio.closed) {
            transport.audio.close();
            console.log(`🔒 Closed audio transport for ${socketId}`);
          }
        } else if (transport.close && typeof transport.close === 'function') {
          // Regular single transport case
          if (!transport.closed) {
            transport.close();
          }
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