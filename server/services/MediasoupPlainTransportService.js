/**
 * MediaSoup PlainTransport Service for ViewBot
 * Provides better RTP control and synchronization for A/V streams
 */

const mediasoup = require('mediasoup');

const logger = require('../bootstrap/logger').child({ svc: 'MediasoupPlainTransportService' });
class MediasoupPlainTransportService {
  constructor(mediasoupService) {
    this.mediasoupService = mediasoupService;
    this.plainTransports = new Map(); // botId -> transport
    this.plainProducers = new Map(); // botId -> { video: producer, audio: producer }
    this.rtpPorts = new Map(); // botId -> { video: port, audio: port, videoRtcp: port, audioRtcp: port }
    this.baseRtpPort = 40000; // Base port for RTP allocation
    this.currentPort = this.baseRtpPort;
  }

  /**
   * Allocate a pair of ports (RTP and RTCP)
   */
  allocatePortPair() {
    const rtpPort = this.currentPort;
    const rtcpPort = this.currentPort + 1;
    this.currentPort += 2; // Move to next pair
    
    // Wrap around if we go too high
    if (this.currentPort > 50000) {
      this.currentPort = this.baseRtpPort;
    }
    
    return { rtpPort, rtcpPort };
  }

  /**
   * Generate a random SSRC for RTP streams
   */
  generateSSRC() {
    return Math.floor(Math.random() * 4294967295); // Random 32-bit unsigned integer
  }

