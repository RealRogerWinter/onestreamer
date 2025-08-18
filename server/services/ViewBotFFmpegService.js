const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Simplified FFmpeg service for ViewBot streaming
 * Uses SDP files for proper RTP configuration
 */
class ViewBotFFmpegService {
  constructor() {
    this.ffmpegProcesses = new Map();
    this.tempDir = path.join(__dirname, '../temp');
    
    // FFmpeg path for Windows
    this.ffmpegPath = 'C:\\Users\\18084\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Creates an SDP file for FFmpeg to send RTP to MediaSoup
   */
  createSDPFile(botId, videoPort, audioPort) {
    const sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=ViewBot Stream
c=IN IP4 127.0.0.1
t=0 0
m=video ${videoPort} RTP/AVP 96
a=rtpmap:96 VP8/90000
m=audio ${audioPort} RTP/AVP 111
a=rtpmap:111 opus/48000/2
`;

    const sdpPath = path.join(this.tempDir, `viewbot_${botId}.sdp`);
    fs.writeFileSync(sdpPath, sdpContent);
    console.log(`📝 SDP file created for ViewBot ${botId}: ${sdpPath}`);
    return sdpPath;
  }

  /**
   * Starts FFmpeg streaming with test pattern using HLS
   */
  startStreaming(botId, config) {
    const { pattern = 'testsrc2', width = 1280, height = 720, frameRate = 30 } = config;
    
    console.log(`🎬 Starting FFmpeg for ViewBot ${botId}`);
    console.log(`   Pattern: ${pattern}`);
    console.log(`   Resolution: ${width}x${height}@${frameRate}fps`);
    
    // Create HLS output directory
    const hlsPath = path.join(__dirname, '../../public/hls');
    if (!fs.existsSync(hlsPath)) {
      fs.mkdirSync(hlsPath, { recursive: true });
    }
    
    // Build video filter based on pattern
    let videoFilter;
    switch (pattern) {
      case 'bars':
      case 'testsrc2':
        videoFilter = `testsrc2=size=${width}x${height}:rate=${frameRate}`;
        break;
      case 'testsrc':
        videoFilter = `testsrc=size=${width}x${height}:rate=${frameRate}`;
        break;
      case 'smptebars':
        videoFilter = `smptebars=size=${width}x${height}:rate=${frameRate}`;
        break;
      case 'color':
        videoFilter = `color=c=blue:size=${width}x${height}:rate=${frameRate}`;
        break;
      default:
        videoFilter = `testsrc2=size=${width}x${height}:rate=${frameRate}`;
    }
    
    // Optimized FFmpeg command for HLS streaming
    const ffmpegArgs = [
      // Input
      '-re',
      '-f', 'lavfi',
      '-i', videoFilter,
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      
      // Video encoding with optimized settings for HLS
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-b:v', '2000k',
      '-maxrate', '3000k',
      '-bufsize', '4000k',
      '-g', String(frameRate * 2), // Keyframe interval (2 seconds)
      '-sc_threshold', '0',
      
      // Audio encoding
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      
      // HLS output settings
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', path.join(hlsPath, `viewbot_${botId}_%03d.ts`),
      path.join(hlsPath, `viewbot_${botId}.m3u8`)
    ];
    
    console.log(`🎬 FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
    
    // Start FFmpeg
    const ffmpeg = spawn(this.ffmpegPath || 'ffmpeg', ffmpegArgs);
    
    ffmpeg.stdout.on('data', (data) => {
      console.log(`📺 FFmpeg stdout: ${data}`);
    });
    
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      // Only log errors and important info
      if (output.includes('error') || output.includes('Error')) {
        console.error(`❌ FFmpeg stderr: ${output}`);
      } else if (output.includes('frame=')) {
        // Log frame progress occasionally
        if (Math.random() < 0.01) {
          console.log(`🎬 FFmpeg progress: ${output.trim()}`);
        }
      }
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`🛑 FFmpeg process exited with code ${code}`);
      this.ffmpegProcesses.delete(botId);
      // Clean up HLS files
      const hlsFiles = [`viewbot_${botId}.m3u8`];
      for (let i = 0; i < 10; i++) {
        hlsFiles.push(`viewbot_${botId}_${String(i).padStart(3, '0')}.ts`);
      }
      hlsFiles.forEach(file => {
        const filePath = path.join(hlsPath, file);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      });
    });
    
    ffmpeg.on('error', (error) => {
      console.error(`❌ FFmpeg error for ViewBot ${botId}:`, error);
      this.ffmpegProcesses.delete(botId);
    });
    
    // Store process
    this.ffmpegProcesses.set(botId, {
      process: ffmpeg,
      hlsPath: path.join(hlsPath, `viewbot_${botId}.m3u8`),
      startTime: Date.now()
    });
    
    return {
      success: true,
      message: 'FFmpeg HLS streaming started',
      hlsUrl: `/hls/viewbot_${botId}.m3u8`
    };
  }

  /**
   * Stops FFmpeg streaming for a bot
   */
  stopStreaming(botId) {
    const ffmpegData = this.ffmpegProcesses.get(botId);
    if (!ffmpegData) {
      return { success: false, message: 'No FFmpeg process found for this bot' };
    }
    
    const { process: ffmpeg, hlsPath } = ffmpegData;
    
    // Kill FFmpeg process
    ffmpeg.kill('SIGTERM');
    
    // Clean up HLS files
    const hlsDir = path.dirname(hlsPath);
    const hlsFiles = [`viewbot_${botId}.m3u8`];
    for (let i = 0; i < 10; i++) {
      hlsFiles.push(`viewbot_${botId}_${String(i).padStart(3, '0')}.ts`);
    }
    hlsFiles.forEach(file => {
      const filePath = path.join(hlsDir, file);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    });
    
    this.ffmpegProcesses.delete(botId);
    
    return { success: true, message: 'FFmpeg streaming stopped' };
  }

  /**
   * Gets status of FFmpeg streaming
   */
  getStatus(botId) {
    const ffmpegData = this.ffmpegProcesses.get(botId);
    if (!ffmpegData) {
      return { active: false };
    }
    
    return {
      active: true,
      hlsUrl: `/hls/viewbot_${botId}.m3u8`,
      uptime: Date.now() - ffmpegData.startTime
    };
  }

  /**
   * Stops all FFmpeg processes
   */
  stopAll() {
    for (const [botId] of this.ffmpegProcesses) {
      this.stopStreaming(botId);
    }
  }
}

module.exports = ViewBotFFmpegService;