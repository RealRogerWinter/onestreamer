const { buildRtpFfmpegArgs } = require('../../../services/viewbot/ffmpegArgs');

const rtpPorts = { video: 5004, audio: 5006 };

// Helper: value following a flag in the argv.
function valAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildRtpFfmpegArgs', () => {
  test('non-adaptive direct URL: fixed defaults, reconnect, VP8/Opus, RTP ports', () => {
    const args = buildRtpFfmpegArgs({ input: 'http://x/y.m3u8', settings: null, useAdaptive: false, rtpPorts });
    expect(args).toContain('-reconnect');
    expect(args).not.toContain('-thread_queue_size');
    expect(args.slice(0, 2)).toEqual(['-analyzeduration', '3000000']);
    expect(args).toContain('-re');
    expect(valAfter(args, '-c:v')).toBe('libvpx');
    expect(valAfter(args, '-deadline')).toBe('realtime');
    expect(valAfter(args, '-b:v')).toBe('1500k');
    expect(valAfter(args, '-cpu-used')).toBe('8');
    expect(valAfter(args, '-c:a')).toBe('libopus');
    expect(valAfter(args, '-b:a')).toBe('128k');
    expect(args).toContain('rtp://127.0.0.1:5004?pkt_size=1200');
    expect(args).toContain('rtp://127.0.0.1:5006?pkt_size=1200');
    expect(args).not.toContain('-vf');
  });

  test('piped input uses thread_queue_size instead of reconnect', () => {
    const args = buildRtpFfmpegArgs({ input: '-', settings: null, useAdaptive: false, rtpPorts });
    expect(args).toContain('-thread_queue_size');
    expect(args).not.toContain('-reconnect');
  });

  test('adaptive settings drive bitrate/deadline/scale/audio', () => {
    const settings = {
      scale: 'scale=1280:720', deadline: 'good', cpuUsed: 4, videoBitrate: 2500,
      maxrate: 3000, bufsize: 6000, gopSize: 48, keyintMin: 48, audioBitrate: 96, audioChannels: 2,
    };
    const args = buildRtpFfmpegArgs({ input: 'http://x', settings, useAdaptive: settings, rtpPorts });
    expect(valAfter(args, '-vf')).toBe('scale=1280:720');
    expect(valAfter(args, '-deadline')).toBe('good');
    expect(valAfter(args, '-cpu-used')).toBe('4');
    expect(valAfter(args, '-b:v')).toBe('2500k');
    expect(valAfter(args, '-maxrate')).toBe('3000k');
    expect(valAfter(args, '-bufsize')).toBe('6000k');
    expect(valAfter(args, '-g')).toBe('48');
    expect(valAfter(args, '-b:a')).toBe('96k');
  });
});
