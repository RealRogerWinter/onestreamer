/**
 * Fix GStreamer to MediaSoup integration
 * Ensures proper RTP flow from GStreamer to MediaSoup PlainTransport
 */

const fs = require('fs');
const path = require('path');

// Updated GStreamer implementation with proper MediaSoup integration
const MEDIASOUP_GSTREAMER_FIX = `
  /**
   * Starts GStreamer-based video file streaming with MediaSoup PlainTransport
   * Uses proper RTP configuration for MediaSoup compatibility
   */
  async startGStreamerVideoFileStreaming() {
    console.log(\`🎬 ViewBot \${this.botId}: Starting GStreamer-based video file streaming\`);
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    
    // Check file exists first
    if (!fs.existsSync(this.config.videoFile)) {
      throw new Error(\`Video file not found: \${this.config.videoFile}\`);
    }
    
    // IMPORTANT: Generate fixed SSRCs that will be used by both GStreamer and MediaSoup
    const videoSSRC = 11111111;
    const audioSSRC = 22222222;
    
    // Create RTP parameters with the EXACT SSRCs we'll use
    const videoRtpParams = {
      codecs: [{
        mimeType: 'video/VP8',
        payloadType: 96,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' }
        ]
      }],
      encodings: [{
        ssrc: videoSSRC
      }]
    };
    
    const audioRtpParams = {
      codecs: [{
        mimeType: 'audio/opus',
        payloadType: 111,
        clockRate: 48000,
        channels: 2,
        parameters: {
          'minptime': '10',
          'useinbandfec': '1'
        },
        rtcpFeedback: []
      }],
      encodings: [{
        ssrc: audioSSRC
      }]
    };
    
    // Create MediaSoup producers using socket events
    console.log(\`📡 ViewBot \${this.botId}: Creating MediaSoup PlainTransport producers...\`);
    
    // Store SSRCs for use in GStreamer
    this.videoSSRC = videoSSRC;
    this.audioSSRC = audioSSRC;
    
    await Promise.all([
      this.createWebRTCProducer('video', videoRtpParams),
      this.createWebRTCProducer('audio', audioRtpParams)
    ]);
    
    // Wait for transports to be ready
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      throw new Error('Failed to get RTP ports from server');
    }
    
    console.log(\`✅ ViewBot \${this.botId}: MediaSoup PlainTransport ready\`);
    console.log(\`   Video: RTP port \${this.videoRtpPort}, SSRC \${videoSSRC}\`);
    console.log(\`   Audio: RTP port \${this.audioRtpPort}, SSRC \${audioSSRC}\`);
    
    try {
      const videoFile = this.config.videoFile.replace(/\\\\/g, '/');
      
      // Start GStreamer with proper RTP configuration
      await this.startGStreamerPipelineWithRTPBin(videoFile, width, height, frameRate);
      
      // Mark as using GStreamer
      this.useGStreamer = true;
      
      console.log(\`✅ ViewBot \${this.botId}: GStreamer streaming started successfully\`);
      
    } catch (error) {
      console.error(\`❌ ViewBot \${this.botId}: GStreamer launch failed:\`, error.message);
      
      // Clean up any started processes
      this.cleanupGStreamerProcesses();
      
      // Fallback to FFmpeg if GStreamer fails
      console.log(\`⚠️ ViewBot \${this.botId}: Falling back to FFmpeg method\`);
      this.config.useGStreamer = false;
      
      if (typeof this.startFFmpegVideoFileStreaming === 'function') {
        await this.startFFmpegVideoFileStreaming();
      } else {
        throw new Error('FFmpeg fallback not available');
      }
    }
  }
  
  /**
   * Start GStreamer with rtpbin for proper RTP handling
   * This matches the MediaSoup demo configuration
   */
  async startGStreamerPipelineWithRTPBin(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Build combined pipeline with rtpbin for proper RTP handling
    // Using a single pipeline for both audio and video ensures sync
    const pipeline = [
      // RTP bin for managing RTP sessions
      'rtpbin', 'name=rtpbin',
      
      // File source and demuxer
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin', 'name=dec',
      
      // Video branch
      'dec.',
      '!', 'queue',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', \`video/x-raw,width=\${width},height=\${height}\`,
      '!', 'videorate',
      '!', \`video/x-raw,framerate=\${frameRate}/1\`,
      '!', 'vp8enc',
        'target-bitrate=1500000',  // 1.5 Mbps
        'deadline=1',               // Real-time encoding
        'cpu-used=4',              // Balance between speed and quality
        'error-resilient=1',       // Error resilience for network issues
        'keyframe-max-dist=60',    // Keyframe every 2 seconds at 30fps
      '!', 'rtpvp8pay',
        'pt=96',
        \`ssrc=\${this.videoSSRC}\`,
        'picture-id-mode=2',       // Enable picture ID for better error recovery
      '!', 'rtpbin.send_rtp_sink_0',
      
      // Video RTP output
      'rtpbin.send_rtp_src_0',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.videoRtpPort}\`,
        'sync=false',
        'async=false',
      
      // Audio branch
      'dec.',
      '!', 'queue',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc',
        'bitrate=128000',
        'frame-size=20',
      '!', 'rtpopuspay',
        'pt=111',
        \`ssrc=\${this.audioSSRC}\`,
      '!', 'rtpbin.send_rtp_sink_1',
      
      // Audio RTP output
      'rtpbin.send_rtp_src_1',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.audioRtpPort}\`,
        'sync=false',
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🚀 ViewBot \${this.botId}: Launching GStreamer with rtpbin\`);
    console.log(\`   Video: port=\${this.videoRtpPort}, ssrc=\${this.videoSSRC}\`);
    console.log(\`   Audio: port=\${this.audioRtpPort}, ssrc=\${this.audioSSRC}\`);
    
    this.gstreamerProcess = spawn(gstreamerPath, pipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let pipelineStarted = false;
    let errorBuffer = '';
    
    // Monitor pipeline output
    this.gstreamerProcess.stderr.on('data', (data) => {
      const output = data.toString();
      errorBuffer += output;
      
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer error:\`, output);
      } else if (output.includes('WARNING') && output.includes('No decoder available')) {
        console.error(\`❌ ViewBot \${this.botId}: Missing codec support:\`, output);
      } else if (output.includes('Setting pipeline to PLAYING')) {
        console.log(\`🎬 ViewBot \${this.botId}: Pipeline starting...\`);
      } else if (output.includes('Pipeline is PREROLLED')) {
        console.log(\`📺 ViewBot \${this.botId}: Pipeline prerolled and ready\`);
        pipelineStarted = true;
      } else if (output.includes('PLAYING')) {
        console.log(\`▶️ ViewBot \${this.botId}: Pipeline is playing\`);
        pipelineStarted = true;
      }
    });
    
    this.gstreamerProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer:\`, error);
      throw error;
    });
    
    this.gstreamerProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: GStreamer exited (code: \${code}, signal: \${signal})\`);
      if (code !== 0 && errorBuffer) {
        console.error(\`   Last errors:\`, errorBuffer.slice(-1000));
      }
      this.gstreamerProcess = null;
    });
    
    // Wait for pipeline to start
    await new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        if (!pipelineStarted) {
          const error = new Error('GStreamer pipeline failed to start within 15 seconds');
          console.error(\`❌ ViewBot \${this.botId}: \${error.message}\`);
          if (errorBuffer) {
            console.error(\`   Pipeline output:\`, errorBuffer.slice(-2000));
          }
          this.cleanupGStreamerProcesses();
          reject(error);
        } else {
          resolve();
        }
      }, 15000); // 15 second timeout for large files
      
      // Check periodically if pipeline started
      const checkInterval = setInterval(() => {
        if (pipelineStarted) {
          clearTimeout(startTimeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
    
    console.log(\`✅ ViewBot \${this.botId}: GStreamer pipeline started successfully\`);
  }
  
  /**
   * Clean up GStreamer processes
   */
  cleanupGStreamerProcesses() {
    if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Cleaning up GStreamer process\`);
      this.gstreamerProcess.kill('SIGTERM');
      this.gstreamerProcess = null;
    }
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
  }
`;

