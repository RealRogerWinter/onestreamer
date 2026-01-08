/**
 * Carefully fix GStreamer sync without breaking video display
 * The key is to use proper clock and timestamp handling
 */

const fs = require('fs');
const path = require('path');

// Modified GStreamer implementation with careful sync fix
const CAREFUL_SYNC_FIX = `
  /**
   * Starts GStreamer-based video file streaming with proper sync
   * Uses sync=false but with proper timestamps and rate control
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
      
      // Start pipelines with proper timing control
      await this.startTimedGStreamerPipelines(videoFile, width, height, frameRate);
      
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
   * Start GStreamer pipelines with proper timing control
   * Uses videorate and audiorate to control playback speed
   */
  async startTimedGStreamerPipelines(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Video pipeline with timing control
    const videoPipeline = [
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin',
      '!', 'queue',
        'max-size-buffers=200',
        'max-size-time=2000000000', // 2 seconds
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', \`video/x-raw,width=\${width},height=\${height}\`,
      '!', 'videorate',
        'drop-only=false',
        'average-period=0',
        'max-rate=' + frameRate,
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
        'sync=false',   // Keep false but control rate with videorate
        'async=false'
    ];
    
    // Audio pipeline with timing control
    const audioPipeline = [
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin',
      '!', 'queue',
        'max-size-buffers=200',
        'max-size-time=2000000000', // 2 seconds
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audiorate',  // Add audiorate for timing control
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
        'sync=false',   // Keep false but control rate with audiorate
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting video pipeline with rate control\`);
    
    // Start video pipeline
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(\`🔊 ViewBot \${this.botId}: Starting audio pipeline with rate control\`);
    
    // Start audio pipeline
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let videoStarted = false;
    let audioStarted = false;
    
    // Monitor video pipeline
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer video error:\`, output.substring(0, 300));
      } else if (output.includes('PLAYING')) {
        videoStarted = true;
        console.log(\`▶️ ViewBot \${this.botId}: Video pipeline playing\`);
      } else if (output.includes('Setting pipeline')) {
        console.log(\`🔧 ViewBot \${this.botId}: Video pipeline initializing\`);
      }
    });
    
    // Monitor audio pipeline
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer audio error:\`, output.substring(0, 300));
      } else if (output.includes('PLAYING')) {
        audioStarted = true;
        console.log(\`▶️ ViewBot \${this.botId}: Audio pipeline playing\`);
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer video:\`, error);
      throw error;
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer audio:\`, error);
      // Audio failure is not critical
      console.warn(\`⚠️ ViewBot \${this.botId}: Continuing without audio\`);
    });
    
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: Video pipeline exited (code: \${code})\`);
      this.gstreamerVideoProcess = null;
    });
    
    this.gstreamerAudioProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: Audio pipeline exited (code: \${code})\`);
      this.gstreamerAudioProcess = null;
    });
    
    // Wait for pipelines to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!videoStarted && !audioStarted) {
          reject(new Error('GStreamer pipelines failed to start'));
        } else {
          console.log(\`⚠️ ViewBot \${this.botId}: Partial start (Video: \${videoStarted}, Audio: \${audioStarted})\`);
          resolve();
        }
      }, 15000);
      
      const checkInterval = setInterval(() => {
        if (videoStarted || audioStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
    
    console.log(\`✅ ViewBot \${this.botId}: Pipelines started with rate control\`);
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

async function applyCarefulFix() {
  console.log('🔧 Applying careful GStreamer sync fix...');
  
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
  content = beforeMethod + CAREFUL_SYNC_FIX + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ Careful sync fix applied!');
  console.log('\n🔑 Key improvements:');
  console.log('1. ✅ Keeps sync=false to maintain video display');
  console.log('2. ✅ Uses videorate/audiorate for timing control');
  console.log('3. ✅ Adds queue buffers for smooth playback');
  console.log('4. ✅ Controls frame rate with max-rate parameter');
  console.log('5. ✅ Separate pipelines for stability');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

applyCarefulFix().catch(console.error);