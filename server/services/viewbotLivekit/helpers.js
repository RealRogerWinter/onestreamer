/**
 * Pure helpers for ViewBotLiveKitService.
 *
 * These are stateless, side-effect-free shaping/parsing functions extracted
 * verbatim from ViewBotLiveKitService so they can be unit-tested in isolation
 * and reused across the LiveKit ingress/room call sites. The risky core
 * (FFmpeg spawning + the live ingress/room lifecycle) stays in the
 * parent service — only the deterministic argument/config shaping lives here.
 */

/**
 * Ensure a LiveKit host string carries an http(s):// protocol.
 * Mirrors the `host.startsWith('http') ? host : http://${host}` pattern that
 * was duplicated across initialize/createIngress/deleteIngress/cleanup.
 * @param {string} host
 * @returns {string}
 */
function normalizeHost(host) {
  return host.startsWith('http') ? host : `http://${host}`;
}

// Ingress transcode ceiling (see buildIngressRequest). Keep in sync with the
// source-side cap in viewbot/streamDefaults.MAX_SOURCE_HEIGHT.
const MAX_INGRESS_WIDTH = 1280;
const MAX_INGRESS_HEIGHT = 720;

/**
 * Whether a current-streamer identity belongs to a viewbot (which must NOT
 * block other viewbots) rather than a real human streamer.
 * @param {string} streamer
 * @returns {boolean}
 */
function isViewbotIdentity(streamer) {
  return streamer.startsWith('viewbot-') ||
         streamer.includes('viewbot') ||
         streamer.startsWith('bot-');
}

/**
 * Build the LiveKit access-token grant for a publishing viewbot.
 * @param {string} roomName
 * @returns {object}
 */
function buildBotTokenGrant(roomName) {
  return {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: false
  };
}

/**
 * Build the createIngress request payload (everything except the call itself).
 * Pure shaping: chooses the transcoding-options path or the bypass path and
 * folds in adaptive encoding settings. SDK enums (TrackSource) are passed in so
 * this module stays free of the livekit-server-sdk require.
 *
 * @param {object}  args
 * @param {object}  args.bot                 bot with `id`
 * @param {string}  args.roomName            target room
 * @param {object?} args.encodingSettings    optional adaptive settings
 * @param {boolean} args.bypassTranscoding   bypass flag
 * @param {object}  args.TrackSource         livekit-server-sdk TrackSource enum
 * @returns {object} the ingress request object
 */
function buildIngressRequest({ bot, roomName, encodingSettings, bypassTranscoding, TrackSource }) {
  // Determine video settings - prefer adaptive, fall back to defaults
  let videoWidth = encodingSettings?.width || 1280;
  let videoHeight = encodingSettings?.height || 720;
  const videoFps = encodingSettings?.fps || 30;
  let videoBitrate = encodingSettings?.videoBitrate ? encodingSettings.videoBitrate * 1000 : 4000000;

  // Defense-in-depth 720p ceiling: the upstream caps (capSourceQuality +
  // adaptiveConfig max*) should never let >720p reach here, but a probed
  // source dimension passed straight through would make the ingress
  // transcode at full source resolution (~1 core at 1080p on this host).
  const scale = Math.min(1, MAX_INGRESS_WIDTH / videoWidth, MAX_INGRESS_HEIGHT / videoHeight);
  if (scale < 1) {
    videoWidth = Math.round((videoWidth * scale) / 2) * 2;
    videoHeight = Math.round((videoHeight * scale) / 2) * 2;
    videoBitrate = Math.round(videoBitrate * scale * scale);
  }
  const audioBitrate = encodingSettings?.audioBitrate ? encodingSettings.audioBitrate * 1000 : 160000;
  const audioChannels = encodingSettings?.audioChannels || 2;

  const ingressRequest = {
    name: `viewbot-${bot.id}`,
    roomName: roomName,
    participantIdentity: bot.id,
    participantName: `ViewBot ${bot.id}`
  };

  if (!bypassTranscoding) {
    // Default path: explicit encoding options force LiveKit ingress to transcode
    // to the specified layer (60% CPU per active ingress on this box).
    ingressRequest.video = {
      source: TrackSource.CAMERA,
      encodingOptions: {
        case: 'options',
        value: {
          videoCodec: 0, // H264
          frameRate: videoFps,
          layers: [{
            quality: 2, // HIGH
            width: videoWidth,
            height: videoHeight,
            bitrate: videoBitrate
          }]
        }
      }
    };
    ingressRequest.audio = {
      source: TrackSource.MICROPHONE,
      encodingOptions: {
        case: 'options',
        value: {
          audioCodec: 1, // OPUS
          bitrate: audioBitrate,
          channels: audioChannels,
          disableDtx: false
        }
      }
    };
  } else {
    // Bypass path: pass through the source codecs as-is. The upstream ffmpeg
    // (urlstream/FFmpegPipeline.createRTMPProcess) must emit H.264 + AAC/Opus.
    ingressRequest.bypassTranscoding = true;
  }

  return ingressRequest;
}

module.exports = {
  normalizeHost,
  isViewbotIdentity,
  buildBotTokenGrant,
  buildIngressRequest,
};
