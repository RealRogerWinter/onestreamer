const mediasoup = require('mediasoup');

const logger = require('../bootstrap/logger').child({ svc: 'MediasoupService' });

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
    logger.debug('🎬 MEDIASOUP: Initializing mediasoup worker...');
    
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
        logger.error('❌ MEDIASOUP: Worker died unexpectedly!');
        logger.error('❌ MEDIASOUP: This is usually due to port conflicts or system resource issues');
        // Don't exit immediately, let the server continue without mediasoup
        this.worker = null;
      });

      logger.debug('✅ MEDIASOUP: Worker created successfully');
    } catch (error) {
      logger.error('❌ MEDIASOUP: Failed to create worker:', error.message);
      logger.debug('⚠️ MEDIASOUP: Server will continue without mediasoup functionality');
      this.worker = null;
      return;
    }

    // Only create router if worker was created successfully
    if (!this.worker) {
      return;
    }

    // CRITICAL iOS FIX: Optimized codec configuration for iOS Safari compatibility
    // H264 Baseline (42e01f) is placed first and includes iOS-specific parameters
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
      // CRITICAL: H264 Baseline Profile - iOS Safari's REQUIRED codec
      {
        kind: 'video',
        mimeType: 'video/H264', // Capital H for better cross-browser compatibility
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f', // Baseline Profile Level 3.1 - iOS preferred
          'level-asymmetry-allowed': 1,
          // iOS-specific optimizations
          'x-google-start-bitrate': 1000, // Help iOS with initial bitrate (1 Mbps)
          'x-google-max-bitrate': 2500 // Max bitrate 2.5 Mbps
        },
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      },
      // H264 Main Profile for desktop browsers (Chrome, Firefox)
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032', // Main Profile Level 5.0
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
      // VP8 for older browsers (placed after H264 for priority)
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
      }
      // Removed: H264 High Profile (640032) - iOS doesn't support it well
      // Removed: VP9 - iOS Safari doesn't support it
    ];

    this.router = await this.worker.createRouter({ mediaCodecs });
    logger.debug('✅ MEDIASOUP: Router created successfully');
  }

  async getRouterRtpCapabilities(preferH264 = false) {
    if (!this.router) {
      throw new Error('MediaSoup router not available');
    }

    const capabilities = this.router.rtpCapabilities;

    // CRITICAL iOS FIX: Reorder codecs for iOS/Safari to prefer H264 Baseline
    if (preferH264 && capabilities.codecs) {
      logger.debug('📱 MEDIASOUP: Optimizing RTP capabilities for iOS Safari');

      const codecs = [...capabilities.codecs];
      const videoCodecs = codecs.filter(c => c.kind === 'video');
      const audioCodecs = codecs.filter(c => c.kind === 'audio');

      // Find H264 Baseline (42e01f) - iOS Safari's preferred codec
      const h264Baseline = videoCodecs.find(c =>
        c.mimeType?.toLowerCase() === 'video/h264' &&
        c.parameters?.['profile-level-id'] === '42e01f'
      );

      if (h264Baseline) {
        logger.debug('✅ MEDIASOUP: Found H264 Baseline codec for iOS');

        // Put audio codecs first, then H264 Baseline ONLY for iOS
        // This simplifies codec negotiation and prevents iOS confusion
        const optimizedCodecs = [
          ...audioCodecs,
          h264Baseline,
          // Only include Main profile as fallback, skip High profile and VP8/VP9
          ...videoCodecs.filter(c =>
            c.mimeType?.toLowerCase() === 'video/h264' &&
            c.parameters?.['profile-level-id'] === '4d0032'
          )
        ];

        return {
          ...capabilities,
          codecs: optimizedCodecs
        };
      } else {
        logger.warn('⚠️ MEDIASOUP: H264 Baseline codec not found for iOS');
      }
    }

    return capabilities;
  }

  // Add method to get router for debugging
  getRouter() {
    return this.router;
  }

  async createWebRtcTransport(socketId, isMobile = false) {
    logger.debug(`📡 MEDIASOUP: Creating transport for ${socketId} (current streamer: ${this.currentStreamer})`);
    
    // Check if MediaSoup is properly initialized
    if (!this.worker || !this.router) {
      logger.error('❌ MEDIASOUP: Worker or router not initialized');
      throw new Error('MediaSoup not initialized. Worker or router is null.');
    }
    
    // Check if worker is still alive
    if (this.worker.closed) {
      logger.error('❌ MEDIASOUP: Worker is closed');
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
    
    logger.debug(`📡 MEDIASOUP: Creating WebRTC transport for ${socketId}...`);
    logger.debug(`   Transport type: WebRTC`);
    logger.debug(`   Client type: ${isMobileClient ? 'MOBILE' : 'Desktop'}`);
    logger.debug(`   TCP enabled: true, UDP enabled: true`);
    
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
      logger.debug(`🔄 MEDIASOUP: Transport DTLS state changed for ${socketId}: ${dtlsState}`);
      if (dtlsState === 'closed') {
        this.cleanupTransport(socketId);
      }
    });

    transport.on('close', () => {
      logger.debug(`🔒 MEDIASOUP: Transport closed for ${socketId}`);
      this.cleanupTransport(socketId);
    });

    // Set creation timestamp for timeout tracking
    transport.createdAt = Date.now();
    transport.socketId = socketId;
    
    this.transports.set(socketId, transport);
    logger.debug(`📡 MEDIASOUP: Created WebRTC transport for ${socketId} (${this.transports.size}/${this.maxTransports})`);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(socketId, dtlsParameters) {
    logger.debug(`🔗 MEDIASOUP: Attempting to connect transport for ${socketId}`);
    logger.debug(`🔗 MEDIASOUP: Current transports:`, Array.from(this.transports.keys()));
    logger.debug(`🔗 MEDIASOUP: Total transports: ${this.transports.size}`);
    
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
        logger.debug(`🔄 MEDIASOUP: Transport not found for ${socketId}, attempt ${attempts}/${maxAttempts}, waiting...`);
        await new Promise(resolve => setTimeout(resolve, 100 * attempts));
      }
    }
    
    if (!transport) {
      logger.error(`❌ MEDIASOUP: Transport not found for ${socketId} after ${maxAttempts} attempts`);
      logger.error(`❌ MEDIASOUP: Available transports: ${Array.from(this.transports.keys()).join(', ')}`);
      throw new Error(`Transport not found for ${socketId} after ${maxAttempts} attempts. Available: ${Array.from(this.transports.keys()).join(', ')}`);
    }

    if (transport.closed) {
      logger.error(`❌ MEDIASOUP: Transport is already closed for ${socketId}`);
      throw new Error(`Transport is closed for ${socketId}`);
    }

    logger.debug(`🔗 MEDIASOUP: Transport found for ${socketId}, connecting...`);
    
    try {
      await transport.connect({ dtlsParameters });
      logger.debug(`✅ MEDIASOUP: Transport connected successfully for ${socketId}`);
    } catch (connectError) {
      logger.error(`❌ MEDIASOUP: Failed to connect transport for ${socketId}:`, connectError);
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
    logger.debug(`🔄 MEDIASOUP: ICE restart for transport ${transportId} (socket: ${socketId})`);
    return iceParameters;
  }

  async produce(socketId, kind, rtpParameters, appData) {
    logger.debug('=== MEDIASOUP PRODUCE METHOD ===');
    logger.debug('Socket ID:', socketId);
    logger.debug('Kind:', kind);
    logger.debug('RTP Parameters MID:', rtpParameters?.mid);
    logger.debug('RTP Codecs:', rtpParameters?.codecs?.map(c => c.mimeType));
    
    const transport = this.transports.get(socketId);
    if (!transport) {
      logger.error(`Transport not found for ${socketId}. Available transports:`, Array.from(this.transports.keys()));
      throw new Error(`Transport not found for ${socketId}`);
    }

    logger.debug('Transport found, attempting to produce...');
    logger.debug('Transport ID:', transport.id);
    logger.debug('Transport closed:', transport.closed);
    
    try {
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData
      });

      logger.debug('Producer created successfully!');
      logger.debug('Producer ID:', producer.id);
      logger.debug('Producer MID:', producer.rtpParameters?.mid);

      producer.on('transportclose', () => {
        logger.debug(`Producer ${producer.id} closed due to transport close`);
        producer.close();
      });

      // Store producer by socketId and kind
      if (!this.producers.has(socketId)) {
        this.producers.set(socketId, new Map());
      }
      this.producers.get(socketId).set(kind, producer);
      this.currentStreamer = socketId;

      logger.debug(`📺 MEDIASOUP: Producer created for ${socketId} (${kind})`);
      logger.debug(`🎯 MEDIASOUP: ${socketId} is now the active streamer`);
      logger.debug('Total producers for this socket:', this.producers.get(socketId).size);
      
      return producer.id;
    } catch (error) {
      logger.error('Failed to create producer:');
      logger.error('Error message:', error.message);
      logger.error('Error stack:', error.stack);
      logger.error('RTP Parameters that failed:', JSON.stringify(rtpParameters, null, 2));
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

    logger.debug(`📺 MEDIASOUP: Producer created for ${socketId} (${kind})`);
    logger.debug(`🎯 MEDIASOUP: ${socketId} is now the active streamer`);

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
      logger.error(`❌ MEDIASOUP: Producer ${producerId} not found`);
      return null;
    }
    
    const consumerTransport = this.transports.get(consumerSocketId);
    if (!consumerTransport) {
      logger.error(`❌ MEDIASOUP: No transport found for consumer ${consumerSocketId}`);
      return null;
    }
    
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      logger.error(`❌ MEDIASOUP: Cannot consume producer ${producerId}`);
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
      logger.debug(`🔌 MEDIASOUP: Consumer transport closed for ${consumerSocketId}`);
      consumer.close();
    });
    
    consumer.on('producerclose', () => {
      logger.debug(`🔌 MEDIASOUP: Producer closed for consumer ${consumerSocketId}`);
      consumer.close();
    });
    
    // Resume consumer
    await consumer.resume();
    
    logger.debug(`✅ MEDIASOUP: Consumer created for ${consumerSocketId} from producer ${producerId}`);
    
    return consumer;
  }

  async createConsumer(consumerSocketId, producerSocketId, rtpCapabilities, kind = null) {
    const consumerTransport = this.transports.get(consumerSocketId);
    let producerMap = this.producers.get(producerSocketId);

    logger.debug(`📺 MEDIASOUP: Creating consumer for ${consumerSocketId} from producer ${producerSocketId}`);
    logger.debug(`📺 MEDIASOUP: Consumer transport exists: ${!!consumerTransport}`);
    logger.debug(`📺 MEDIASOUP: Producer map exists: ${!!producerMap}, size: ${producerMap?.size || 0}`);

    // Validate transport state before attempting to create consumer
    if (!consumerTransport) {
      logger.error(`❌ MEDIASOUP: No transport found for consumer ${consumerSocketId}`);
      return null;
    }

    if (consumerTransport.closed) {
      logger.error(`❌ MEDIASOUP: Consumer transport is closed for ${consumerSocketId}`);
      return null;
    }

    // Check transport connection state
    if (consumerTransport.connectionState === 'failed') {
      logger.error(`❌ MEDIASOUP: Consumer transport in failed state for ${consumerSocketId}`);
      return null;
    }

    // Check if this is a viewbot Plain RTP producer that needs bridging for mobile
    // The producer socket ID won't contain 'viewbot', but the producer will have isViewBot flag
    let isViewbotProducer = false;
    
    logger.debug(`🔍 MEDIASOUP: Checking if producer ${producerSocketId} is viewbot...`);
    logger.debug(`   Producer map exists: ${!!producerMap}`);
    logger.debug(`   Producer map size: ${producerMap?.size || 0}`);
    
    // Check if any producer has isViewBot flag in appData
    if (!isViewbotProducer && producerMap) {
      for (const producer of producerMap.values()) {
        logger.debug(`   Checking producer ${producer.id}:`, {
          kind: producer.kind,
          hasAppData: !!producer.appData,
          isViewBot: producer.appData?.isViewBot,
          appData: producer.appData
        });
        if (producer.appData && producer.appData.isViewBot) {
          isViewbotProducer = true;
          logger.debug(`🤖 MEDIASOUP: Detected viewbot producer via appData.isViewBot flag`);
          break;
        }
      }
    }
    
    logger.debug(`🔍 MEDIASOUP: Is viewbot producer: ${isViewbotProducer}`);
    
    // For viewbot producers, note the limitation
    // Plain RTP producers don't support ICE/TURN which mobile clients need
    if (isViewbotProducer) {
      logger.debug(`📱 MEDIASOUP: Viewbot producer detected - mobile clients may have issues`);
      logger.debug(`   Note: Plain RTP producers don't support ICE/TURN needed by mobile networks`);
      // Continue with normal consumption but note this may fail on mobile
    }
    
    if (isViewbotProducer && producerMap) {
      logger.debug(`🤖 MEDIASOUP: Viewbot Plain RTP producer detected - creating WebRTC bridge for mobile compatibility`);
      
      // For viewbot Plain RTP producers, ALL clients should consume normally
      // The issue is that Plain RTP doesn't support ICE/TURN for mobile
      // MediaSoup doesn't support producing to WebRTC transport from server side
      // So we'll just log the limitation
      logger.debug(`⚠️ MEDIASOUP: Viewbot Plain RTP producer detected`);
      logger.debug(`   Mobile clients may have connectivity issues due to lack of ICE/TURN support`);
      logger.debug(`   Plain RTP producers cannot be bridged to WebRTC automatically`);
      
      // Continue with normal consumption - will work for desktop, may fail for mobile
      // The real fix is to have viewbots use WebRTC from the start
    }

    if (!consumerTransport || !producerMap) {
      logger.error(`❌ MEDIASOUP: Missing components for consumer creation`);
      logger.error(`Consumer transport: ${!!consumerTransport}`);
      logger.error(`Producer map: ${!!producerMap}`);
      return null;
    }

    // If kind is specified, get the specific producer; otherwise get the first available
    let producer;
    if (kind) {
      producer = producerMap.get(kind);
      if (!producer) {
        logger.error(`❌ MEDIASOUP: No ${kind} producer found for ${producerSocketId}`);
        return null;
      }
    } else {
      // Get first available producer (for backward compatibility)
      producer = producerMap.values().next().value;
      if (!producer) {
        logger.error(`❌ MEDIASOUP: No producers found for ${producerSocketId}`);
        return null;
      }
    }

    // Validate producer state before creating consumer
    if (producer.closed) {
      logger.error(`❌ MEDIASOUP: Producer is closed for ${producerSocketId} (${producer.kind})`);
      return null;
    }

    if (producer.paused) {
      logger.warn(`⚠️ MEDIASOUP: Producer is paused for ${producerSocketId} (${producer.kind}), attempting to consume anyway`);
    }

    if (!this.router.canConsume({
      producerId: producer.id,
      rtpCapabilities,
    })) {
      logger.error(`❌ MEDIASOUP: Cannot consume producer ${producer.id} (${producer.kind})`);
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

    // CRITICAL iOS FIX: Measured keyframe generation for video consumers
    // Previous aggressive approach (every 100ms-1s) overwhelmed iOS decoder
    if (producer.kind === 'video') {
      // Store reference for keyframe forcing
      consumer._producer = producer;
      consumer._isIOS = rtpCapabilities?.codecs?.some(codec =>
        codec.mimeType?.toLowerCase() === 'video/h264' &&
        codec.parameters?.['profile-level-id'] === '42e01f'
      );

      if (consumer._isIOS) {
        logger.debug(`📱 iOS video consumer detected for ${consumerSocketId}, using MEASURED keyframe approach`);

        // MEASURED APPROACH: Single initial keyframe after decoder initialization
        setTimeout(async () => {
          try {
            await consumer.requestKeyFrame();
            logger.debug(`📱 Initial keyframe sent for iOS consumer ${consumer.id}`);
          } catch (e) {
            logger.error(`Failed to send initial keyframe:`, e);
          }
        }, 500); // Wait 500ms for iOS decoder initialization

        // GENTLE periodic keyframes - every 3 seconds, NOT every 1 second
        // This prevents decoder overload while still handling network issues
        consumer._keyframeInterval = setInterval(async () => {
          if (consumer.closed) {
            clearInterval(consumer._keyframeInterval);
            return;
          }

          try {
            // Only send keyframe if consumer is active and not paused
            if (!consumer.paused && consumer.producerPaused === false) {
              await consumer.requestKeyFrame();
              // Reduced logging to avoid spam
              if (Math.random() < 0.1) { // Log only 10% of requests
                logger.debug(`🔑 Periodic keyframe for iOS consumer ${consumer.id}`);
              }
            }
          } catch (e) {
            // Consumer may be closed, stop interval
            clearInterval(consumer._keyframeInterval);
          }
        }, 3000); // Every 3 seconds - gentle on iOS decoder
      }
    }

    logger.debug(`📺 MEDIASOUP: Consumer created for ${consumerSocketId} from ${producerSocketId} (${producer.kind})`);

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
          logger.debug(`▶️ MEDIASOUP: Consumer ${consumerId} resumed for ${socketId}`);
          return;
        } catch (error) {
          logger.error(`❌ MEDIASOUP: Failed to resume consumer ${consumerId}: ${error.message}`);
          throw error;
        }
      }
    }
    
    throw new Error(`Consumer ${consumerId} not found for socket ${socketId}`);
  }

  getCurrentStreamer() {
    return this.currentStreamer;
  }

  getConsumer(socketId, consumerId) {
    const consumers = this.consumers.get(socketId);
    if (!consumers) {
      return null;
    }

    for (const consumer of consumers) {
      if (consumer.id === consumerId) {
        return consumer;
      }
    }
    
    return null;
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
          logger.debug(`🧹 MEDIASOUP: Cleaning up stale transport for ${socketId}`);
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
        logger.debug(`🧹 MEDIASOUP: Cleaning up orphaned transport for ${socketId} (no producers or consumers)`);
        this.cleanupSocketResources(socketId);
        cleanupCount++;
      }
    }

    if (cleanupCount > 0) {
      logger.debug(`🧹 MEDIASOUP: Periodic cleanup completed, removed ${cleanupCount} stale resources`);
    }
  }

  async cleanupSocketResources(socketId) {
    logger.debug(`🧹 MEDIASOUP: Cleaning up all resources for ${socketId}`);

    // Clean up consumers first
    const consumers = this.consumers.get(socketId);
    if (consumers) {
      for (const consumer of consumers) {
        try {
          // Clean up iOS keyframe interval if it exists
          if (consumer._keyframeInterval) {
            clearInterval(consumer._keyframeInterval);
            consumer._keyframeInterval = null;
          }
          if (!consumer.closed) {
            consumer.close();
          }
        } catch (error) {
          logger.warn(`⚠️ MEDIASOUP: Error closing consumer: ${error.message}`);
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
            logger.debug(`🛑 MEDIASOUP: Closed ${kind} producer for ${socketId}`);
          }
        } catch (error) {
          logger.warn(`⚠️ MEDIASOUP: Error closing producer: ${error.message}`);
        }
      }
      this.producers.delete(socketId);
      
      // Only clear currentStreamer if this socketId is still the current streamer
      // (Don't clear during takeovers where a new streamer has already been set)
      if (this.currentStreamer === socketId) {
        this.currentStreamer = null;
        logger.debug(`🎯 MEDIASOUP: Streamer ${socketId} disconnected, no active streamer`);
      } else if (this.currentStreamer) {
        logger.debug(`🎯 MEDIASOUP: Cleaning up ${socketId} but ${this.currentStreamer} is current streamer`);
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
            logger.debug(`🔒 Closed video transport for ${socketId}`);
          }
          if (!transport.audio.closed) {
            transport.audio.close();
            logger.debug(`🔒 Closed audio transport for ${socketId}`);
          }
        } else if (transport.close && typeof transport.close === 'function') {
          // Regular single transport case
          if (!transport.closed) {
            transport.close();
          }
        }
      } catch (error) {
        logger.warn(`⚠️ MEDIASOUP: Error closing transport: ${error.message}`);
      }
      this.transports.delete(socketId);
      logger.debug(`🔒 MEDIASOUP: Transport cleaned up for ${socketId}`);
    }
  }

  // Backward compatibility
  cleanup(socketId) {
    this.cleanupSocketResources(socketId);
  }

  // Clean up all resources (for server shutdown)
  cleanupAll() {
    logger.debug('🧹 MEDIASOUP: Cleaning up all resources...');
    
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
    
    logger.debug('✅ MEDIASOUP: All resources cleaned up');
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
