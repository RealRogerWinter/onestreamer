/**
 * Fix GStreamer to play full video files without rtpbin
 * rtpbin has known EOS propagation issues, so we'll use direct RTP
 */

const fs = require('fs');
const path = require('path');

// GStreamer implementation without rtpbin for complete playback
const NO_RTPBIN_FIX = `
  /**
   * Starts GStreamer-based video file streaming without rtpbin
   * Uses direct RTP streaming to avoid rtpbin's EOS issues
   */
  async startGStreamerVideoFileStreaming() {
    console.log(\`🎬 ViewBot \${this.botId}: Starting GStreamer-based video file streaming\`);
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    
    // Check file exists first
    if (!fs.existsSync(this.config.videoFile)) {
      throw new Error(\`Video file not found: \${this.config.videoFile}\`);
    }
    
    // Generate fixed SSRCs that will be used by both GStreamer and MediaSoup
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
      // IMPORTANT: Use forward slashes for Windows paths in GStreamer
      const videoFile = this.config.videoFile.replace(/\\\\/g, '/');
      
      // Start separate pipelines without rtpbin
      await this.startDirectRTPPipelines(videoFile, width, height, frameRate);
      
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
   * Start GStreamer pipelines without rtpbin for complete playback
   * Uses separate video and audio pipelines with direct RTP streaming
   */
  async startDirectRTPPipelines(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Video pipeline - direct RTP without rtpbin
    const videoPipeline = [
      '-e',  // Force EOS on shutdown
      '-v',  // Verbose for debugging
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin',
      '!', 'queue',
        'max-size-buffers=200',
        'max-size-time=2000000000',  // 2 seconds
        'max-size-bytes=10485760',   // 10MB
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', \`video/x-raw,width=\${width},height=\${height}\`,
      '!', 'videorate',
      '!', \`video/x-raw,framerate=\${frameRate}/1\`,
      '!', 'vp8enc',
        'deadline=1',
        'cpu-used=4',
        'error-resilient=1',
        'target-bitrate=1500000',
        'keyframe-max-dist=30',
        'threads=2',
      '!', 'rtpvp8pay',
        \`ssrc=\${this.videoSSRC}\`,
        'pt=96',
        'mtu=1200',
        'picture-id-mode=2',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.videoRtpPort}\`,
        'sync=true',   // Keep sync for proper timing
        'async=false'
    ];
    
    // Audio pipeline - direct RTP without rtpbin
    const audioPipeline = [
      '-e',  // Force EOS on shutdown
      '-v',  // Verbose for debugging
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin',
      '!', 'queue',
        'max-size-buffers=200',
        'max-size-time=2000000000',  // 2 seconds
        'max-size-bytes=10485760',   // 10MB
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc',
        'bitrate=128000',
        'frame-size=20',
      '!', 'rtpopuspay',
        \`ssrc=\${this.audioSSRC}\`,
        'pt=111',
        'mtu=1200',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.audioRtpPort}\`,
        'sync=true',   // Keep sync for proper timing
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting video pipeline (no rtpbin)\`);
    
    // Start video pipeline
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(\`🔊 ViewBot \${this.botId}: Starting audio pipeline (no rtpbin)\`);
    
    // Start audio pipeline
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let videoStarted = false;
    let audioStarted = false;
    let videoEOS = false;
    let audioEOS = false;
    let videoError = '';
    let audioError = '';
    
    // Monitor video pipeline
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        videoError = output.substring(0, 200);
        console.error(\`❌ ViewBot \${this.botId}: Video pipeline error\`);
      } else if (output.includes('PLAYING')) {
        if (!videoStarted) {
          videoStarted = true;
          console.log(\`▶️ ViewBot \${this.botId}: Video pipeline playing\`);
        }
      } else if (output.includes('EOS')) {
        videoEOS = true;
        console.log(\`🏁 ViewBot \${this.botId}: Video EOS received - complete playback!\`);
      } else if (output.includes('Setting pipeline')) {
        console.log(\`🔧 ViewBot \${this.botId}: Video pipeline initializing\`);
      } else if (output.includes('caps = video/')) {
        console.log(\`📹 ViewBot \${this.botId}: Video stream detected\`);
      }
    });
    
    // Monitor audio pipeline
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        audioError = output.substring(0, 200);
        console.error(\`❌ ViewBot \${this.botId}: Audio pipeline error\`);
      } else if (output.includes('PLAYING')) {
        if (!audioStarted) {
          audioStarted = true;
          console.log(\`▶️ ViewBot \${this.botId}: Audio pipeline playing\`);
        }
      } else if (output.includes('EOS')) {
        audioEOS = true;
        console.log(\`🏁 ViewBot \${this.botId}: Audio EOS received - complete playback!\`);
      } else if (output.includes('caps = audio/')) {
        console.log(\`🔊 ViewBot \${this.botId}: Audio stream detected\`);
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start video pipeline:\`, error);
      throw error;
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start audio pipeline:\`, error);
      // Audio failure is not critical, continue
    });
    
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: Video pipeline exited (code: \${code})\`);
      
      if (videoEOS) {
        console.log(\`   ✅ Video played to completion\`);
      } else if (code === 0) {
        console.log(\`   ✅ Video pipeline completed normally\`);
      } else if (videoError) {
        console.error(\`   ❌ Video error: \${videoError}\`);
      }
      
      this.gstreamerVideoProcess = null;
      
      // Restart if looping is enabled
      if (this.config.loop && !this.stopping && (videoEOS || code === 0)) {
        console.log(\`🔄 ViewBot \${this.botId}: Restarting video (loop enabled)\`);
        setTimeout(() => {
          if (!this.stopping) {
            this.startDirectRTPPipelines(videoFile, width, height, frameRate)
              .catch(err => console.error(\`Failed to restart:\`, err));
          }
        }, 1000);
      }
    });
    
    this.gstreamerAudioProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: Audio pipeline exited (code: \${code})\`);
      
      if (audioEOS) {
        console.log(\`   ✅ Audio played to completion\`);
      } else if (code === 0) {
        console.log(\`   ✅ Audio pipeline completed normally\`);
      } else if (audioError) {
        console.error(\`   ❌ Audio error: \${audioError}\`);
      }
      
      this.gstreamerAudioProcess = null;
    });
    
    // Wait for pipelines to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!videoStarted && !audioStarted) {
          const error = new Error('GStreamer pipelines failed to start');
          console.error(\`❌ ViewBot \${this.botId}: \${error.message}\`);
          
          if (videoError) {
            console.error(\`   Video error: \${videoError}\`);
          }
          if (audioError) {
            console.error(\`   Audio error: \${audioError}\`);
          }
          
          this.cleanupGStreamerProcesses();
          reject(error);
        } else {
          console.log(\`⚠️ ViewBot \${this.botId}: Partial start (Video: \${videoStarted}, Audio: \${audioStarted})\`);
          resolve();
        }
      }, 15000);
      
      const checkInterval = setInterval(() => {
        if (videoStarted || audioStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          console.log(\`✅ ViewBot \${this.botId}: Pipelines started (Video: \${videoStarted}, Audio: \${audioStarted})\`);
          resolve();
        }
      }, 100);
    });
  }
  
  /**
   * Clean up GStreamer processes
   */
  cleanupGStreamerProcesses() {
    this.stopping = true;
    
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Cleaning up video pipeline\`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Cleaning up audio pipeline\`);
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
    if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Cleaning up GStreamer process\`);
      this.gstreamerProcess.kill('SIGTERM');
      this.gstreamerProcess = null;
    }
  }
`;

