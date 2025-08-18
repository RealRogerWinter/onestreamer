const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * ViewBotGStreamerService - Properly integrated GStreamer streaming for ViewBots
 * Handles video file streaming to MediaSoup using correct RTP/RTCP configuration
 */
class ViewBotGStreamerService {
  constructor() {
    this.gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
    this.activeStreams = new Map();
  }

  /**
   * Create a properly configured GStreamer pipeline for MediaSoup
   */
  async createStreamPipeline(config) {
    const {
      videoFile,
      videoRtpPort,
      videoRtcpPort,
      audioRtpPort,
      audioRtcpPort,
      width = 1280,
      height = 720,
      frameRate = 30,
      videoBitrate = 1500000,
      audioBitrate = 128000
    } = config;

    if (!fs.existsSync(videoFile)) {
      throw new Error(`Video file not found: ${videoFile}`);
    }

    // Normalize path for GStreamer
    const normalizedPath = videoFile.replace(/\\/g, '/');

    // Build robust pipeline with proper error handling
    const pipeline = this.buildPipeline({
      source: normalizedPath,
      width,
      height,
      frameRate,
      videoBitrate,
      audioBitrate,
      videoRtpPort,
      videoRtcpPort,
      audioRtpPort,
      audioRtcpPort
    });

    return pipeline;
  }

  /**
   * Build GStreamer pipeline with proper MediaSoup integration
   */
  buildPipeline(params) {
    const {
      source,
      width,
      height,
      frameRate,
      videoBitrate,
      audioBitrate,
      videoRtpPort,
      videoRtcpPort,
      audioRtpPort,
      audioRtcpPort
    } = params;

    // Use uridecodebin for better format support and automatic pad handling
    const pipeline = [
      // Source with automatic decoding
      `uridecodebin uri=file:///${source} name=decoder`,
      
      // Video processing branch
      'decoder.',
      '! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0',
      '! videoconvert',
      '! videoscale',
      `! video/x-raw,width=${width},height=${height}`,
      '! videorate',
      `! video/x-raw,framerate=${frameRate}/1`,
      
      // VP8 encoding with optimized settings for real-time streaming
      '! vp8enc',
        'deadline=1',           // Real-time encoding
        'cpu-used=8',          // Fastest encoding
        'error-resilient=1',   // Error resilience for network issues
        `target-bitrate=${videoBitrate}`,
        'keyframe-max-dist=30', // Regular keyframes
        'threads=4',           // Multi-threading
      
      // RTP payloading with dynamic SSRC
      `! rtpvp8pay ssrc=${this.generateSSRC()} pt=96 mtu=1200`,
      
      // UDP sink with RTCP support
      '! udpsink',
        'host=127.0.0.1',
        `port=${videoRtpPort}`,
        'sync=false',
        'async=false',
      
      // Audio processing branch
      'decoder.',
      '! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0',
      '! audioconvert',
      '! audioresample',
      '! audio/x-raw,rate=48000,channels=2,format=S16LE',
      
      // Opus encoding
      '! opusenc',
        `bitrate=${audioBitrate}`,
        'frame-size=20',
        'complexity=0',        // Low complexity for performance
      
      // RTP payloading
      `! rtpopuspay ssrc=${this.generateSSRC()} pt=111 mtu=1200`,
      
      // UDP sink
      '! udpsink',
        'host=127.0.0.1',
        `port=${audioRtpPort}`,
        'sync=false',
        'async=false'
    ];

    return pipeline.join(' ');
  }

  /**
   * Start GStreamer stream with proper error handling
   */
  async startStream(botId, config) {
    try {
      const pipeline = await this.createStreamPipeline(config);
      
      console.log(`🎬 ViewBot ${botId}: Starting GStreamer stream`);
      console.log(`   Video: RTP=${config.videoRtpPort} RTCP=${config.videoRtcpPort}`);
      console.log(`   Audio: RTP=${config.audioRtpPort} RTCP=${config.audioRtcpPort}`);

      // Check GStreamer availability
      if (!fs.existsSync(this.gstreamerPath)) {
        throw new Error('GStreamer not found. Please install GStreamer 1.x');
      }

      // Start GStreamer process
      const gstProcess = spawn(this.gstreamerPath, [
        '-e',           // Enable EOS handling
        '-v',           // Verbose output for debugging
        pipeline
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Track the stream
      this.activeStreams.set(botId, {
        process: gstProcess,
        config,
        startTime: Date.now()
      });

      // Handle process output
      this.setupProcessHandlers(botId, gstProcess);

      // Wait for pipeline to initialize
      await this.waitForPipelineReady(gstProcess);

      return {
        success: true,
        message: 'GStreamer stream started successfully'
      };

    } catch (error) {
      console.error(`❌ ViewBot ${botId}: Failed to start GStreamer:`, error);
      throw error;
    }
  }

  /**
   * Setup process event handlers
   */
  setupProcessHandlers(botId, process) {
    let errorBuffer = '';
    let lastProgressTime = Date.now();

    process.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Collect errors
      if (output.includes('ERROR')) {
        errorBuffer += output;
        console.error(`❌ ViewBot ${botId}: GStreamer error:`, output);
      }
      
      // Track pipeline state changes
      if (output.includes('PLAYING')) {
        console.log(`▶️ ViewBot ${botId}: Pipeline is playing`);
      } else if (output.includes('PAUSED')) {
        console.log(`⏸️ ViewBot ${botId}: Pipeline is paused`);
      } else if (output.includes('EOS')) {
        console.log(`🏁 ViewBot ${botId}: End of stream reached`);
      }
      
      // Progress tracking
      const now = Date.now();
      if (now - lastProgressTime > 5000) {
        if (output.includes('running_time')) {
          console.log(`📊 ViewBot ${botId}: Stream active`);
          lastProgressTime = now;
        }
      }
    });

    process.on('close', (code) => {
      console.log(`🛑 ViewBot ${botId}: GStreamer process exited with code ${code}`);
      
      if (code !== 0 && errorBuffer) {
        console.error(`❌ ViewBot ${botId}: Process failed with errors:`, errorBuffer);
      }
      
      this.activeStreams.delete(botId);
    });

    process.on('error', (error) => {
      console.error(`❌ ViewBot ${botId}: Process error:`, error);
      this.activeStreams.delete(botId);
    });
  }

