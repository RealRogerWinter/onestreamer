const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const logger = require('../../bootstrap/logger').child({ svc: 'RecordingService' });

/**
 * RecordingMediaPipeline - MediaSoup/FFmpeg plumbing for RecordingService.
 *
 * Owns plain-transport creation, consumer wiring, the FFmpeg recording process
 * launch, and session resource cleanup. Extracted VERBATIM from
 * RecordingService; all state lives on the owning service. Methods are thin
 * delegators with identical signatures (`this.` -> `owner.`), and internal
 * cross-calls route through `owner.<method>` so spies on the service fire.
 *
 * @param {Object} owner - The RecordingService instance (state + back-refs).
 */
class RecordingMediaPipeline {
  constructor(owner) {
    this.owner = owner;
  }

  async createPlainTransports() {
    const owner = this.owner;
    try {
      logger.debug(`📡 RECORDING: Creating plain transports for recording`);

      const router = owner.webrtcService.router;
      if (!router) {
        throw new Error('MediaSoup router not available');
      }

      const transports = new Map();
      const ffmpegPorts = {
        video: 5004,
        audio: 5006
      };

      // Create video transport
      try {
        const videoTransport = await router.createPlainTransport({
          listenIp: {
            ip: '127.0.0.1',
            announcedIp: null
        },
          rtcpMux: false,
          comedia: false
        });

        // Connect video transport to FFmpeg video port
        await videoTransport.connect({
          ip: '127.0.0.1',
          port: ffmpegPorts.video,
          rtcpPort: ffmpegPorts.video + 1
        });

        logger.debug(`📡 RECORDING: Video transport created and connected:`);
        logger.debug(`   Transport ID: ${videoTransport.id}`);
        logger.debug(`   Destination: 127.0.0.1:${ffmpegPorts.video}`);

        transports.set('video', videoTransport);
      } catch (error) {
        logger.error(`❌ RECORDING: Failed to create video transport:`, error);
      }

      // Create audio transport
      try {
        const audioTransport = await router.createPlainTransport({
          listenIp: {
            ip: '127.0.0.1',
            announcedIp: null
          },
          rtcpMux: false,
          comedia: false
        });

        // Connect audio transport to FFmpeg audio port
        await audioTransport.connect({
          ip: '127.0.0.1',
          port: ffmpegPorts.audio,
          rtcpPort: ffmpegPorts.audio + 1
        });

        logger.debug(`📡 RECORDING: Audio transport created and connected:`);
        logger.debug(`   Transport ID: ${audioTransport.id}`);
        logger.debug(`   Destination: 127.0.0.1:${ffmpegPorts.audio}`);

        transports.set('audio', audioTransport);
      } catch (error) {
        logger.error(`❌ RECORDING: Failed to create audio transport:`, error);
      }

      if (transports.size === 0) {
        return { success: false, error: 'Failed to create any transports' };
      }

      // Store FFmpeg ports for later use
      transports.ffmpegPorts = ffmpegPorts;

      return { success: true, transports };

    } catch (error) {
      logger.error(`❌ RECORDING: Failed to create plain transports:`, error);
      return { success: false, error: error.message };
    }
  }

