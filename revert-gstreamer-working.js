/**
 * Revert to the working GStreamer implementation that was displaying video
 * Then we'll carefully fix only the sync issues
 */

const fs = require('fs');
const path = require('path');

// The implementation that was working (displaying video but with sync issues)
const WORKING_GSTREAMER_IMPLEMENTATION = `
  /**
   * Starts GStreamer-based video file streaming with MediaSoup PlainTransport
   * This version was displaying video successfully
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
      
      // Start with the simpler pipeline that was working
      await this.startGStreamerVideoPipeline(videoFile, width, height, frameRate);
      await this.startGStreamerAudioPipeline(videoFile);
      
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
  
  async startGStreamerVideoPipeline(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Use the simpler pipeline that was working
    const videoPipeline = [
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', \`video/x-raw,width=\${width},height=\${height}\`,
      '!', 'videorate',
      '!', \`video/x-raw,framerate=\${frameRate}/1\`,
      '!', 'vp8enc',
        'deadline=1',
        'cpu-used=8',
        'error-resilient=1',
        'target-bitrate=1500000',
        'keyframe-max-dist=30',
      '!', 'rtpvp8pay',
        \`ssrc=\${this.videoSSRC}\`,
        'pt=96',
        'mtu=1200',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.videoRtpPort}\`,
        'sync=false',  // Keep sync=false for now as it was working
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting GStreamer video pipeline on port \${this.videoRtpPort}\`);
    
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let videoStarted = false;
    
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer video error:\`, output);
      } else if (output.includes('PLAYING')) {
        videoStarted = true;
        console.log(\`▶️ ViewBot \${this.botId}: GStreamer video pipeline playing\`);
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer video:\`, error);
      throw error;
    });
    
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: GStreamer video exited (code: \${code})\`);
      this.gstreamerVideoProcess = null;
    });
    
    // Wait for pipeline to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!videoStarted) {
          console.warn(\`⚠️ ViewBot \${this.botId}: Video pipeline timeout, but continuing\`);
        }
        resolve();
      }, 10000);
      
      const checkInterval = setInterval(() => {
        if (videoStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
    
    console.log(\`✅ ViewBot \${this.botId}: GStreamer video pipeline started\`);
  }
  
  async startGStreamerAudioPipeline(videoFile) {
    const { spawn } = require('child_process');
    
    // Audio pipeline - keep simple for now
    const audioPipeline = [
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc',
        'bitrate=128000',
      '!', 'rtpopuspay',
        \`ssrc=\${this.audioSSRC}\`,
        'pt=111',
        'mtu=1200',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.audioRtpPort}\`,
        'sync=false',  // Keep sync=false for now
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🔊 ViewBot \${this.botId}: Starting GStreamer audio pipeline on port \${this.audioRtpPort}\`);
    
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let audioStarted = false;
    
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer audio error:\`, output);
      } else if (output.includes('PLAYING')) {
        audioStarted = true;
        console.log(\`▶️ ViewBot \${this.botId}: GStreamer audio pipeline playing\`);
      }
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer audio:\`, error);
      // Audio failure is not critical
      console.warn(\`⚠️ ViewBot \${this.botId}: Continuing without audio\`);
    });
    
    this.gstreamerAudioProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: GStreamer audio exited (code: \${code})\`);
      this.gstreamerAudioProcess = null;
    });
    
    // Wait for pipeline to start (don't fail if audio doesn't work)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!audioStarted) {
          console.warn(\`⚠️ ViewBot \${this.botId}: Audio pipeline timeout, continuing without audio\`);
        }
        resolve();
      }, 5000);
      
      const checkInterval = setInterval(() => {
        if (audioStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
    
    if (audioStarted) {
      console.log(\`✅ ViewBot \${this.botId}: GStreamer audio pipeline started\`);
    }
  }
  
  /**
   * Clean up GStreamer processes
   */
  cleanupGStreamerProcesses() {
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Cleaning up GStreamer video process\`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Cleaning up GStreamer audio process\`);
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

async function revertToWorking() {
  console.log('🔧 Reverting to working GStreamer implementation...');
  
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
  content = beforeMethod + WORKING_GSTREAMER_IMPLEMENTATION + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ Reverted to working GStreamer implementation!');
  console.log('\nThis version:');
  console.log('✅ Displays video correctly');
  console.log('✅ Uses separate video/audio pipelines');
  console.log('✅ Has sync=false (which may cause speed issues)');
  console.log('\nNext step: We\'ll carefully add sync without breaking video display');
}

revertToWorking().catch(console.error);