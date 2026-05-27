/**
 * ViewBotHandler
 *
 * Registers ViewBot socket events on a per-connection basis. Continuation of
 * PR-H's socket-extraction pattern (see AdminHandler, EffectHandler,
 * GameHandler, StreamHandler, MediaSoupHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - viewbot-create-plain-bridge      Create a Plain RTP bridge transport so
 *                                      FFmpeg/GStreamer can pipe RTP into a
 *                                      WebRTC producer.
 *   - viewbot-create-webrtc-transport  (Two listeners, both preserved.) The
 *                                      first is the legacy variant that also
 *                                      auto-creates a producer + transport
 *                                      under a `viewbot-<botId>-<kind>` key.
 *                                      The second is the modern mobile-friendly
 *                                      variant that just returns
 *                                      transport options to the caller.
 *   - viewbot-create-plain-transport   Create a Plain RTP transport for a
 *                                      single kind and immediately produce on
 *                                      it with fixed SSRCs / RTP parameters.
 *   - stop-stream                      ViewBot-rotation-specific stream stop
 *                                      (NOT the user-facing stop-streaming —
 *                                      that one is in StreamHandler).
 *   - viewbot-create-transport         Create paired Plain RTP transports
 *                                      (video + audio) for a ViewBot. Branches
 *                                      to LiveKit-mode response when the
 *                                      adapter is configured for LiveKit.
 *   - viewbot-webrtc-produce           Create video + audio producers on the
 *                                      ViewBot's WebRTC transport with the
 *                                      canned RTP parameters that GStreamer
 *                                      will send. Includes real-streamer-vs-
 *                                      viewbot priority gating.
 *   - viewbot-create-producers         Same idea but on the paired Plain RTP
 *                                      transports created by
 *                                      viewbot-create-transport.
 *   - viewbot-stream-ready             ViewBot reports media is flowing; emit
 *                                      stream-ready with the same dedup as the
 *                                      MediaSoup path.
 *   - viewbot-rotation-request         Pass through to viewBotClientService
 *                                      and broadcast the result.
 *   - viewbot-video-ended              ViewBot's playback ended naturally;
 *                                      force a rotation via the global
 *                                      viewBotRotation singleton.
 *   - viewbot-cleanup-transports       Explicit teardown of a ViewBot's
 *                                      transports + producers, supporting
 *                                      lookup by socketId or by botId.
 *
 * `deps` (all required unless noted):
 *   - mediasoupService             The MediaSoup SFU wrapper (router,
 *                                  transports, producers).
 *   - streamService                Current-streamer registry.
 *   - plainTransportService        Stateful service for ViewBot Plain RTP
 *                                  resources. Used by stop-stream cleanup.
 *   - lastEmittedStreamReady       Shared mutable { streamerId, timestamp }
 *                                  for stream-ready dedup. MUST be mutated in
 *                                  place so other modules see updates.
 *   - notifyViewersStreamEnded     Helper from index.js (room broadcast +
 *                                  stop tracking + schedule rotation). Used
 *                                  on stop-stream when it's NOT a ViewBot
 *                                  rotation.
 *   - getViewBotClientService      () => viewBotClientService. Lazy because
 *                                  ViewBotClientService is constructed after
 *                                  io.on wiring (post-startServer init).
 *   - getViewbotService            () => viewbotService. Reserved for parity
 *                                  with other handlers; the inline ViewBot
 *                                  code paths do not currently read it, but
 *                                  passing it keeps the dep bag uniform with
 *                                  StreamHandler.
 *
 * Notes on global state intentionally NOT in the deps bag:
 *   - `process.env.ANNOUNCED_IP`, `process.env.USE_WEBRTC_ADAPTER`, and
 *     `process.env.WEBRTC_BACKEND` are read directly (same as inline).
 *   - `global.webrtcAdapter` and `global.viewBotRotation` are accessed
 *     directly to preserve byte-equivalent runtime behaviour. These are
 *     long-lived singletons set up during startServer and the inline code
 *     reaches into them the same way.
 */
const logger = require('../bootstrap/logger').child({ svc: 'ViewBotHandler' });

