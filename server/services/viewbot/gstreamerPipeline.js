// Pure GStreamer gst-launch-1.0 pipeline builders for ViewBotInstance's direct
// RTP video-file streaming, extracted verbatim from startDirectRTPPipelines.
// The service keeps the spawn() + process wiring; these just construct the argv.

// Video: filesrc -> decodebin -> scale/rate -> vp8enc -> rtpvp8pay -> udpsink.
function buildGstreamerVideoPipeline({ videoFile, width, height, frameRate, videoSSRC, videoRtpPort }) {
  return [
    '-e',  // Force EOS on shutdown
    '-v',  // Verbose for debugging
    'filesrc', `location=${videoFile}`,
    '!', 'decodebin',
    '!', 'queue', 'max-size-buffers=200', 'max-size-time=2000000000', 'max-size-bytes=10485760',
    '!', 'videoconvert',
    '!', 'videoscale',
    '!', `video/x-raw,width=${width},height=${height}`,
    '!', 'videorate',
    '!', `video/x-raw,framerate=${frameRate}/1`,
    '!', 'vp8enc', 'deadline=1', 'cpu-used=4', 'error-resilient=1', 'target-bitrate=1500000', 'keyframe-max-dist=30', 'threads=2',
    '!', 'rtpvp8pay', `ssrc=${videoSSRC}`, 'pt=96', 'mtu=1200', 'picture-id-mode=2',
    '!', 'udpsink', 'host=127.0.0.1', `port=${videoRtpPort}`, 'sync=true', 'async=false'
  ];
}

// Audio: filesrc -> decodebin -> resample -> opusenc -> rtpopuspay -> udpsink.
function buildGstreamerAudioPipeline({ videoFile, audioSSRC, audioRtpPort }) {
  return [
    '-e',  // Force EOS on shutdown
    '-v',  // Verbose for debugging
    'filesrc', `location=${videoFile}`,
    '!', 'decodebin',
    '!', 'queue', 'max-size-buffers=200', 'max-size-time=2000000000', 'max-size-bytes=10485760',
    '!', 'audioconvert',
    '!', 'audioresample',
    '!', 'audio/x-raw,rate=48000,channels=2',
    '!', 'opusenc', 'bitrate=128000', 'frame-size=20',
    '!', 'rtpopuspay', `ssrc=${audioSSRC}`, 'pt=111', 'mtu=1200',
    '!', 'udpsink', 'host=127.0.0.1', `port=${audioRtpPort}`, 'sync=true', 'async=false'
  ];
}

// OS-specific gst-launch binary path.
function gstreamerBinaryPath(platform = process.platform) {
  return platform === 'win32'
    ? 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe'
    : 'gst-launch-1.0';
}

module.exports = { buildGstreamerVideoPipeline, buildGstreamerAudioPipeline, gstreamerBinaryPath };
