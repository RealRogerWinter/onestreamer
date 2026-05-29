// Pure ffmpeg argument-array builders for the URL-stream relay pipeline,
// extracted verbatim from ViewBotURLService. The service keeps the spawn() +
// logging; these just construct the argv so the (error-prone) flag/bitrate
// logic is unit-testable.
//
// `useAdaptive` is the caller's `adaptiveConfig.enabled && settings` result
// (truthy only when an encodingSettings object is present); `settings` is that
// object (read only when useAdaptive is truthy, matching the original).

// RTP output (MediaSoup path): VP8 video + Opus audio to local RTP ports.
function buildRtpFfmpegArgs({ input, settings, useAdaptive, rtpPorts }) {
  let vfArg = null;
  if (useAdaptive && settings.scale) {
    vfArg = settings.scale;
  }

  const args = [];

  // Input buffer settings for smoother streaming
  args.push(
    '-analyzeduration', '3000000',
    '-probesize', '10000000',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-flags', 'low_delay',
    '-max_delay', '500000'
  );

  if (input !== '-') {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  } else {
    args.push('-thread_queue_size', '4096');
  }

  args.push('-re', '-i', input);

  if (vfArg) {
    args.push('-vf', vfArg);
  }

  // Video encoding (VP8 for MediaSoup)
  args.push(
    '-map', '0:v:0',
    '-c:v', 'libvpx',
    '-deadline', useAdaptive ? settings.deadline : 'realtime',
    '-cpu-used', useAdaptive ? String(settings.cpuUsed) : '8',
    '-b:v', useAdaptive ? `${settings.videoBitrate}k` : '1500k',
    '-maxrate', useAdaptive ? `${settings.maxrate}k` : '2000k',
    '-bufsize', useAdaptive ? `${settings.bufsize}k` : '4000k',
    '-g', useAdaptive ? String(settings.gopSize) : '30',
    '-keyint_min', useAdaptive ? String(settings.keyintMin) : '30',
    '-f', 'rtp',
    `rtp://127.0.0.1:${rtpPorts.video}?pkt_size=1200`
  );

  // Audio encoding (Opus)
  args.push(
    '-map', '0:a:0?',
    '-c:a', 'libopus',
    '-b:a', useAdaptive && settings.audioBitrate ? `${settings.audioBitrate}k` : '128k',
    '-ar', '48000',
    '-ac', useAdaptive ? String(settings.audioChannels || 2) : '2',
    '-f', 'rtp',
    `rtp://127.0.0.1:${rtpPorts.audio}?pkt_size=1200`
  );

  return args;
}

module.exports = { buildRtpFfmpegArgs };