async function applyNoRtpBinFix() {
  console.log('🔧 Applying GStreamer fix without rtpbin...');
  
  const filePath = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find the startGStreamerVideoFileStreaming method
  const methodStart = content.indexOf('async startGStreamerVideoFileStreaming()');
  if (methodStart === -1) {
    console.error('❌ Could not find startGStreamerVideoFileStreaming method');
    return;
  }
  
  // Find the end of GStreamer methods
  let methodEnd = content.indexOf('async startFFmpegVideoGeneration()', methodStart);
  if (methodEnd === -1) {
    methodEnd = content.indexOf('\n  /**\n   * Starts FFmpeg', methodStart);
  }
  if (methodEnd === -1) {
    // Try to find the next class method
    const nextMethod = content.indexOf('\n  async ', methodStart + 50);
    if (nextMethod !== -1) {
      methodEnd = nextMethod;
    }
  }
  
  // Replace the methods
  const beforeMethod = content.substring(0, methodStart);
  const afterMethod = content.substring(methodEnd);
  content = beforeMethod + NO_RTPBIN_FIX + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ GStreamer fix applied - no rtpbin!');
  console.log('\n🔑 Key improvements:');
  console.log('1. ✅ Removed rtpbin completely (known EOS issues)');
  console.log('2. ✅ Direct RTP streaming with separate pipelines');
  console.log('3. ✅ Uses forward slashes for Windows paths');
  console.log('4. ✅ Adds -e flag for proper EOS handling');
  console.log('5. ✅ Monitors EOS events for completion');
  console.log('6. ✅ Preserves sync=true for proper timing');
  console.log('7. ✅ Reasonable queue limits (not 0)');
  console.log('8. ✅ Optional loop support with EOS detection');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

applyNoRtpBinFix().catch(console.error);