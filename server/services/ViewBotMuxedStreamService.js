/**
 * ViewBot Multiplexed Stream Service
 * Handles MPEG-TS multiplexed streams for perfect A/V synchronization
 */

const { spawn } = require('child_process');
const dgram = require('dgram');
const { Transform } = require('stream');

class ViewBotMuxedStreamService {
  constructor() {
    this.activeStreams = new Map();
    this.demuxers = new Map();
    // FFmpeg path for Windows
    this.ffmpegPath = 'C:\\Users\\18084\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
  }

  /**
   * Starts a multiplexed MPEG-TS stream with perfect A/V sync
   * @param {string} botId - The ViewBot ID
   * @param {object} config - Stream configuration
   * @param {number} rtpPort - Base RTP port (will use port and port+2 for video/audio)
   */
  async startMuxedStream(botId, config, rtpPort) {
    console.log(`🎬 MUXED: Starting multiplexed stream for ViewBot ${botId}`);
    
    const { videoFile, width = 1280, height = 720, frameRate = 30 } = config;
    
    // Create UDP server to receive MPEG-TS and demux to RTP
    const tsReceiver = dgram.createSocket('udp4');
    const tsPort = rtpPort - 100; // Use a different port for TS reception
    
    tsReceiver.on('message', (msg, rinfo) => {
      // Process MPEG-TS packets and demux to separate RTP streams
      this.demuxAndForward(botId, msg, rtpPort);
    });
    
    tsReceiver.bind(tsPort, '127.0.0.1', () => {
      console.log(`📡 MUXED: TS receiver listening on port ${tsPort}`);
    });
    
    // Store receiver
    this.demuxers.set(botId, tsReceiver);
    
    // Start FFmpeg with MPEG-TS output
    const ffmpegArgs = [
      '-re', // Read at native frame rate
      '-stream_loop', '-1', // Loop video
      '-i', videoFile,
      // Video processing
      '-vf', `scale=${width}:${height},fps=${frameRate}`,
      '-c:v', 'libvpx',
      '-b:v', '1500k',
      '-maxrate', '2000k', 
      '-bufsize', '4000k',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-g', '60',
      // Audio processing
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      // MPEG-TS muxing with sync
      '-f', 'mpegts',
      '-muxrate', '3M', // Constant mux rate for consistent timing
      '-pcr_period', '20', // PCR every 20ms for good sync
      '-pat_period', '0.1', // PAT/PMT tables
      '-sdt_period', '0.5',
      // Output to UDP
      `udp://127.0.0.1:${tsPort}?pkt_size=1316`
    ];
    
    console.log(`🎬 MUXED: Starting FFmpeg with MPEG-TS output...`);
    const ffmpeg = spawn(this.ffmpegPath || 'ffmpeg', ffmpegArgs);
    
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        console.error(`❌ MUXED: FFmpeg error:`, output);
      }
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`🛑 MUXED: FFmpeg exited with code ${code}`);
      this.cleanup(botId);
    });
    
    this.activeStreams.set(botId, {
      ffmpeg,
      tsReceiver,
      tsPort,
      rtpPort,
      config
    });
    
    return {
      success: true,
      tsPort,
      rtpVideoPort: rtpPort,
      rtpAudioPort: rtpPort + 2
    };
  }
  
  /**
   * Demuxes MPEG-TS and forwards as RTP
   * In a real implementation, this would parse TS and extract elementary streams
   */
  demuxAndForward(botId, tsData, baseRtpPort) {
    // This is a simplified version - real implementation would:
    // 1. Parse MPEG-TS packets (188 bytes each)
    // 2. Extract PES packets for video and audio
    // 3. Convert to RTP with proper timestamps
    // 4. Send to MediaSoup on separate ports
    
    // For now, we'll use a different approach with FFmpeg doing the demuxing
  }
  
  /**
   * Alternative: Use FFmpeg with tee muxer for synchronized dual output
   */
  async startSyncedDualStream(botId, config, videoPort, audioPort) {
    console.log(`🎬 SYNCED: Starting synchronized dual RTP streams for ViewBot ${botId}`);
    
    const { videoFile, width = 1280, height = 720, frameRate = 30 } = config;
    
    // Use tee muxer to ensure synchronized output
    const ffmpegArgs = [
      '-re',
      '-stream_loop', '-1',
      '-i', videoFile,
      // Process both streams together
      '-filter_complex',
      `[0:v]scale=${width}:${height},fps=${frameRate},setpts=PTS-STARTPTS[vout];` +
      `[0:a]aresample=48000,asetpts=PTS-STARTPTS[aout]`,
      // Map processed streams
      '-map', '[vout]',
      '-map', '[aout]',
      // Video encoding
      '-c:v', 'libvpx',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-g', '60',
      // Audio encoding
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      // Use tee muxer for synchronized output
      '-f', 'tee',
      '-use_fifo', '1', // Use FIFO for reliability
      '-fifo_options', 'attempt_recovery=1:recovery_wait_time=1',
      // Output mapping with explicit stream selection
      `[select=\'v:0\':f=rtp:ssrc=11111111:payload_type=96]rtp://127.0.0.1:${videoPort}|` +
      `[select=\'a:0\':f=rtp:ssrc=22222222:payload_type=111]rtp://127.0.0.1:${audioPort}`
    ];
    
    console.log(`🎬 SYNCED: Starting FFmpeg with tee muxer...`);
    const ffmpeg = spawn(this.ffmpegPath || 'ffmpeg', ffmpegArgs);
    
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        console.error(`❌ SYNCED: FFmpeg error:`, output);
      } else if (output.includes('muxing overhead')) {
        console.log(`✅ SYNCED: Stream started successfully`);
      }
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`🛑 SYNCED: FFmpeg exited with code ${code}`);
    });
    
    this.activeStreams.set(botId, {
      ffmpeg,
      videoPort,
      audioPort,
      config,
      type: 'synced-dual'
    });
    
    return {
      success: true,
      videoPort,
      audioPort
    };
  }
  
  /**
   * Stops a stream
   */
  stopStream(botId) {
    const stream = this.activeStreams.get(botId);
    if (!stream) {
      return { success: false, message: 'Stream not found' };
    }
    
    // Kill FFmpeg
    if (stream.ffmpeg) {
      stream.ffmpeg.kill('SIGTERM');
    }
    
    // Close UDP receiver if exists
    if (stream.tsReceiver) {
      stream.tsReceiver.close();
    }
    
    this.activeStreams.delete(botId);
    this.demuxers.delete(botId);
    
    return { success: true };
  }
  
  /**
   * Cleanup resources
   */
  cleanup(botId) {
    const stream = this.activeStreams.get(botId);
    if (stream) {
      if (stream.tsReceiver) {
        stream.tsReceiver.close();
      }
      this.activeStreams.delete(botId);
      this.demuxers.delete(botId);
    }
  }
}

module.exports = ViewBotMuxedStreamService;