  async createConsumers(recordingSession) {
    const owner = this.owner;
    try {
      logger.debug(`👥 RECORDING: Creating consumers for recording ${recordingSession.id}`);

      const currentStreamer = owner.webrtcService.getCurrentStreamer();
      const producerMap = owner.webrtcService.producers.get(currentStreamer);

      if (!producerMap || producerMap.size === 0) {
        return { success: false, error: 'No producers available for recording' };
      }

      const transports = recordingSession.transports;
      const consumers = recordingSession.consumers;

      // Create consumer for each producer using the appropriate transport
      for (const [kind, producer] of producerMap) {
        try {
          const transport = transports.get(kind);
          if (!transport) {
            logger.error(`❌ RECORDING: No transport available for ${kind}`);
            continue;
          }

          logger.debug(`🎬 RECORDING: Creating ${kind} consumer from producer ${producer.id}`);

          // For plain transport, we need to provide basic RTP capabilities
          const rtpCapabilities = {
            codecs: [
              {
                kind: kind,
                mimeType: kind === 'video' ? 'video/VP8' : 'audio/opus',
                clockRate: kind === 'video' ? 90000 : 48000,
                channels: kind === 'audio' ? 2 : undefined,
                parameters: {},
                rtcpFeedback: kind === 'video' ? [
                  { type: 'nack' },
                  { type: 'nack', parameter: 'pli' },
                  { type: 'ccm', parameter: 'fir' },
                  { type: 'goog-remb' }
                ] : [
                  { type: 'transport-cc' }
                ]
              }
            ],
            headerExtensions: []
          };

          const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: rtpCapabilities,
            paused: false
          });

          // Resume the consumer to start receiving media
          await consumer.resume();

          logger.debug(`📊 RECORDING: ${kind} consumer created:`, {
            id: consumer.id,
            kind: consumer.kind,
            paused: consumer.paused,
            rtpParameters: {
              codecs: consumer.rtpParameters.codecs,
              encodings: consumer.rtpParameters.encodings
            }
          });

          consumer.on('transportclose', () => {
            logger.debug(`🔒 RECORDING: Transport closed for ${kind} consumer in recording ${recordingSession.id}`);
          });

          consumer.on('producerclose', () => {
            logger.debug(`🔒 RECORDING: Producer closed for ${kind} in recording ${recordingSession.id}`);
          });

          consumer.on('producerpause', () => {
            logger.debug(`⏸️ RECORDING: Producer paused for ${kind} in recording ${recordingSession.id}`);
          });

          consumer.on('producerresume', () => {
            logger.debug(`▶️ RECORDING: Producer resumed for ${kind} in recording ${recordingSession.id}`);
          });

          consumers.set(kind, consumer);
          logger.debug(`✅ RECORDING: Created and resumed ${kind} consumer for recording ${recordingSession.id}`);

        } catch (error) {
          logger.error(`❌ RECORDING: Failed to create ${kind} consumer:`, error);
        }
      }

      if (consumers.size === 0) {
        return { success: false, error: 'Failed to create any consumers' };
      }