  /**
   * Wait for pipeline to be ready
   */
  async waitForPipelineReady(process) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Pipeline initialization timeout'));
      }, 10000);

      const checkReady = (data) => {
        const output = data.toString();
        if (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED')) {
          clearTimeout(timeout);
          process.stderr.removeListener('data', checkReady);
          resolve();
        }
      };

      process.stderr.on('data', checkReady);
    });
  }

  /**
   * Stop a stream
   */
  async stopStream(botId) {
    const stream = this.activeStreams.get(botId);
    
    if (!stream) {
      return { success: false, message: 'Stream not found' };
    }

    try {
      // Send EOS signal for graceful shutdown
      stream.process.stdin.write('q');
      
      // Wait briefly for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Force kill if still running
      if (!stream.process.killed) {
        stream.process.kill('SIGTERM');
      }
      
      this.activeStreams.delete(botId);
      
      console.log(`✅ ViewBot ${botId}: Stream stopped`);
      return { success: true, message: 'Stream stopped successfully' };
      
    } catch (error) {
      console.error(`❌ ViewBot ${botId}: Error stopping stream:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Stop all active streams
   */
  async stopAll() {
    console.log(`🛑 Stopping all GStreamer streams (${this.activeStreams.size} active)`);
    
    const stopPromises = [];
    for (const [botId, stream] of this.activeStreams) {
      stopPromises.push(this.stopStream(botId));
    }
    
    // Wait for all streams to stop
    const results = await Promise.allSettled(stopPromises);
    
    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Failed to stop stream: ${result.reason}`);
      }
    });
    
    // Force cleanup any remaining streams
    for (const [botId, stream] of this.activeStreams) {
      if (stream.process && !stream.process.killed) {
        console.log(`Force killing GStreamer process for bot ${botId}`);
        stream.process.kill('SIGKILL');
      }
    }
    
    this.activeStreams.clear();
    console.log('✅ All GStreamer streams stopped');
  }

  /**
   * Generate random SSRC for RTP
   */
  generateSSRC() {
    return Math.floor(Math.random() * 0xFFFFFFFF);
  }

  /**
   * Get stream status
   */
  getStreamStatus(botId) {
    const stream = this.activeStreams.get(botId);
    
    if (!stream) {
      return null;
    }

    return {
      active: true,
      uptime: Date.now() - stream.startTime,
      config: stream.config,
      processRunning: !stream.process.killed
    };
  }

  /**
   * Test GStreamer installation
   */
  async testGStreamer() {
    try {
      const result = await new Promise((resolve, reject) => {
        const testProcess = spawn(this.gstreamerPath, ['--version'], {
          windowsHide: true,
          timeout: 5000
        });

        let output = '';
        testProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        testProcess.on('close', (code) => {
          if (code === 0) {
            resolve(output);
          } else {
            reject(new Error('GStreamer test failed'));
          }
        });

        testProcess.on('error', reject);
      });

      console.log('✅ GStreamer test successful:', result.split('\n')[0]);
      return true;
      
    } catch (error) {
      console.error('❌ GStreamer test failed:', error);
      return false;
    }
  }

  /**
   * Create test pattern stream for debugging
   */
  createTestPatternPipeline(config) {
    const {
      videoRtpPort,
      audioRtpPort,
      width = 1280,
      height = 720,
      frameRate = 30
    } = config;

    return [
      // Video test source
      'videotestsrc pattern=smpte',
      `! video/x-raw,width=${width},height=${height},framerate=${frameRate}/1`,
      '! vp8enc deadline=1 cpu-used=8',
      `! rtpvp8pay ssrc=${this.generateSSRC()} pt=96`,
      `! udpsink host=127.0.0.1 port=${videoRtpPort} sync=false async=false`,
      
      // Audio test source
      'audiotestsrc wave=sine freq=440',
      '! audio/x-raw,rate=48000,channels=2',
      '! opusenc',
      `! rtpopuspay ssrc=${this.generateSSRC()} pt=111`,
      `! udpsink host=127.0.0.1 port=${audioRtpPort} sync=false async=false`
    ].join(' ');
  }
}

module.exports = ViewBotGStreamerService;