module.exports = function registerViewBotHandler(io, socket, deps) {
  const {
    mediasoupService,
    streamService,
    plainTransportService,
    lastEmittedStreamReady,
    notifyViewersStreamEnded,
    getViewBotClientService,
    getViewbotService, // eslint-disable-line no-unused-vars
    // PR 3.1: stop-stream's `stream-ended` emit goes through the chokepoint.
    streamNotifier,
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

  // Handle stop-stream event (used by ViewBots during rotation)
  socket.on('stop-stream', async (data) => {
    logger.info(`🛑 STOP-STREAM: Received from ${socket.id} (ViewBot: ${data?.isViewBot}, BotId: ${data?.botId})`);

    // Clean up MediaSoup resources immediately
    if (mediasoupService) {
      logger.info(`🧹 MEDIASOUP: Cleaning up resources for ${socket.id} on stop-stream`);
      await mediasoupService.cleanupSocketResources(socket.id);
    }

    // Clean up Plain Transport resources for ViewBots
    if (data?.isViewBot && data?.botId && plainTransportService) {
      logger.info(`🧹 PLAIN TRANSPORT: Cleaning up resources for ViewBot ${data.botId}`);
      await plainTransportService.cleanup(data.botId);
    }

    // If this is the current streamer, clear it
    if (streamService.getCurrentStreamer() === socket.id) {
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;

      // Only emit stream-ended if it's not a ViewBot rotation
      if (!data?.isViewBot) {
        streamNotifier.streamEnded({ reason: 'stop_stream_request', previousStreamer: socket.id });
        notifyViewersStreamEnded();
      }

      logger.info(`📺 STOP-STREAM: Cleared streamer ${socket.id} from services`);
    }
  });

  // ViewBot request to create WebRTC transport (mobile-compatible)
  socket.on('viewbot-create-webrtc-transport', async (data, callback) => {
    logger.info(`🚀 SERVER: ViewBot ${data.botId} requesting WebRTC transport (mobile-compatible)`);

    try {
      // Create WebRTC transport exactly like normal users
      const transportOptions = await mediasoupService.createWebRtcTransport(socket.id, false);

      logger.info(`✅ SERVER: Created WebRTC transport for ViewBot ${data.botId}`);
      logger.info(`   Transport ID: ${transportOptions.id}`);
      logger.info(`   ICE candidates: ${transportOptions.iceCandidates?.length || 0}`);

      callback({
        success: true,
        transportOptions
      });

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to create WebRTC transport for ViewBot`);
      callback({ success: false, error: error.message });
    }
  });

  // ViewBot request to create Plain RTP transport (legacy, not mobile-compatible)
  socket.on('viewbot-create-transport', async (data, callback) => {
    logger.info(`🚚 SERVER: ViewBot ${data.botId} requesting Plain RTP transports (LEGACY - not mobile compatible)`);

    try {
      // Check if we're using LiveKit backend
      const useAdapter = process.env.USE_WEBRTC_ADAPTER === 'true';
      const backend = process.env.WEBRTC_BACKEND || 'mediasoup';
      const isLiveKit = useAdapter && backend === 'livekit';

      if (isLiveKit) {
        // For LiveKit, ViewBots should use GStreamer with whipsink
        // Return special response indicating LiveKit mode
        logger.info(`🎮 SERVER: ViewBot ${data.botId} should use LiveKit GStreamer pipeline`);

        // Get LiveKit service from adapter
        const livekitService = global.webrtcAdapter._backend;

        // Get LiveKit token for the ViewBot
        const token = await livekitService.generateToken(data.botId, {
          canPublish: true,
          canSubscribe: false,
          canPublishData: false
        });
        // Use the nginx-proxied WHIP endpoint for proper SSL handling
        const whipUrl = 'https://onestreamer.live/livekit/rtc';

        callback({
          useLiveKit: true,
          token: token,
          whipUrl: whipUrl,
          message: 'Use LiveKit GStreamer pipeline with whipsink'
        });
        return;
      }

      // MediaSoup path - create Plain RTP transports
      if (!mediasoupService.router) {
        throw new Error('MediaSoup router not available');
      }

      // Create TWO Plain RTP transports - one for video, one for audio
      const videoTransport = await mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',  // Listen on all interfaces
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // CRITICAL: Announce public IP for mobile/TURN
        },
        rtcpMux: false,
        comedia: true  // Auto-detect source
      });

      const audioTransport = await mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',  // Listen on all interfaces
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // CRITICAL: Announce public IP for mobile/TURN
        },
        rtcpMux: false,
        comedia: true  // Auto-detect source
      });

      logger.info(`✅ SERVER: Created Plain RTP transports for ViewBot ${data.botId}`);
      logger.info(`📡 SERVER: Video RTP port: ${videoTransport.tuple.localPort}`);
      logger.info(`📡 SERVER: Audio RTP port: ${audioTransport.tuple.localPort}`);

      // Store both transports for this socket
      if (!mediasoupService.transports) {
        mediasoupService.transports = new Map();
      }
      mediasoupService.transports.set(socket.id, {
        video: videoTransport,
        audio: audioTransport,
        botId: data.botId  // Store bot ID for debugging
      });
      logger.info(`📦 SERVER: Stored transports for socket ${socket.id} (ViewBot ${data.botId})`);

      callback({
        videoTransportId: videoTransport.id,
        audioTransportId: audioTransport.id,
        videoPort: videoTransport.tuple.localPort,
        audioPort: audioTransport.tuple.localPort
      });
    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to create Plain RTP transports`);
      callback({ error: error.message });
    }
  });

  // ViewBot request to produce to WebRTC transport (mobile-compatible)
  socket.on('viewbot-webrtc-produce', async (data, callback) => {
    logger.info(`🎬 SERVER: ViewBot ${data.botId} producing to WebRTC transport`);

    try {
      // Lazy-resolve viewbot client service — see top-of-file note.
      const viewBotClientService = getViewBotClientService();

      // CRITICAL: Check if a real user is currently streaming
      // Viewbots should NEVER override a real streamer
      if (viewBotClientService && viewBotClientService.realStreamerActive) {
        logger.info(`⛔ SERVER: Blocking viewbot ${data.botId} - real streamer is active`);
        callback({
          success: false,
          error: 'Real streamer is active - viewbot creation blocked'
        });
        return;
      }

      // Check if another streamer (viewbot or URL stream) is already active
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer && currentStreamer !== socket.id) {
        // Check if current streamer is a URL stream (they have priority)
        if (currentStreamer.startsWith('url-stream-')) {
          logger.info(`⛔ SERVER: Blocking viewbot ${data.botId} - URL stream ${currentStreamer} is active`);
          callback({
            success: false,
            error: 'URL stream is active - viewbot creation blocked'
          });
          return;
        }

        // Check if current streamer has active producers (is actually streaming)
        const currentProducers = mediasoupService.producers?.get(currentStreamer);
        if (currentProducers && currentProducers.size > 0) {
          logger.info(`⛔ SERVER: Blocking viewbot ${data.botId} - another streamer ${currentStreamer} has active producers`);
          callback({
            success: false,
            error: 'Another streamer is active - viewbot creation blocked'
          });
          return;
        }
      }

      const transport = mediasoupService.transports.get(socket.id);
      if (!transport) {
        throw new Error('WebRTC transport not found');
      }

      // Create producers with predefined RTP parameters for viewbots
      // These match what GStreamer will send
      const videoRtpParameters = {
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
        encodings: [{
          ssrc: 11111111,
          dtx: false
        }]
      };

      const audioRtpParameters = {
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
        encodings: [{
          ssrc: 22222222,
          dtx: false
        }]
      };

      // Create producers
      const videoProducer = await mediasoupService.createProducer(socket.id, videoRtpParameters, 'video');
      const audioProducer = await mediasoupService.createProducer(socket.id, audioRtpParameters, 'audio');

      logger.info(`✅ SERVER: Created WebRTC producers for ViewBot ${data.botId}`);

      // Mark as viewbot producers
      if (videoProducer && videoProducer.producer) {
        videoProducer.producer.appData = { ...videoProducer.producer.appData, isViewBot: true };
      }
      if (audioProducer && audioProducer.producer) {
        audioProducer.producer.appData = { ...audioProducer.producer.appData, isViewBot: true };
      }

      callback({
        success: true,
        videoProducerId: videoProducer?.producer?.id,
        audioProducerId: audioProducer?.producer?.id
      });

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to create WebRTC producers for ViewBot`);
      callback({ success: false, error: error.message });
    }
  });

  // ViewBot request to create producers
  socket.on('viewbot-create-producers', async (data, callback) => {
    logger.info(`🎤 SERVER: ViewBot ${data.botId} requesting to create producers`);
    logger.info(`🔍 SERVER: Looking for transports for socket ${socket.id}`);
    logger.info(`🔍 SERVER: Available transports: ${mediasoupService.transports ? mediasoupService.transports.size : 0}`);

    try {
      // Lazy-resolve viewbot client service — see top-of-file note.
      const viewBotClientService = getViewBotClientService();

      // CRITICAL: Check if a real user is currently streaming
      // Viewbots should NEVER override a real streamer
      if (viewBotClientService && viewBotClientService.realStreamerActive) {
        logger.info(`⛔ SERVER: Blocking viewbot ${data.botId} producer creation - real streamer is active`);
        callback({
          success: false,
          error: 'Real streamer is active - viewbot creation blocked'
        });
        return;
      }

      // Check if another streamer (viewbot or URL stream) is already active
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer && currentStreamer !== socket.id) {
        // Check if current streamer is a URL stream (they have priority)
        if (currentStreamer.startsWith('url-stream-')) {
          logger.info(`⛔ SERVER: Blocking viewbot ${data.botId} producer creation - URL stream ${currentStreamer} is active`);
          callback({
            success: false,
            error: 'URL stream is active - viewbot creation blocked'
          });
          return;
        }

        // Check if current streamer has active producers (is actually streaming)
        const currentProducers = mediasoupService.producers?.get(currentStreamer);
        if (currentProducers && currentProducers.size > 0) {
          logger.info(`⛔ SERVER: Blocking viewbot ${data.botId} producer creation - another streamer ${currentStreamer} has active producers`);
          callback({
            success: false,
            error: 'Another streamer is active - viewbot creation blocked'
          });
          return;
        }
      }

      const transports = mediasoupService.transports?.get(socket.id);
      if (!transports || !transports.video || !transports.audio) {
        logger.error(`❌ SERVER: Transports not found for socket ${socket.id}`);
        logger.error(`   Available sockets: ${mediasoupService.transports ? Array.from(mediasoupService.transports.keys()).join(', ') : 'none'}`);
        throw new Error('Transports not found');
      }

      // Create video producer on video transport (Plain RTP doesn't use MID)
      const videoProducer = await transports.video.produce({
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

      // Create audio producer on audio transport (Plain RTP doesn't use MID)
      const audioProducer = await transports.audio.produce({
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

      // Store producers for this socket
      if (!mediasoupService.producers.has(socket.id)) {
        mediasoupService.producers.set(socket.id, new Map());
      }
      const producerMap = mediasoupService.producers.get(socket.id);
      producerMap.set('video', videoProducer);
      producerMap.set('audio', audioProducer);

      logger.info(`✅ SERVER: Created producers for ViewBot ${data.botId}`);
      logger.info(`   Video Producer ID: ${videoProducer.id}`);
      logger.info(`   Audio Producer ID: ${audioProducer.id}`);

      callback({
        success: true,
        videoProducerId: videoProducer.id,
        audioProducerId: audioProducer.id
      });
    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to create producers`);
      callback({ error: error.message });
    }
  });

  // ViewBot stream ready notification
  socket.on('viewbot-stream-ready', async (data) => {
    logger.info(`📺 SERVER: ViewBot ${data.botId} reports stream ready, triggering stream switch`);

    try {
      // Lazy-resolve viewbot client service — see top-of-file note.
      const viewBotClientService = getViewBotClientService();

      // CRITICAL: Check if a real user is currently streaming
      // Don't emit stream-ready for viewbots if real streamer is active
      if (viewBotClientService && viewBotClientService.realStreamerActive) {
        logger.info(`⛔ STREAM-READY: Blocking viewbot ${data.botId} stream-ready - real streamer is active`);
        return;
      }

      // Check if another non-viewbot streamer is active (e.g., URL stream)
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer && currentStreamer !== socket.id && currentStreamer.startsWith('url-stream-')) {
        logger.info(`⛔ STREAM-READY: Blocking viewbot ${data.botId} stream-ready - URL stream ${currentStreamer} is active`);
        return;
      }

      const emitTimestamp = Date.now();

      // DEDUP: Check if we already emitted for this stream recently
      if (lastEmittedStreamReady.streamerId === socket.id &&
          (emitTimestamp - lastEmittedStreamReady.timestamp) < 2000) {
        logger.info(`⏭️ STREAM-READY: Skipping duplicate viewbot-stream-ready emission for ${socket.id}`);
        return;
      }

      // Emit stream-ready to trigger viewer consumption
      io.emit('stream-ready', {
        streamerId: socket.id,
        isViewBot: true,
        streamType: 'viewbot',
        botId: data.botId,
        timestamp: emitTimestamp
      });

      lastEmittedStreamReady.streamerId = socket.id;
      lastEmittedStreamReady.timestamp = emitTimestamp;
      logger.info(`✅ SERVER: Stream-ready notification sent for ViewBot ${data.botId}`);

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to handle ViewBot stream ready for ${data.botId}`);
    }
  });

  // ViewBot rotation request handler
  socket.on('viewbot-rotation-request', async (data) => {
    logger.info(`🔄 SERVER: ViewBot rotation request from ${data.botId} (reason: ${data.reason})`);

    // Lazy-resolve viewbot client service — see top-of-file note.
    const viewBotClientService = getViewBotClientService();

    if (!viewBotClientService) {
      logger.error(`❌ SERVER: ViewBotClientService not available for rotation request`);
      return;
    }

    // CRITICAL FIX: Check if rotation is enabled before processing request
    if (!viewBotClientService.rotationEnabled) {
      logger.info(`🚫 SERVER: ViewBot rotation request ignored - rotation system disabled`);
      return;
    }

    try {
      const result = await viewBotClientService.handleRotationRequest(data.botId, data.reason);

      if (result.success) {
        logger.info(`✅ SERVER: ViewBot rotation completed: ${result.previousBot} → ${result.newBot}`);

        // Notify all admins about the rotation
        io.emit('viewbot-rotation-completed', {
          previousBot: result.previousBot,
          newBot: result.newBot,
          reason: data.reason,
          timestamp: Date.now()
        });
      } else {
        logger.info(`⚠️ SERVER: ViewBot rotation failed: ${result.message}`);
      }

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to handle ViewBot rotation request from ${data.botId}`);
    }
  });

  // Handle when a ViewBot video file ends naturally
  socket.on('viewbot-video-ended', async (data) => {
    logger.info(`🎬 SERVER: ViewBot ${data.botId} video file ended: ${data.videoFile}`);

    // Use the global viewBotRotation service
    if (!global.viewBotRotation) {
      logger.error(`❌ SERVER: ViewBotRotation service not available for video-ended event`);
      return;
    }

    // Only trigger rotation if rotation is enabled
    if (!global.viewBotRotation.enabled) {
      logger.info(`🚫 SERVER: ViewBot video ended but rotation is disabled`);
      return;
    }

    try {
      // Force a rotation to the next video
      logger.info(`🔄 SERVER: Triggering rotation after video ended for ViewBot ${data.botId}`);
      await global.viewBotRotation.rotateToNextBot();

      logger.info(`✅ SERVER: Rotation triggered successfully after video end`);

      // Notify admins
      io.emit('viewbot-rotation-after-video-end', {
        previousBot: data.botId,
        previousVideo: data.videoFile,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Error handling video-ended event`);
    }
  });

  // ViewBot explicit transport cleanup request
  socket.on('viewbot-cleanup-transports', (data) => {
    logger.info(`🧹 SERVER: ViewBot ${data.botId} requesting transport cleanup for socket ${data.socketId}`);

    // Use the socketId from data, not socket.id (they're different!)
    const targetSocketId = data.socketId || socket.id;

    logger.info(`🔍 DEBUG: Cleanup requested by socket ${socket.id} for target ${targetSocketId}`);
    logger.info({ transportKeys: Array.from(mediasoupService.transports?.keys() || []) }, `🔍 DEBUG: Current transport keys`);

    // Try to find transports by socket ID or by bot ID
    let transportEntry = null;
    let transportKey = null;

    if (mediasoupService.transports?.has(targetSocketId)) {
      transportEntry = mediasoupService.transports.get(targetSocketId);
      transportKey = targetSocketId;
    } else {
      // If not found by socket ID, search by bot ID
      for (const [key, value] of mediasoupService.transports?.entries() || []) {
        if (value.botId === data.botId) {
          logger.info(`🔍 DEBUG: Found transport by botId ${data.botId} under socket ${key}`);
          transportEntry = value;
          transportKey = key;
          break;
        }
      }
    }

    // Clean up transports immediately
    if (transportEntry) {
      try {
        if (transportEntry.video && transportEntry.audio) {
          // Close both video and audio transports
          if (!transportEntry.video.closed) {
            transportEntry.video.close();
            logger.info(`✅ Closed video transport for ViewBot ${data.botId}`);
          }
          if (!transportEntry.audio.closed) {
            transportEntry.audio.close();
            logger.info(`✅ Closed audio transport for ViewBot ${data.botId}`);
          }
        } else if (typeof transportEntry.close === 'function' && !transportEntry.closed) {
          transportEntry.close();
          logger.info(`✅ Closed transport for ViewBot ${data.botId}`);
        }
      } catch (e) {
        logger.error({ err: e }, `❌ Error closing transports for ViewBot ${data.botId}`);
      }
      mediasoupService.transports.delete(transportKey);
      logger.info(`✅ SERVER: Cleaned up transports for ViewBot ${data.botId}`);
    } else {
      logger.info(`⚠️ SERVER: No transports found for socket ${targetSocketId}`);
    }

    // Also clean up producers if they exist
    if (mediasoupService.producers?.has(transportKey || targetSocketId)) {
      const producers = mediasoupService.producers.get(transportKey || targetSocketId);
      if (producers) {
        for (const [kind, producer] of producers) {
          if (!producer.closed) {
            producer.close();
            logger.info(`✅ Closed ${kind} producer for ViewBot ${data.botId}`);
          }
        }
      }
      mediasoupService.producers.delete(transportKey || targetSocketId);
    }
  });
};