// Also update the cleanup section in the disconnect handler
const CLEANUP_UPDATE = `
    // Clean up GStreamer processes if they exist
    this.cleanupGStreamerProcesses();
`;

async function applyMediaSoupFix() {
  console.log('🔧 Applying GStreamer-MediaSoup integration fix...');
  
  const filePath = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find and replace the startGStreamerVideoFileStreaming method
  const methodStart = content.indexOf('async startGStreamerVideoFileStreaming()');
  if (methodStart === -1) {
    console.error('❌ Could not find startGStreamerVideoFileStreaming method');
    return;
  }
  
  // Find the next method after all GStreamer-related methods
  let methodEnd = content.indexOf('async startFFmpegVideoGeneration()', methodStart);
  if (methodEnd === -1) {
    // Try to find another method boundary
    methodEnd = content.indexOf('\n  /**\n   * Starts FFmpeg', methodStart);
  }
  if (methodEnd === -1) {
    console.error('❌ Could not find method boundary');
    return;
  }
  
  // Replace the GStreamer methods
  const beforeMethod = content.substring(0, methodStart);
  const afterMethod = content.substring(methodEnd);
  content = beforeMethod + MEDIASOUP_GSTREAMER_FIX + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ GStreamer-MediaSoup integration fixed!');
  console.log('\n🔑 Key improvements:');
  console.log('1. ✅ Using rtpbin for proper RTP session management');
  console.log('2. ✅ Fixed SSRC values (11111111 for video, 22222222 for audio)');
  console.log('3. ✅ Single pipeline for audio/video synchronization');
  console.log('4. ✅ VP8 encoding with MediaSoup-compatible settings');
  console.log('5. ✅ Picture ID mode enabled for better error recovery');
  console.log('6. ✅ Proper payload types (96 for VP8, 111 for Opus)');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

applyMediaSoupFix().catch(console.error);