const { buildIngressRequest } = require('../../../services/viewbotLivekit/helpers');

// Minimal stand-in for the livekit-server-sdk enum the helper folds in.
const TrackSource = { CAMERA: 1, MICROPHONE: 2 };

function videoLayer(request) {
  return request.video.encodingOptions.value.layers[0];
}

describe('buildIngressRequest 720p ceiling', () => {
  test('defaults (no encodingSettings) stay at 720p', () => {
    const req = buildIngressRequest({
      bot: { id: 'b1' }, roomName: 'r', encodingSettings: null,
      bypassTranscoding: false, TrackSource,
    });
    expect(videoLayer(req)).toMatchObject({ width: 1280, height: 720 });
  });

  test('1080p adaptive settings are clamped to 720p with bitrate scaled by area', () => {
    const req = buildIngressRequest({
      bot: { id: 'b1' }, roomName: 'r',
      encodingSettings: { width: 1920, height: 1080, fps: 30, videoBitrate: 4500 },
      bypassTranscoding: false, TrackSource,
    });
    const layer = videoLayer(req);
    expect(layer.width).toBe(1280);
    expect(layer.height).toBe(720);
    // 4500kbps * (2/3)^2 = 2000kbps
    expect(layer.bitrate).toBe(2000000);
  });

  test('clamp preserves aspect ratio and even dimensions for non-16:9 sources', () => {
    const req = buildIngressRequest({
      bot: { id: 'b1' }, roomName: 'r',
      encodingSettings: { width: 1080, height: 1920, fps: 30, videoBitrate: 4500 },
      bypassTranscoding: false, TrackSource,
    });
    const layer = videoLayer(req);
    expect(layer.height).toBe(720);
    expect(layer.width).toBe(406); // 1080 * (720/1920) = 405 -> rounded to even
    expect(layer.width % 2).toBe(0);
    expect(layer.height % 2).toBe(0);
  });

  test('sub-720p settings pass through unclamped', () => {
    const req = buildIngressRequest({
      bot: { id: 'b1' }, roomName: 'r',
      encodingSettings: { width: 854, height: 480, fps: 30, videoBitrate: 1500 },
      bypassTranscoding: false, TrackSource,
    });
    expect(videoLayer(req)).toMatchObject({ width: 854, height: 480, bitrate: 1500000 });
  });
});
