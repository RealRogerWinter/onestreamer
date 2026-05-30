/**
 * viewBotHandler/registerProducerCreation
 *
 * Sub-handler module split out of ViewBotHandler.js. Registers the second
 * contiguous block of ViewBot transport/producer events — bodies are VERBATIM
 * copies of the original inline handlers, same order, same emit targets:
 *   5. viewbot-create-webrtc-transport  (MODERN listener — mobile-compatible.)
 *   6. viewbot-create-transport         Paired Plain RTP (+ LiveKit branch).
 *   7. viewbot-webrtc-produce           WebRTC produce w/ priority gating.
 *   8. viewbot-create-producers         Produce on paired Plain RTP transports.
 *
 * Same (io, socket, deps) signature as the parent. Reads
 * `process.env.ANNOUNCED_IP` / `USE_WEBRTC_ADAPTER` / `WEBRTC_BACKEND` and
 * `global.webrtcAdapter` directly, identical to the inline original.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'ViewBotHandler' });

module.exports = function registerProducerCreation(io, socket, deps) {
  const {
    mediasoupService,
    streamService,
    getViewBotClientService,
  } = deps;

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
};