  /**
   * Creates a PlainTransport for ViewBot with RTCP support
   * PlainTransport provides direct RTP/RTCP without WebRTC overhead
   */
  async createPlainTransport(botId, options = {}) {
    logger.debug(`🚛 PLAIN: Creating PlainTransport for ${botId}`);
    
    // Wait for router if not ready
    if (!this.mediasoupService.router) {
      logger.debug(`⏳ PLAIN: Waiting for MediaSoup router initialization...`);
      // Initialize MediaSoup if needed
      if (!this.mediasoupService.worker) {
        await this.mediasoupService.initializeMediasoup();
      }
      // Check again
      if (!this.mediasoupService.router) {
        throw new Error('MediaSoup router not initialized after waiting');
      }
    }

    try {
      // Allocate RTP/RTCP ports
      const videoPorts = this.allocatePortPair();
      const audioPorts = this.allocatePortPair();
      
      // Create PlainTransport with RTCP enabled for synchronization
      const transport = await this.mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || process.env.SERVER_HOST || null
        },
        rtcpMux: false, // Separate RTCP ports for better sync control
        comedia: true, // Server connects to client
        enableSctp: false,
        numSctpStreams: { OS: 0, MIS: 0 },
        // Don't include SRTP settings at all for plain RTP
        appData: {
          botId,
          type: 'plain',
          createdAt: Date.now()
        }
      });

      // Get the allocated ports
      const videoRtpPort = transport.tuple.localPort;
      const videoRtcpPort = transport.rtcpTuple ? transport.rtcpTuple.localPort : videoRtpPort + 1;
      
      // Create second transport for audio (MediaSoup limitation: one producer per transport)
      const audioTransport = await this.mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || process.env.SERVER_HOST || null
        },
        rtcpMux: false,
        comedia: true,
        enableSctp: false,
        numSctpStreams: { OS: 0, MIS: 0 },
        // Don't include SRTP settings at all for plain RTP
        appData: {
          botId,
          type: 'plain-audio',
          createdAt: Date.now()
        }
      });

      const audioRtpPort = audioTransport.tuple.localPort;
      const audioRtcpPort = audioTransport.rtcpTuple ? audioTransport.rtcpTuple.localPort : audioRtpPort + 1;

      // Store transport and port information
      this.plainTransports.set(botId, { video: transport, audio: audioTransport });
      this.rtpPorts.set(botId, {
        video: videoRtpPort,
        videoRtcp: videoRtcpPort,
        audio: audioRtpPort,
        audioRtcp: audioRtcpPort
      });

      logger.debug(`✅ PLAIN: PlainTransport created for ${botId}`);
      logger.debug(`   Video RTP: ${videoRtpPort}, RTCP: ${videoRtcpPort}`);
      logger.debug(`   Audio RTP: ${audioRtpPort}, RTCP: ${audioRtcpPort}`);

      return {
        success: true,
        video: videoRtpPort,  // Match expected property names
        videoRtcp: videoRtcpPort,
        audio: audioRtpPort,
        audioRtcp: audioRtcpPort,
        transportId: transport.id,
        audioTransportId: audioTransport.id
      };

    } catch (error) {
      logger.error(`❌ PLAIN: Failed to create PlainTransport:`, error);
      throw error;
    }
  }

  /**
   * Creates producers on PlainTransport for synchronized A/V
   */
  async createPlainProducers(botId, options = {}) {
    logger.debug(`📡 PLAIN: Creating producers for ViewBot ${botId}`);
    
    const transports = this.plainTransports.get(botId);
    if (!transports) {
      throw new Error(`No PlainTransport found for bot ${botId}`);
    }

    const ports = this.rtpPorts.get(botId);
    if (!ports) {
      throw new Error(`No RTP ports allocated for bot ${botId}`);
    }

    try {
      // Create video producer with synchronized RTP parameters
      const videoProducer = await transports.video.produce({
        kind: 'video',
        rtpParameters: {
          codecs: [{
            mimeType: 'video/VP8',
            payloadType: 96,
            clockRate: 90000,
            parameters: {},
            rtcpFeedback: [
              { type: 'nack' },
              { type: 'nack', parameter: 'pli' },
              { type: 'ccm', parameter: 'fir' },
              { type: 'goog-remb' },
              { type: 'transport-cc' }
            ]
          }],
          headerExtensions: [
            {
              uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
              id: 1,
              encrypt: false
            },
            {
              uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
              id: 2,
              encrypt: false
            },
            {
              uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
              id: 3,
              encrypt: false
            }
          ],
          encodings: [
            {
              ssrc: 11111111,
              rtx: { ssrc: 11111112 }
            }
          ],
          rtcp: {
            cname: `viewbot-${botId}-video`,
            reducedSize: false, // Full RTCP for better sync
            mux: false
          }
        },
        appData: {
          botId,
          kind: 'video'
        }
      });

      // Create audio producer with synchronized RTP parameters
      const audioProducer = await transports.audio.produce({
        kind: 'audio',
        rtpParameters: {
          codecs: [{
            mimeType: 'audio/opus',
            payloadType: 111,
            clockRate: 48000,
            channels: 2,
            parameters: {
              'minptime': 10,
              'useinbandfec': 1,
              'sprop-stereo': 1,
              'stereo': 1
            },
            rtcpFeedback: []
          }],
          headerExtensions: [
            {
              uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
              id: 1,
              encrypt: false
            },
            {
              uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
              id: 2,
              encrypt: false
            }
          ],
          encodings: [
            {
              ssrc: 22222222,
              dtx: false
            }
          ],
          rtcp: {
            cname: `viewbot-${botId}-audio`,
            reducedSize: false, // Full RTCP for better sync
            mux: false
          }
        },
        appData: {
          botId,
          kind: 'audio'
        }
      });

      // Store producers
      this.plainProducers.set(botId, {
        video: videoProducer,
        audio: audioProducer
      });

      logger.debug(`✅ PLAIN: Producers created for ${botId}`);
      
      return {
        success: true,
        videoProducerId: videoProducer.id,
        audioProducerId: audioProducer.id,
        ports
      };

    } catch (error) {
      logger.error(`❌ PLAIN: Failed to create producers:`, error);
      throw error;
    }
  }

  /**
   * Connects PlainTransport to FFmpeg RTP source
   */
  async connectPlainTransport(botId, kind, remoteRtpPort, remoteRtcpPort = null) {
    logger.debug(`🔌 PLAIN: Connecting ${kind} transport for ${botId}`);
    
    const transports = this.plainTransports.get(botId);
    if (!transports) {
      throw new Error(`No PlainTransport found for bot ${botId}`);
    }

    const transport = kind === 'video' ? transports.video : transports.audio;
    
    try {
      await transport.connect({
        ip: '127.0.0.1',
        port: remoteRtpPort,
        rtcpPort: remoteRtcpPort || remoteRtpPort + 1
      });

      logger.debug(`✅ PLAIN: ${kind} transport connected for ${botId}`);
      return { success: true };

    } catch (error) {
      logger.error(`❌ PLAIN: Failed to connect transport:`, error);
      throw error;
    }
  }

  /**
   * Gets RTP parameters for FFmpeg configuration
   */
  getRtpParameters(botId) {
    const ports = this.rtpPorts.get(botId);
    if (!ports) {
      return null;
    }

    return {
      video: {
        rtpPort: ports.video,
        rtcpPort: ports.videoRtcp,
        ssrc: 11111111,
        payloadType: 96,
        clockRate: 90000
      },
      audio: {
        rtpPort: ports.audio,
        rtcpPort: ports.audioRtcp,
        ssrc: 22222222,
        payloadType: 111,
        clockRate: 48000
      }
    };
  }

  /**
   * Allocates a pair of ports for RTP/RTCP
   */
  allocatePortPair() {
    const rtpPort = this.currentPort;
    const rtcpPort = this.currentPort + 1;
    this.currentPort += 2;
    
    // Wrap around if we exceed the range
    if (this.currentPort > 49999) {
      this.currentPort = this.baseRtpPort;
    }
    
    return { rtpPort, rtcpPort };
  }

  /**
   * Cleans up PlainTransport resources
   */
  async cleanup(botId) {
    logger.debug(`🧹 PLAIN: Cleaning up resources for ${botId}`);
    
    // Close producers
    const producers = this.plainProducers.get(botId);
    if (producers) {
      if (producers.video) producers.video.close();
      if (producers.audio) producers.audio.close();
      this.plainProducers.delete(botId);
    }

    // Close transports
    const transports = this.plainTransports.get(botId);
    if (transports) {
      if (transports.video) transports.video.close();
      if (transports.audio) transports.audio.close();
      this.plainTransports.delete(botId);
    }

    // Release ports
    this.rtpPorts.delete(botId);
    
    logger.debug(`✅ PLAIN: Cleanup complete for ${botId}`);
  }

  /**
   * Gets statistics for monitoring
   */
  async getStats(botId) {
    const producers = this.plainProducers.get(botId);
    if (!producers) {
      return null;
    }

    const stats = {
      video: null,
      audio: null
    };

    if (producers.video) {
      stats.video = await producers.video.getStats();
    }

    if (producers.audio) {
      stats.audio = await producers.audio.getStats();
    }

    return stats;
  }
}

module.exports = MediasoupPlainTransportService;
