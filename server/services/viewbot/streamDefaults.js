// Platform x quality default stream properties (resolution/fps/bitrate),
// extracted verbatim from ViewBotURLService._getDefaultPropsForPlatform. Pure:
// baseDefaults (the probe service's generic defaults) is injected and merged
// underneath the platform/quality-specific values.

const PLATFORM_DEFAULTS = {
  twitch: {
    best: { width: 1920, height: 1080, fps: 60, videoBitrate: 6000000 },
    '1080p': { width: 1920, height: 1080, fps: 60, videoBitrate: 6000000 },
    '720p': { width: 1280, height: 720, fps: 60, videoBitrate: 3000000 },
    '480p': { width: 854, height: 480, fps: 30, videoBitrate: 1500000 },
    worst: { width: 640, height: 360, fps: 30, videoBitrate: 800000 },
  },
  youtube: {
    best: { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
    '1080p': { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
    '720p': { width: 1280, height: 720, fps: 60, videoBitrate: 4000000 },
    '480p': { width: 854, height: 480, fps: 30, videoBitrate: 2000000 },
    worst: { width: 640, height: 360, fps: 30, videoBitrate: 1000000 },
  },
  kick: {
    best: { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
    '1080p': { width: 1920, height: 1080, fps: 60, videoBitrate: 8000000 },
    '720p': { width: 1280, height: 720, fps: 60, videoBitrate: 4000000 },
    '480p': { width: 854, height: 480, fps: 30, videoBitrate: 1500000 },
    worst: { width: 640, height: 360, fps: 30, videoBitrate: 800000 },
  },
  default: {
    best: { width: 1280, height: 720, fps: 30, videoBitrate: 3000000 },
    worst: { width: 640, height: 360, fps: 30, videoBitrate: 1000000 },
  },
};

// Hard ceiling for the relay's SOURCE variant. The prod relay runs in
// stream-copy mode (VIEWBOT_STREAM_COPY=true), so whatever variant we pull is
// what the LiveKit ingress has to decode + transcode — pulling 1080p costs
// ~2x the ingress CPU of 720p on this 4-core host for zero visible benefit.
const MAX_SOURCE_HEIGHT = 720;

/**
 * Cap a requested source quality at MAX_SOURCE_HEIGHT. 'best'/'source' and
 * any explicit resolution above the cap collapse to '720p'; lower explicit
 * qualities ('480p', 'worst', …) pass through unchanged.
 */
function capSourceQuality(quality) {
  if (!quality || quality === 'best' || quality === 'source') {
    return `${MAX_SOURCE_HEIGHT}p`;
  }
  const m = String(quality).match(/^(\d+)p/);
  if (m && parseInt(m[1], 10) > MAX_SOURCE_HEIGHT) {
    return `${MAX_SOURCE_HEIGHT}p`;
  }
  return quality;
}

function defaultPropsForPlatform(platform, quality, baseDefaults = {}) {
  const platformSettings = PLATFORM_DEFAULTS[platform] || PLATFORM_DEFAULTS.default;
  const qualitySettings = platformSettings[quality] || platformSettings.best || platformSettings.default?.best;

  return {
    ...baseDefaults,
    ...qualitySettings,
    hasAudio: true,
    audioBitrate: 128000,
    probeNote: `platform_default_${platform}`,
  };
}

module.exports = { PLATFORM_DEFAULTS, defaultPropsForPlatform, capSourceQuality, MAX_SOURCE_HEIGHT };
