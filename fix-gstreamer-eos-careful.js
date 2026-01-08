/**
 * Careful fix for GStreamer complete playback
 * Addresses early stopping without breaking the pipeline
 */

const fs = require('fs');
const path = require('path');

// GStreamer implementation with careful EOS handling
const CAREFUL_EOS_FIX = `
  /**
   * Starts GStreamer-based video file streaming with complete playback
   * Uses rtpbin with careful adjustments for full file playback
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
      const videoFile = this.config.videoFile.replace(/\\\\/g, '/');
      
      // Start GStreamer with careful EOS handling
      await this.startCarefulEOSPipeline(videoFile, width, height, frameRate);
      
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
   * Start GStreamer pipeline with careful configuration for complete playback
   * Key changes:
   * 1. Uses small non-zero queue limits instead of 0
   * 2. Adds -e flag for proper EOS handling
   * 3. Uses queue2 for better buffering
   */
  async startCarefulEOSPipeline(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Single pipeline with rtpbin - carefully configured
    const pipeline = [
      // RTP bin for managing RTP sessions
      'rtpbin', 'name=rtpbin', 'latency=0',
      
      // File source and demuxer
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin', 'name=decoder',
      
      // Video branch with queue2 for better buffering
      'decoder.',
      '!', 'queue2',
        'use-buffering=true',           // Enable buffering
        'max-size-buffers=0',           // No buffer limit
        'max-size-bytes=0',             // No byte limit  
        'max-size-time=10000000000',    // 10 seconds buffer
        'low-watermark=0.01',           // Low watermark 1%
        'high-watermark=0.99',          // High watermark 99%
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
      '!', 'rtpvp8pay',
        \`ssrc=\${this.videoSSRC}\`,
        'pt=96',
        'picture-id-mode=2',
        'mtu=1200',
      '!', 'rtpbin.send_rtp_sink_0',
      
      // Video RTP output
      'rtpbin.send_rtp_src_0',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.videoRtpPort}\`,
        // Default sync=true
        
      // Audio branch with queue2
      'decoder.',
      '!', 'queue2',
        'use-buffering=true',
        'max-size-buffers=0',
        'max-size-bytes=0',
        'max-size-time=10000000000',    // 10 seconds buffer
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
      '!', 'rtpbin.send_rtp_sink_1',
      
      // Audio RTP output
      'rtpbin.send_rtp_src_1',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.audioRtpPort}\`
        // Default sync=true
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🚀 ViewBot \${this.botId}: Launching GStreamer with careful EOS handling\`);
    console.log(\`   Video: port=\${this.videoRtpPort}, ssrc=\${this.videoSSRC}\`);
    console.log(\`   Audio: port=\${this.audioRtpPort}, ssrc=\${this.audioSSRC}\`);
    console.log(\`   Using queue2 with buffering for complete playback\`);
    
    // Use -e flag for proper EOS handling
    this.gstreamerProcess = spawn(gstreamerPath, ['-e', ...pipeline], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let pipelineStarted = false;
    let hasVideo = false;
    let hasAudio = false;
    let buffering = false;
    let eosReceived = false;
    let errorBuffer = '';
    
    // Monitor pipeline output
    this.gstreamerProcess.stderr.on('data', (data) => {
      const output = data.toString();
      errorBuffer += output;
      
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer error:\`, output.substring(0, 300));
      } else if (output.includes('WARNING') && output.includes('No decoder available')) {
        console.error(\`❌ ViewBot \${this.botId}: Missing codec support\`);
      } else if (output.includes('Buffering')) {
        buffering = true;
        const match = output.match(/Buffering, (\\d+)%/);
        if (match) {
          console.log(\`⏳ ViewBot \${this.botId}: Buffering \${match[1]}%\`);
        }
      } else if (output.includes('caps = video/')) {
        hasVideo = true;
        console.log(\`📹 ViewBot \${this.botId}: Video stream detected\`);
      } else if (output.includes('caps = audio/')) {
        hasAudio = true;
        console.log(\`🔊 ViewBot \${this.botId}: Audio stream detected\`);
      } else if (output.includes('Pipeline is PREROLLED')) {
        console.log(\`📺 ViewBot \${this.botId}: Pipeline prerolled and ready\`);
        pipelineStarted = true;
      } else if (output.includes('PLAYING')) {
        console.log(\`▶️ ViewBot \${this.botId}: Pipeline is playing\`);
        pipelineStarted = true;
        buffering = false;
      } else if (output.includes('EOS on shutdown enabled')) {
        console.log(\`🔚 ViewBot \${this.botId}: EOS handling enabled\`);
      } else if (output.includes('EOS')) {
        eosReceived = true;
        console.log(\`🏁 ViewBot \${this.botId}: End of stream reached\`);
      }
    });
    
    this.gstreamerProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer:\`, error);
      throw error;
    });
    
    this.gstreamerProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: GStreamer exited (code: \${code}, signal: \${signal})\`);
      
      if (eosReceived || code === 0) {
        console.log(\`   ✅ Video played to completion\`);
      } else if (code !== 0 && errorBuffer) {
        console.error(\`   Last errors:\`, errorBuffer.slice(-500));
      }
      
      this.gstreamerProcess = null;
    });
    
    // Wait for pipeline to start
    await new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        if (!pipelineStarted && !buffering) {
          const error = new Error('GStreamer pipeline failed to start within 30 seconds');
          console.error(\`❌ ViewBot \${this.botId}: \${error.message}\`);
          console.log(\`   Has video: \${hasVideo}, Has audio: \${hasAudio}\`);
          if (errorBuffer) {
            console.error(\`   Pipeline output:\`, errorBuffer.slice(-1000));
          }
          this.cleanupGStreamerProcesses();
          reject(error);
        } else if (buffering) {
          console.log(\`⏳ ViewBot \${this.botId}: Still buffering, extending timeout...\`);
          // Extend timeout if buffering
          setTimeout(resolve, 10000);
        } else {
          resolve();
        }
      }, 30000); // 30 second timeout
      
      // Check periodically if pipeline started
      const checkInterval = setInterval(() => {
        if (pipelineStarted) {
          clearTimeout(startTimeout);
          clearInterval(checkInterval);
          console.log(\`✅ ViewBot \${this.botId}: Pipeline started (Video: \${hasVideo}, Audio: \${hasAudio})\`);
          resolve();
        }
      }, 100);
    });
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

async function applyCarefulEOSFix() {
  console.log('🔧 Applying careful GStreamer EOS fix...');
  
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
  content = beforeMethod + CAREFUL_EOS_FIX + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ Careful GStreamer EOS fix applied!');
  console.log('\n🔑 Key improvements:');
  console.log('1. ✅ Uses queue2 with buffering instead of queue');
  console.log('2. ✅ Sets max-size-time=10000000000 (10 seconds) instead of 0');
  console.log('3. ✅ Adds -e flag for proper EOS handling');
  console.log('4. ✅ Enables use-buffering=true for smoother playback');
  console.log('5. ✅ Preserves sync=true (default) for proper timing');
  console.log('6. ✅ Monitors buffering progress');
  console.log('7. ✅ Extends timeout when buffering');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

applyCarefulEOSFix().catch(console.error);