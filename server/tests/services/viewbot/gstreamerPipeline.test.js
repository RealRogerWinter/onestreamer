const {
  buildGstreamerVideoPipeline,
  buildGstreamerAudioPipeline,
  gstreamerBinaryPath,
} = require('../../../services/viewbot/gstreamerPipeline');

function valAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildGstreamerVideoPipeline', () => {
  test('encodes vp8/rtpvp8pay with interpolated caps, ssrc, and udp port', () => {
    const p = buildGstreamerVideoPipeline({ videoFile: '/v/clip.mp4', width: 1280, height: 720, frameRate: 30, videoSSRC: 11111111, videoRtpPort: 5004 });
    expect(p).toContain('location=/v/clip.mp4');
    expect(p).toContain('video/x-raw,width=1280,height=720');
    expect(p).toContain('video/x-raw,framerate=30/1');
    expect(p).toContain('vp8enc');
    expect(p).toContain('ssrc=11111111');
    expect(p).toContain('port=5004');
    expect(p[0]).toBe('-e');
    expect(p[p.length - 1]).toBe('async=false');
  });
});

describe('buildGstreamerAudioPipeline', () => {
  test('encodes opus/rtpopuspay with interpolated ssrc + udp port', () => {
    const p = buildGstreamerAudioPipeline({ videoFile: '/v/clip.mp4', audioSSRC: 22222222, audioRtpPort: 5006 });
    expect(p).toContain('location=/v/clip.mp4');
    expect(p).toContain('opusenc');
    expect(p).toContain('ssrc=22222222');
    expect(p).toContain('port=5006');
    expect(p).toContain('audio/x-raw,rate=48000,channels=2');
  });
});

describe('gstreamerBinaryPath', () => {
  test('returns gst-launch-1.0 on linux, the .exe on win32', () => {
    expect(gstreamerBinaryPath('linux')).toBe('gst-launch-1.0');
    expect(gstreamerBinaryPath('win32')).toContain('gst-launch-1.0.exe');
  });
});