      logger.debug(`✅ RECORDING: Successfully created ${consumers.size} consumers for recording`);
      return { success: true };

    } catch (error) {
      logger.error('❌ RECORDING: Failed to create consumers:', error);
      return { success: false, error: error.message };
    }
  }

  async startFFmpegRecording(recordingSession) {
    const owner = this.owner;
    try {
      logger.debug(`🎬 RECORDING: Starting FFmpeg for recording ${recordingSession.id}`);

      const profile = recordingSession.profile;
      const filePath = recordingSession.filePath;
      const transports = recordingSession.transports;
      const consumers = recordingSession.consumers;

      // Get the RTP parameters from consumers
      const videoConsumer = consumers.get('video');
      const audioConsumer = consumers.get('audio');

      if (!videoConsumer && !audioConsumer) {
        return { success: false, error: 'No consumers available for recording' };
      }

      // Get the FFmpeg listening ports from transports
      const ffmpegPorts = transports.ffmpegPorts || { video: 5004, audio: 5006 };

      logger.debug(`🔧 RECORDING: FFmpeg will listen on ports:`);
      logger.debug(`   Video: ${ffmpegPorts.video}`);
      logger.debug(`   Audio: ${ffmpegPorts.audio}`);

      // Build FFmpeg command with direct UDP inputs
      const ffmpegArgs = [];

      if (videoConsumer) {
        const videoRtpParams = videoConsumer.rtpParameters;
        const videoCodec = videoRtpParams.codecs[0];
        const payloadType = videoCodec.payloadType;
        const ssrc = videoRtpParams.encodings[0].ssrc;

        logger.debug(`📹 RECORDING: Video - Codec: ${videoCodec.mimeType}, PT: ${payloadType}, SSRC: ${ssrc}`);

        // Create SDP for video
        const videoSdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg
c=IN IP4 127.0.0.1
t=0 0
m=video ${ffmpegPorts.video} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${videoCodec.mimeType.replace('video/', '').toUpperCase()}/${videoCodec.clockRate}
`;

        const videoSdpPath = path.join(owner.storagePaths.temp, `video_${recordingSession.id}.sdp`);
        fs.writeFileSync(videoSdpPath, videoSdp);

        ffmpegArgs.push(
          '-protocol_whitelist', 'file,udp,rtp',
          '-f', 'sdp',
          '-i', videoSdpPath
        );
      }

      if (audioConsumer) {
        const audioRtpParams = audioConsumer.rtpParameters;
        const audioCodec = audioRtpParams.codecs[0];
        const payloadType = audioCodec.payloadType;
        const ssrc = audioRtpParams.encodings[0].ssrc;

        logger.debug(`🎵 RECORDING: Audio - Codec: ${audioCodec.mimeType}, PT: ${payloadType}, SSRC: ${ssrc}`);

        // Create separate SDP for audio
        const audioSdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg
c=IN IP4 127.0.0.1
t=0 0
m=audio ${ffmpegPorts.audio} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${audioCodec.mimeType.includes('opus') ? `opus/${audioCodec.clockRate}/2` : `${audioCodec.mimeType.replace('audio/', '')}/${audioCodec.clockRate}`}
`;

        const audioSdpPath = path.join(owner.storagePaths.temp, `audio_${recordingSession.id}.sdp`);
        fs.writeFileSync(audioSdpPath, audioSdp);

        ffmpegArgs.push(
          '-protocol_whitelist', 'file,udp,rtp',
          '-f', 'sdp',
          '-i', audioSdpPath
        );
      }

      // Add output options
      ffmpegArgs.push(
        '-c:v', 'libvpx',
        '-b:v', profile.videoBitrate,
        '-c:a', 'libopus',
        '-b:a', profile.audioBitrate,
        '-f', 'webm',
        '-y',
        filePath
      );

      logger.debug(`🚀 RECORDING: Starting FFmpeg with args:`, ffmpegArgs.join(' '));

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

      ffmpegProcess.stdout.on('data', (data) => {
        logger.debug(`📹 FFmpeg stdout: ${data}`);
      });

      ffmpegProcess.stderr.on('data', (data) => {
        const message = data.toString();
        // Log all FFmpeg output for debugging
        logger.debug(`📹 FFmpeg: ${message}`);
      });

      ffmpegProcess.on('error', (error) => {
        logger.error(`❌ RECORDING: FFmpeg error for ${recordingSession.id}:`, error);
        recordingSession.status = 'failed';
      });

      ffmpegProcess.on('close', (code) => {
        logger.debug(`🏁 RECORDING: FFmpeg closed for ${recordingSession.id} with code ${code}`);
        // Cleanup SDP files
        const tempFiles = fs.readdirSync(owner.storagePaths.temp);
        tempFiles.forEach(file => {
          if (file.includes(recordingSession.id)) {
            fs.unlinkSync(path.join(owner.storagePaths.temp, file));
          }
        });
      });

      // Give FFmpeg time to start up
      await new Promise(resolve => setTimeout(resolve, 1000));

      return { success: true, process: ffmpegProcess };

    } catch (error) {
      logger.error('❌ RECORDING: Failed to start FFmpeg:', error);
      return { success: false, error: error.message };
    }
  }

  async cleanupRecordingSession(recordingSession) {
    logger.debug(`🧹 RECORDING: Cleaning up recording session ${recordingSession.id}`);

    try {
      // Close consumers
      if (recordingSession.consumers) {
        for (const [kind, consumer] of recordingSession.consumers) {
          if (!consumer.closed) {
            consumer.close();
          }
        }
        recordingSession.consumers.clear();
      }

      // Close transports
      if (recordingSession.transports) {
        for (const [kind, transport] of recordingSession.transports) {
          if (!transport.closed) {
            transport.close();
          }
        }
        recordingSession.transports.clear();
      }

    } catch (error) {
      logger.error('❌ RECORDING: Error during cleanup:', error);
    }
  }
}

module.exports = RecordingMediaPipeline;
