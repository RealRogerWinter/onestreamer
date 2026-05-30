/**
 * viewBotHandler/registerTransportCreation
 *
 * Sub-handler module split out of ViewBotHandler.js. Registers the first
 * contiguous block of ViewBot transport-creation events — bodies are VERBATIM
 * copies of the original inline handlers, same order, same emit targets:
 *   1. viewbot-create-plain-bridge      Plain RTP bridge transport.
 *   2. viewbot-create-webrtc-transport  (LEGACY listener — also produces.)
 *   3. viewbot-create-plain-transport   Single-kind Plain RTP + produce.
 *
 * Takes the same (io, socket, deps) signature as the parent. Reads
 * `mediasoupService` from deps and `process.env.ANNOUNCED_IP` directly,
 * identical to the inline original.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'ViewBotHandler' });

module.exports = function registerTransportCreation(io, socket, deps) {
  const {
    mediasoupService,
  } = deps;

  // Handle ViewBot Plain RTP bridge creation (for FFmpeg/GStreamer to WebRTC producer)
  socket.on('viewbot-create-plain-bridge', async (data, callback) => {
    const { botId, producerId, kind, rtpParameters } = data;
    logger.info(`🤖 SERVER: ViewBot ${botId} creating Plain RTP bridge for ${kind} producer ${producerId}`);

    try {
      // Generate a fixed SSRC for this producer
      const ssrc = kind === 'video' ? 11111111 : 22222222;

      // Create Plain RTP transport for FFmpeg/GStreamer to send to
      const plainTransport = await mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // Public IP
        },
        rtcpMux: false,
        comedia: true,
        enableSrtp: false
      });

      const listenPort = plainTransport.tuple.localPort;
      logger.info(`✅ SERVER: Plain RTP bridge created on port ${listenPort} for ${kind}`);

      // Store the Plain transport
      if (!mediasoupService.plainBridges) {
        mediasoupService.plainBridges = new Map();
      }
      mediasoupService.plainBridges.set(`${botId}-${kind}`, plainTransport);

      // When RTP arrives, forward it to the WebRTC producer
      // This is handled automatically by MediaSoup's transport routing

      callback({
        success: true,
        rtpPort: listenPort,
        ssrc: ssrc
      });

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to create Plain RTP bridge`);
      callback({
        success: false,
        error: error.message
      });
    }
  });

  // Handle ViewBot WebRTC transport creation for mobile 5G/TURN support (legacy - kept for compatibility)
  socket.on('viewbot-create-webrtc-transport', async (data) => {
    const { botId, kind, rtpParameters } = data;
    logger.info(`🤖 SERVER: ViewBot ${botId} creating WebRTC transport for ${kind} (LEGACY METHOD)`);

    try {
      // Create WebRTC transport like regular users for TURN support
      const transportOptions = await mediasoupService.createWebRtcTransport(`viewbot-${botId}-${kind}`);

      // Store transport for later use
      if (!mediasoupService.viewbotTransports) {
        mediasoupService.viewbotTransports = new Map();
      }
      mediasoupService.viewbotTransports.set(`${botId}-${kind}`, transportOptions);

      // Create producer on the transport
      const transport = mediasoupService.transports.get(`viewbot-${botId}-${kind}`);
      if (!transport) {
        throw new Error('Transport not found after creation');
      }

      // Create producer with appropriate RTP parameters
      const producer = await transport.produce({
        kind: kind,
        rtpParameters: rtpParameters,
        paused: false,
        appData: {
          isViewBot: true,
          botId: botId
        }
      });

      logger.info(`✅ SERVER: ViewBot ${botId} WebRTC ${kind} producer created: ${producer.id}`);

      // Store producer
      if (!mediasoupService.producers) {
        mediasoupService.producers = new Map();
      }
      const producerKey = `viewbot-${botId}-${kind}`;
      const producerMap = mediasoupService.producers.get(producerKey) || new Map();
      producerMap.set(kind, producer);
      mediasoupService.producers.set(producerKey, producerMap);

      // Send success response
      socket.emit('viewbot-producer-created', {
        botId: botId,
        kind: kind,
        producerId: producer.id,
        transportId: transportOptions.id,
        iceParameters: transportOptions.iceParameters,
        iceCandidates: transportOptions.iceCandidates,
        dtlsParameters: transportOptions.dtlsParameters,
        rtpPort: 0 // Not used for WebRTC
      });

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to create WebRTC transport for ViewBot ${botId}`);
      socket.emit('viewbot-producer-error', {
        botId: botId,
        kind: kind,
        error: error.message
      });
    }
  });

  // Handle ViewBot plain RTP transport creation
  socket.on('viewbot-create-plain-transport', async (data) => {
    const { botId, kind, rtpParameters } = data;
    logger.info(`🤖 SERVER: ViewBot ${botId} creating plain RTP transport for ${kind}`);

    try {
      // Generate a fixed SSRC for this producer
      const ssrc = kind === 'video' ? 11111111 : 22222222; // Fixed SSRCs for debugging

      // Create plain RTP transport - MediaSoup will listen on a port for FFmpeg RTP
      const plainTransport = await mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // Public IP
        },
        rtcpMux: false, // Separate ports for RTP and RTCP
        comedia: true, // Auto-detect source IP and port from first RTP packet
        enableSrtp: false,
        srtpCryptoSuite: undefined
      });

      const listenPort = plainTransport.tuple.localPort;
      const rtcpPort = plainTransport.rtcpTuple ? plainTransport.rtcpTuple.localPort : null;
      logger.info(`📡 SERVER: Plain RTP transport created for ViewBot ${botId} ${kind}`);
      logger.info(`📡 SERVER: Transport listening for RTP on port ${listenPort}, RTCP on port ${rtcpPort}`);
      logger.info(`📡 SERVER: Using SSRC ${ssrc} for ${kind}`);

      // For comedia mode, don't pre-connect - let it auto-detect from first packet

      // For PlainTransport, we need to specify the exact RTP parameters
      // including SSRC that FFmpeg will use
      const producerRtpParameters = {
        codecs: kind === 'video' ? [
          {
            mimeType: 'video/VP8',
            clockRate: 90000,
            payloadType: 96,
            parameters: {},
            rtcpFeedback: [
              { type: 'nack' },
              { type: 'nack', parameter: 'pli' },
              { type: 'ccm', parameter: 'fir' },
              { type: 'goog-remb' }
            ]
          }
        ] : [
          {
            mimeType: 'audio/opus',
            clockRate: 48000,
            payloadType: 111,
            channels: 2,
            parameters: {
              'minptime': '10',
              'useinbandfec': '1'
            },
            rtcpFeedback: []
          }
        ],
        encodings: [
          {
            ssrc: ssrc,
            rtx: kind === 'video' ? { ssrc: ssrc + 1 } : undefined
          }
        ]
      };

      // Create producer on the plain transport with the correct RTP parameters
      const producer = await plainTransport.produce({
        kind: kind,
        rtpParameters: producerRtpParameters,
        paused: false,
        appData: {
          isViewBot: true,
          botId: botId
        }
      });

      logger.info(`✅ SERVER: ViewBot ${botId} ${kind} producer created: ${producer.id}`);

      // Monitor producer and transport for debugging
      producer.on('score', (score) => {
        logger.info({ score }, `📊 SERVER: ViewBot ${botId} ${kind} producer score`);
      });

      producer.on('videoorientationchange', (videoOrientation) => {
        logger.info({ videoOrientation }, `📐 SERVER: ViewBot ${botId} video orientation changed`);
      });

      producer.on('trace', (trace) => {
        logger.info({ traceType: trace.type, traceInfo: trace.info }, `🔍 SERVER: ViewBot ${botId} ${kind} producer trace`);
      });

      // Monitor the plain transport tuple for incoming RTP
      plainTransport.on('tuple', (tuple) => {
        logger.info({ tuple }, `🔌 SERVER: ViewBot ${botId} ${kind} transport tuple updated`);
      });

      plainTransport.on('rtcp', (rtcp) => {
        logger.info({ rtcp }, `📡 SERVER: ViewBot ${botId} ${kind} received RTCP`);
      });

      // Get producer stats periodically
      const statsInterval = setInterval(async () => {
        try {
          const stats = await producer.getStats();
          const hasData = stats && stats.length > 0 && stats[0].bytesCount > 0;
          if (hasData) {
            logger.info({ stats: stats[0] }, `📈 SERVER: ViewBot ${botId} ${kind} producer stats`);
            clearInterval(statsInterval); // Stop once we see data flowing
          }
        } catch (error) {
          clearInterval(statsInterval);
        }
      }, 2000);

      // Store producer in MediaSoup service (same as regular users)
      let producerMap = mediasoupService.producers.get(socket.id);
      if (!producerMap) {
        producerMap = new Map();
        mediasoupService.producers.set(socket.id, producerMap);
      }
      producerMap.set(kind, producer);

      // Also store the plain transport for cleanup later
      if (!mediasoupService.transports.has(socket.id)) {
        mediasoupService.transports.set(socket.id, plainTransport);
      }

      // Check if we have both video and audio producers ready
      const updatedProducerMap = mediasoupService.producers.get(socket.id);
      const hasVideo = updatedProducerMap && updatedProducerMap.has('video');
      const hasAudio = updatedProducerMap && updatedProducerMap.has('audio');

      // Only proceed with stream ready notification if both are ready
      // The actual takeover and streamer setting will be handled by request-to-stream event
      if ((hasVideo && kind === 'audio') || (hasAudio && kind === 'video')) {
        logger.info(`🎯 SERVER: ViewBot ${botId} has both video and audio producers ready`);
        logger.info(`📡 SERVER: ViewBot producers ready - waiting for takeover via request-to-stream`);
      }

      // Return the port that FFmpeg should use
      socket.emit('viewbot-producer-created', {
        botId: botId,
        kind: kind,
        producerId: producer.id,
        rtpPort: listenPort, // Tell ViewBot which port to send RTP to
        rtcpPort: rtcpPort
      });

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: ViewBot ${kind} plain transport creation failed`);

      socket.emit('viewbot-producer-error', {
        botId: botId,
        kind: kind,
        error: error.message
      });
    }
  });
};
