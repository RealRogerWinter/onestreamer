/**
 * Pure RTP-parameter builders for ViewBot plain-transport producers.
 * Extracted from ViewBotInstance.createVideoRtpParameters /
 * createAudioRtpParameters. The only instance dependency is botId (used in
 * the rtcp cname); a fresh random SSRC is generated per call, exactly as
 * before. No `this`, no side effects.
 */

function randomSsrc() {
  return Math.floor(Math.random() * 1000000);
}

function buildVideoRtpParameters(botId) {
  const ssrc = randomSsrc();
  return {
    codecs: [
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
    ],
    headerExtensions: [],
    encodings: [
      {
        ssrc: ssrc,
        rtx: {
          ssrc: ssrc + 1
        }
      }
    ],
    rtcp: {
      cname: `viewbot-video-${botId}`,
      reducedSize: true
    }
  };
}

function buildAudioRtpParameters(botId) {
  const ssrc = randomSsrc();
  return {
    codecs: [
      {
        mimeType: 'audio/opus',
        clockRate: 48000,
        payloadType: 111,
        channels: 2,
        parameters: {
          'sprop-stereo': 1,
          'useinbandfec': 1
        },
        rtcpFeedback: []
      }
    ],
    headerExtensions: [],
    encodings: [
      {
        ssrc: ssrc,
        dtx: false
      }
    ],
    rtcp: {
      cname: `viewbot-audio-${botId}`,
      reducedSize: true
    }
  };
}

module.exports = { buildVideoRtpParameters, buildAudioRtpParameters };
