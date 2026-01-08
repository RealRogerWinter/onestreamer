/**
 * MediaSoup Synchronization Configuration
 * Optimized settings for perfect A/V sync
 */

class MediasoupSyncConfig {
  /**
   * Gets optimized RTP capabilities for synchronized streaming
   */
  static getSyncedRtpCapabilities() {
    return {
      codecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          preferredPayloadType: 111,
          parameters: {
            'minptime': 10,
            'useinbandfec': 1,
            'usedtx': 0, // Disable DTX for consistent timing
            'stereo': 1,
            'sprop-stereo': 1,
            'cbr': 1, // Constant bitrate for predictable timing
            'maxaveragebitrate': 128000,
            'maxplaybackrate': 48000,
            'ptime': 20, // Fixed packet time
            'maxptime': 20 // Maximum packet time
          },
          rtcpFeedback: [
            { type: 'transport-cc' } // Transport-wide congestion control
          ]
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          preferredPayloadType: 96,
          parameters: {
            'max-fs': 3600, // Max macroblocks
            'max-fr': 30 // Max frame rate
          },
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'goog-remb' },
            { type: 'transport-cc' }
          ]
        }
      ],
      headerExtensions: [
        {
          kind: 'audio',
          uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
          preferredId: 1,
          preferredEncrypt: false
        },
        {
          kind: 'video',
          uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
          preferredId: 1,
          preferredEncrypt: false
        },
        {
          kind: 'video',
          uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
          preferredId: 2,
          preferredEncrypt: false
        },
        {
          kind: 'audio',
          uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
          preferredId: 2,
          preferredEncrypt: false
        },
        {
          kind: 'video',
          uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
          preferredId: 3,
          preferredEncrypt: false
        }
      ]
    };
  }

  /**
   * Gets optimized transport options for synchronized streaming
   */
  static getSyncedTransportOptions() {
    return {
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: process.env.ANNOUNCED_IP || null
        }
      ],
      enableUdp: true,
      enableTcp: false, // Disable TCP for consistent latency
      preferUdp: true,
      enableSctp: false,
      initialAvailableOutgoingBitrate: 1000000, // 1 Mbps initial
      minimumAvailableOutgoingBitrate: 200000, // 200 kbps minimum
      maxIncomingBitrate: 5000000, // 5 Mbps max
      // Jitter buffer configuration
      maxPacketLifeTime: null,
      maxRetransmits: null,
      // DTLS parameters
      dtlsParameters: {
        role: 'auto',
        fingerprints: []
      }
    };
  }

  /**
   * Gets optimized consumer parameters for synchronized playback
   * Only includes MediaSoup-compatible parameters
   */
  static getSyncedConsumerParams(kind = 'video') {
    const baseParams = {
      paused: false,
      preferredLayers: null
    };

    if (kind === 'video') {
      return {
        ...baseParams,
        // Simulcast/SVC configuration (MediaSoup compatible)
        preferredLayers: {
          spatialLayer: 2, // Highest quality layer
          temporalLayer: 2
        }
      };
    } else {
      return {
        ...baseParams
        // Audio consumer uses base parameters only
      };
    }
  }

  /**
   * Gets synchronized producer parameters
   */
  static getSyncedProducerParams(kind = 'video') {
    const baseParams = {
      paused: false,
      keyFrameRequestDelay: 5000 // Request keyframe every 5 seconds
    };

    if (kind === 'video') {
      return {
        ...baseParams,
        // Video encoding parameters
        encodings: [
          {
            ssrc: 11111111,
            rtx: { ssrc: 11111112 },
            maxBitrate: 1500000, // 1.5 Mbps
            minBitrate: 200000, // 200 kbps
            maxFramerate: 30,
            scaleResolutionDownBy: 1,
            scalabilityMode: 'L1T2' // Single spatial layer, 2 temporal layers
          }
        ],
        // Codec-specific parameters
        codecOptions: {
          videoGoogleStartBitrate: 1000, // 1 Mbps start
          videoGoogleMaxBitrate: 1500, // 1.5 Mbps max
          videoGoogleMinBitrate: 200 // 200 kbps min
        }
      };
    } else {
      return {
        ...baseParams,
        // Audio encoding parameters
        encodings: [
          {
            ssrc: 22222222,
            dtx: false, // No discontinuous transmission
            maxBitrate: 128000, // 128 kbps
            minBitrate: 32000, // 32 kbps
            stereo: true,
            maxAverageBitrate: 128000,
            opusStereo: true,
            opusFec: true,
            opusDtx: false,
            opusCbr: true, // Constant bitrate
            opusMaxPlaybackRate: 48000,
            opusPtime: 20
          }
        ],
        // Codec-specific parameters
        codecOptions: {
          opusStereo: true,
          opusFec: true,
          opusDtx: false,
          opusMaxPlaybackRate: 48000,
          opusPtime: 20
        }
      };
    }
  }

  /**
   * Configures MediaSoup router for synchronized streaming
   */
  static getRouterMediaCodecs() {
    return [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        parameters: {
          'minptime': 10,
          'useinbandfec': 1,
          'usedtx': 0,
          'stereo': 1,
          'sprop-stereo': 1,
          'cbr': 1,
          'maxaveragebitrate': 128000,
          'maxplaybackrate': 48000,
          'ptime': 20,
          'maxptime': 20
        }
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'max-fs': 3600,
          'max-fr': 30
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
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: {
          'profile-id': 2,
          'max-fs': 3600,
          'max-fr': 30
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
  }

  /**
   * Gets PlainTransport configuration for optimal sync
   */
  static getPlainTransportOptions() {
    return {
      listenIp: {
        ip: '127.0.0.1',
        announcedIp: null
      },
      rtcpMux: false, // Separate RTCP for synchronization
      comedia: true,
      enableSctp: false,
      numSctpStreams: { OS: 0, MIS: 0 },
      enableSrtp: false,
      srtpCryptoSuite: null,
      // Additional options for sync
      rtcpListenIp: {
        ip: '127.0.0.1',
        announcedIp: null
      },
      rtcpPort: null, // Will be auto-allocated
      preferUdp: true,
      preferTcp: false,
      // Max packet size
      maxSctpMessageSize: 1500,
      // Initial bitrate
      initialAvailableOutgoingBitrate: 1000000
    };
  }

  /**
   * Calculates optimal jitter buffer size based on network conditions
   */
  static calculateJitterBuffer(rtt, packetLoss) {
    // Base jitter buffer (ms)
    let jitterBuffer = 50;
    
    // Add buffer based on RTT
    if (rtt > 100) {
      jitterBuffer += Math.min((rtt - 100) / 2, 100);
    }
    
    // Add buffer based on packet loss
    if (packetLoss > 1) {
      jitterBuffer += Math.min(packetLoss * 10, 50);
    }
    
    // Cap at maximum
    return Math.min(jitterBuffer, 200);
  }
}

module.exports = MediasoupSyncConfig;