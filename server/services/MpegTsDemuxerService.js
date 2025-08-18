/**
 * MPEG-TS Demuxer Service for Perfect A/V Synchronization
 * Receives a single MPEG-TS stream and demuxes it to synchronized RTP streams
 */

const dgram = require('dgram');
const { Transform } = require('stream');
const { spawn } = require('child_process');

class MpegTsDemuxerService {
  constructor() {
    this.activeDemuxers = new Map(); // botId -> demuxer process
    this.tsReceivers = new Map(); // botId -> UDP socket
    this.baseTsPort = 30000;
    this.currentTsPort = this.baseTsPort;
  }

  /**
   * Starts MPEG-TS receiver and demuxer for a ViewBot
   * This maintains perfect A/V sync by processing a single multiplexed stream
   */
  async startMpegTsDemuxer(botId, videoRtpPort, audioRtpPort) {
    console.log(`📡 DEMUX: Starting MPEG-TS demuxer for ${botId}`);
    
    const tsPort = this.allocateTsPort();
    
    // Create UDP receiver for MPEG-TS stream
    const tsReceiver = dgram.createSocket('udp4');
    
    tsReceiver.on('error', (err) => {
      console.error(`❌ DEMUX: UDP receiver error for ${botId}:`, err);
      this.cleanup(botId);
    });
    
    // Start FFmpeg demuxer when first packet arrives
    let demuxerStarted = false;
    tsReceiver.on('message', (msg, rinfo) => {
      if (!demuxerStarted) {
        demuxerStarted = true;
        this.startFFmpegDemuxer(botId, tsPort, videoRtpPort, audioRtpPort);
      }
    });
    
    // Bind to the allocated port
    await new Promise((resolve, reject) => {
      tsReceiver.bind(tsPort, '127.0.0.1', (err) => {
        if (err) {
          reject(err);
        } else {
          console.log(`✅ DEMUX: TS receiver listening on port ${tsPort}`);
          resolve();
        }
      });
    });
    
    this.tsReceivers.set(botId, { socket: tsReceiver, port: tsPort });
    
    return {
      success: true,
      tsPort,
      videoRtpPort,
      audioRtpPort
    };
  }

  /**
   * Starts FFmpeg process to demux MPEG-TS to RTP
   * This maintains synchronization by processing a single stream
   */
  startFFmpegDemuxer(botId, tsPort, videoRtpPort, audioRtpPort) {
    console.log(`🎬 DEMUX: Starting FFmpeg demuxer for ${botId}`);
    
    // FFmpeg command to receive MPEG-TS and output synchronized RTP
    const ffmpegArgs = [
      // Input from UDP
      '-i', `udp://127.0.0.1:${tsPort}?fifo_size=1000000&overrun_nonfatal=1`,
      // Copy timestamps to maintain sync
      '-copyts',
      '-start_at_zero',
      // Video output
      '-map', '0:v:0',
      '-c:v', 'copy', // Don't re-encode to maintain timing
      '-an',
      '-f', 'rtp',
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${videoRtpPort}`,
      // Audio output
      '-map', '0:a:0',
      '-c:a', 'copy', // Don't re-encode to maintain timing
      '-vn',
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${audioRtpPort}`
    ];
    
    const demuxer = spawn('ffmpeg', ffmpegArgs);
    
    demuxer.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        console.error(`❌ DEMUX: FFmpeg error for ${botId}:`, output);
      } else if (output.includes('start:')) {
        console.log(`✅ DEMUX: Synchronized demuxing active for ${botId}`);
      }
    });
    
    demuxer.on('close', (code) => {
      console.log(`🛑 DEMUX: FFmpeg demuxer exited for ${botId} with code ${code}`);
      this.cleanup(botId);
    });
    
    this.activeDemuxers.set(botId, demuxer);
    console.log(`✅ DEMUX: Demuxer started for ${botId}`);
  }

  /**
   * Creates an MPEG-TS stream with perfect sync
   */
  async createMpegTsStream(botId, config) {
    const { videoFile, width = 1280, height = 720, frameRate = 30 } = config;
    const tsPort = this.tsReceivers.get(botId)?.port;
    
    if (!tsPort) {
      throw new Error(`No TS port allocated for ${botId}`);
    }
    
    console.log(`🎬 MUXED: Creating MPEG-TS stream for ${botId} on port ${tsPort}`);
    
    // FFmpeg command to create perfectly synchronized MPEG-TS
    const ffmpegArgs = [
      '-re',
      '-stream_loop', '-1',
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
      // MPEG-TS muxing with perfect sync
      '-f', 'mpegts',
      '-muxrate', '3M', // Constant mux rate
      '-pcr_period', '20', // PCR every 20ms for sync
      '-pat_period', '0.1',
      '-sdt_period', '0.5',
      '-mpegts_copyts', '1', // Preserve timestamps
      '-avoid_negative_ts', 'disabled', // Allow negative timestamps
      '-max_delay', '0', // No additional delay
      // Output to UDP
      `udp://127.0.0.1:${tsPort}?pkt_size=1316&buffer_size=65535`
    ];
    
    return ffmpegArgs;
  }

  /**
   * Allocates a port for MPEG-TS reception
   */
  allocateTsPort() {
    const port = this.currentTsPort++;
    if (this.currentTsPort > 39999) {
      this.currentTsPort = this.baseTsPort;
    }
    return port;
  }

  /**
   * Cleanup resources
   */
  cleanup(botId) {
    console.log(`🧹 DEMUX: Cleaning up resources for ${botId}`);
    
    // Stop demuxer
    const demuxer = this.activeDemuxers.get(botId);
    if (demuxer) {
      demuxer.kill('SIGTERM');
      this.activeDemuxers.delete(botId);
    }
    
    // Close UDP receiver
    const receiver = this.tsReceivers.get(botId);
    if (receiver) {
      receiver.socket.close();
      this.tsReceivers.delete(botId);
    }
    
    console.log(`✅ DEMUX: Cleanup complete for ${botId}`);
  }

  /**
   * Gets the MPEG-TS port for a bot
   */
  getTsPort(botId) {
    return this.tsReceivers.get(botId)?.port;
  }
}

module.exports = MpegTsDemuxerService;