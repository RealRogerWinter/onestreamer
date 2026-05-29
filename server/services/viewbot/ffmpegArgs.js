// Pure ffmpeg argument-array builders for the URL-stream relay pipeline,
// extracted verbatim from ViewBotURLService. The service keeps the spawn() +
// logging; these just construct the argv so the (error-prone) flag/bitrate
// logic is unit-testable.
//
// `useAdaptive` is the caller's `adaptiveConfig.enabled && settings` result
// (truthy only when an encodingSettings object is present); `settings` is that
// object (read only when useAdaptive is truthy, matching the original).

// Input buffer settings shared by both pipelines (smoother streaming).
const BASE_INPUT_BUFFER_ARGS = [
  '-analyzeduration', '3000000',
  '-probesize', '10000000',
  '-fflags', '+genpts+discardcorrupt+nobuffer',
  '-flags', 'low_delay',
  '-max_delay', '500000',
];

// RTP output (MediaSoup path): VP8 video + Opus audio to local RTP ports.
function buildRtpFfmpegArgs({ input, settings, useAdaptive, rtpPorts }) {
  let vfArg = null;
  if (useAdaptive && settings.scale) {
    vfArg = settings.scale;
  }

  const args = [...BASE_INPUT_BUFFER_ARGS];

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

// RTMP output (LiveKit path): H.264 + AAC to an RTMP URL. `streamCopy` is the
// caller's resolved flag (env VIEWBOT_STREAM_COPY && direct input) — when set,
// the source is passed through without re-encoding.
function buildRtmpFfmpegArgs({ input, rtmpUrl, settings, useAdaptive, streamCopy }) {
  const args = [...BASE_INPUT_BUFFER_ARGS];

  // Direct URL inputs add reconnect + -re; piped stdin adds a thread queue.
  if (input !== '-') {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-re');
  } else {
    args.push('-thread_queue_size', '4096');
  }

  args.push('-i', input);

  // Stream-copy: bypass re-encoding entirely (source already H.264 + AAC).
  if (streamCopy) {
    args.push('-c:v', 'copy', '-c:a', 'copy', '-bsf:v', 'h264_mp4toannexb');
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', rtmpUrl);
    return args;
  }

  // Video filter — adaptive scale, adaptive fps-only, or default 720p.
  if (useAdaptive && settings.scale) {
    args.push('-vf', settings.scale);
  } else if (useAdaptive) {
    if (settings.sourceFps && Math.abs(settings.sourceFps - settings.fps) > 2) {
      args.push('-vf', `fps=${settings.fps}`);
    }
  } else {
    args.push('-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
  }

  // Video encoding (libx264) — adaptive or default fixed 720p.
  if (useAdaptive) {
    args.push(
      '-c:v', 'libx264',
      '-preset', settings.preset,
      '-profile:v', settings.profile,
      '-level', settings.level,
      '-b:v', `${settings.videoBitrate}k`,
      '-maxrate', `${settings.maxrate}k`,
      '-bufsize', `${settings.bufsize}k`,
      '-pix_fmt', settings.pixFmt,
      '-r', String(settings.fps),
      '-g', String(settings.gopSize),
      '-keyint_min', String(settings.keyintMin),
      '-sc_threshold', String(settings.scThreshold)
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-profile:v', 'main',
      '-level', '3.1',
      '-b:v', '2000k',
      '-maxrate', '2500k',
      '-bufsize', '4000k',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-keyint_min', '30',
      '-sc_threshold', '0'
    );
  }

  // Audio encoding (AAC)
  args.push(
    '-c:a', 'aac',
    '-b:a', useAdaptive && settings.audioBitrate ? `${settings.audioBitrate}k` : '160k',
    '-ar', '48000',
    '-ac', useAdaptive ? String(settings.audioChannels || 2) : '2'
  );

  // Output (FLV/RTMP)
  args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', rtmpUrl);

  return args;
}

module.exports = { buildRtpFfmpegArgs, buildRtmpFfmpegArgs };
