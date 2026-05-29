// Pure ffmpeg arg builders for ViewBotInstance's test-pattern / video-file RTP
// generation, extracted verbatim from createVideoFFmpegArgs / createAudioFFmpegArgs
// (the methods now delegate). Pure aside from fs existence checks + the optional
// logger; reads process.env.SERVER_HOST for the rtp:// destination (unchanged).
const fs = require('fs');

function buildTestPatternVideoArgs({ videoRtpPort, config, width, height, frameRate, pattern, botId = '', logger = null }) {
    if (!videoRtpPort) {
      throw new Error('Video RTP port not allocated by server');
    }
    
    // Determine input source based on content type
    let inputArgs = [];
    
    if (config.contentType === 'videoFile' && config.videoFile) {
      logger?.debug(`🎬 ViewBot ${botId}: Using video file input: ${config.videoFile}`);
      logger?.debug(`🎬 ViewBot ${botId}: ContentType is: "${config.contentType}"`);
      logger?.debug(`🎬 ViewBot ${botId}: Video file path: "${config.videoFile}"`);
      
      // Check if file exists and is actually a file (not a directory)
      const path = require('path');
      
      if (!fs.existsSync(config.videoFile)) {
        logger?.error(`❌ ViewBot ${botId}: Video file does not exist: ${config.videoFile}`);
        throw new Error(`Video file not found: ${config.videoFile}`);
      }
      
      const stats = fs.statSync(config.videoFile);
      if (stats.isDirectory()) {
        logger?.error(`❌ ViewBot ${botId}: Path is a directory, not a file: ${config.videoFile}`);
        throw new Error(`Path is a directory, not a video file: ${config.videoFile}`);
      }
      
      // Check if file has a video extension
      const ext = path.extname(config.videoFile).toLowerCase();
      const validExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv', '.ts'];
      if (!validExtensions.includes(ext)) {
        logger?.warn(`⚠️ ViewBot ${botId}: File does not have a recognized video extension: ${ext}`);
        logger?.warn(`⚠️ ViewBot ${botId}: Supported extensions: ${validExtensions.join(', ')}`);
        logger?.warn(`⚠️ ViewBot ${botId}: Attempting to process anyway...`);
      }
      
      logger?.debug(`✅ ViewBot ${botId}: Video file exists and will be used for streaming`);
      
      inputArgs = [
        // No loop - allow video to end naturally
        '-i', config.videoFile // Node.js spawn() handles paths with spaces automatically
      ];
    } else {
      // Use test pattern sources
      let videoInput;
      switch (pattern) {
        case 'color-bars':
        case 'color_bars':
          videoInput = `testsrc2=size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        case 'moving-text':
        case 'moving_text':
          videoInput = `color=black:size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        case 'clock':
          videoInput = `testsrc=size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        case 'noise':
          videoInput = `rgbtestsrc=size=${width}x${height}:rate=${frameRate}:duration=3600`;
          break;
        default:
          videoInput = `testsrc2=size=${width}x${height}:rate=${frameRate}:duration=3600`;
      }
      
      inputArgs = [
        '-f', 'lavfi',
        '-i', videoInput
      ];
    }
    
    // Use fixed SSRC that matches what MediaSoup expects
    const ssrc = 11111111; // Fixed video SSRC
    
    // Build complete FFmpeg args
    const args = [
      '-re', // Read input at native frame rate
      ...inputArgs, // Input source (test pattern or video file)
      // Video processing options with PTS reset for sync
      '-vf', `scale=${width}:${height},format=yuv420p,setpts=PTS-STARTPTS`, // Scale, ensure format, and reset PTS
      '-r', frameRate.toString(), // Set frame rate
      '-vsync', 'cfr', // Constant frame rate for consistent timing
      // Video codec settings for VP8 with better parameters
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-error-resilient', '1',
      '-auto-alt-ref', '0',
      '-cpu-used', '8', // Faster encoding for real-time
      '-b:v', '800k',
      '-minrate', '400k',
      '-maxrate', '1200k',
      '-bufsize', '1600k',
      '-g', '10', // Keyframe every 10 frames for faster start
      '-keyint_min', '10', // Minimum keyframe interval
      '-quality', 'realtime',
      '-static-thresh', '0', // Disable static area detection
      '-max-intra-rate', '0', // No limit on intra frames
      '-lag-in-frames', '0', // No frame lookahead
      '-pix_fmt', 'yuv420p',
      // RTP output settings with fixed SSRC
      '-an', // No audio in video stream
      '-f', 'rtp',
      '-ssrc', String(ssrc),
      '-payload_type', '96',
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${videoRtpPort}`
    ];
    
    logger?.debug(`🎬 ViewBot ${botId}: Video FFmpeg command: ffmpeg ${args.join(' ')}`);
    
    // Debug the actual input configuration
    logger?.debug(`🔍 ViewBot ${botId}: Video config debug:`);
    logger?.debug(`  - contentType: "${config.contentType}"`);
    logger?.debug(`  - videoFile: "${config.videoFile}"`);
    logger?.debug(`  - using video file input: ${config.contentType === 'videoFile' && config.videoFile}`);
    logger?.debug(`  - input args: [${inputArgs.join(', ')}]`);
    logger?.debug(`  - target RTP port: ${videoRtpPort}`);
    
    return args;
}

function buildTestPatternAudioArgs({ audioRtpPort, config, botId = '', logger = null }) {
    if (!audioRtpPort) {
      throw new Error('Audio RTP port not allocated by server');
    }
    
    // Use fixed SSRC that matches what MediaSoup expects
    const ssrc = 22222222; // Fixed audio SSRC
    
    // Determine audio input source based on content type
    let inputArgs = [];
    
    if (config.contentType === 'videoFile' && config.videoFile) {
      logger?.debug(`🎤 ViewBot ${botId}: Extracting audio from video file: ${config.videoFile}`);
      logger?.debug(`🎤 ViewBot ${botId}: ContentType is: "${config.contentType}"`);
      logger?.debug(`🎤 ViewBot ${botId}: Video file path: "${config.videoFile}"`);
      
      // Check if file exists and is actually a file (not a directory)
      const path = require('path');
      
      if (!fs.existsSync(config.videoFile)) {
        logger?.error(`❌ ViewBot ${botId}: Video file does not exist: ${config.videoFile}`);
        throw new Error(`Video file not found: ${config.videoFile}`);
      }
      
      const stats = fs.statSync(config.videoFile);
      if (stats.isDirectory()) {
        logger?.error(`❌ ViewBot ${botId}: Path is a directory, not a file: ${config.videoFile}`);
        throw new Error(`Path is a directory, not a video file: ${config.videoFile}`);
      }
      
      logger?.debug(`✅ ViewBot ${botId}: Video file exists, audio will be extracted`);
      
      inputArgs = [
        // No loop - allow video to end naturally
        '-i', config.videoFile // Node.js spawn() handles paths with spaces automatically
      ];
    } else {
      // Use silent audio for test patterns
      inputArgs = [
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:duration=3600' // Silent audio for 1 hour
      ];
    }
    
    // Build complete audio FFmpeg args
    const args = [
      '-re', // Read input at native frame rate
      ...inputArgs, // Input source (silent audio or video file audio)
      // Audio processing with sync
      '-af', 'aresample=async=1:first_pts=0', // Resample with sync
      // Audio codec settings for Opus
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      // RTP output settings with fixed SSRC
      '-vn', // No video in audio stream
      '-f', 'rtp',
      '-ssrc', String(ssrc),
      '-payload_type', '111',
      `rtp://${process.env.SERVER_HOST || '127.0.0.1'}:${audioRtpPort}`
    ];
    
    logger?.debug(`🎤 ViewBot ${botId}: Audio FFmpeg command: ffmpeg ${args.join(' ')}`);
    return args;
}

module.exports = { buildTestPatternVideoArgs, buildTestPatternAudioArgs };
