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

// RTMP output for a local VIDEO FILE (the LiveKit-backend viewbot filler) — the
// ffmpeg replacement for the former GStreamer pipeline in ViewBotLiveKitService.
// Mirrors that pipeline: H.264 baseline + low-latency + frequent keyframes (the
// old x264enc ultrafast/zerolatency/key-int-max=15), AAC 48k stereo, FLV → RTMP.
// A file with no audio gets a silent stereo track (anullsrc) so the ingress
// always receives audio (the old pipeline used audiotestsrc wave=silence).
// `-re` streams at playback speed; `-shortest` ends with the (finite) video.
function buildVideoFileRtmpArgs({ videoFile, rtmpUrl, hasAudio, videoBitrate, audioBitrate }) {
  const args = ['-re', '-i', videoFile];
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  args.push(
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-c:v', 'libx264',
    '-profile:v', 'baseline',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '15',
    '-b:v', `${videoBitrate}k`,
    '-c:a', 'aac',
    '-b:a', `${audioBitrate}k`,
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  );
  return args;
}

module.exports = { buildRtmpFfmpegArgs, buildVideoFileRtmpArgs };
