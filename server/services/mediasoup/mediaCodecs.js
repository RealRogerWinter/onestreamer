/**
 * Router media-codec configuration for MediasoupService.
 *
 * Pure data — extracted VERBATIM from MediasoupService.initialize() so the
 * codec list lives in one place. No behavior change: the parent passes this
 * array to worker.createRouter({ mediaCodecs }) exactly as before.
 *
 * CRITICAL iOS FIX: Optimized codec configuration for iOS Safari compatibility.
 * H264 Baseline (42e01f) is placed first and includes iOS-specific parameters.
 */

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

module.exports = { mediaCodecs };
