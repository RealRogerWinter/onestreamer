/**
 * Fix GStreamer to play full video files without stopping early
 */

const fs = require('fs');
const path = require('path');

// Fixed GStreamer implementation for full video playback
const GSTREAMER_FULL_PLAYBACK_FIX = `
  /**
   * Starts GStreamer-based video file streaming with full playback
   */
  async startGStreamerVideoFileStreaming() {
    console.log(\`🎬 ViewBot \${this.botId}: Starting GStreamer-based video file streaming\`);
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    
    // Check file exists first
    if (!fs.existsSync(this.config.videoFile)) {
      throw new Error(\`Video file not found: \${this.config.videoFile}\`);
    }
    
    // Generate fixed SSRCs for MediaSoup
    const videoSSRC = 11111111;
    const audioSSRC = 22222222;
    
    // Create RTP parameters
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
          'useinbandfec': '1',
          'sprop-stereo': '1',
          'stereo': '1'
        },
        rtcpFeedback: []
      }],
      encodings: [{
        ssrc: audioSSRC
      }]
    };
    
    // Create MediaSoup producers
    console.log(\`📡 ViewBot \${this.botId}: Creating MediaSoup PlainTransport producers...\`);
    
    this.videoSSRC = videoSSRC;
    this.audioSSRC = audioSSRC;
    
    await Promise.all([
      this.createWebRTCProducer('video', videoRtpParams),
      this.createWebRTCProducer('audio', audioRtpParams)
    ]);
    
    // Wait for transports to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      throw new Error('Failed to get RTP ports from server');
    }
    
    console.log(\`✅ ViewBot \${this.botId}: MediaSoup PlainTransport ready\`);
    console.log(\`   Video: RTP port \${this.videoRtpPort}, SSRC \${videoSSRC}\`);
    console.log(\`   Audio: RTP port \${this.audioRtpPort}, SSRC \${audioSSRC}\`);
    
    try {
      const videoFile = this.config.videoFile.replace(/\\\\/g, '/');
      
      // Start GStreamer pipeline for full playback
      await this.startFullPlaybackGStreamerPipeline(videoFile, width, height, frameRate);
      
      this.useGStreamer = true;
      
      console.log(\`✅ ViewBot \${this.botId}: GStreamer streaming started for full playback\`);
      
    } catch (error) {
      console.error(\`❌ ViewBot \${this.botId}: GStreamer failed:\`, error.message);
      
      this.cleanupGStreamerProcesses();
      
      // Fallback to FFmpeg
      console.log(\`⚠️ ViewBot \${this.botId}: Falling back to FFmpeg\`);
      this.config.useGStreamer = false;
      
      if (typeof this.startFFmpegVideoFileStreaming === 'function') {
        await this.startFFmpegVideoFileStreaming();
      }
    }
  }
  
  /**
   * Start GStreamer pipeline optimized for full video playback
   * Uses decodebin for automatic format detection
   */
  async startFullPlaybackGStreamerPipeline(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Use decodebin for automatic format handling (works with MP4, MKV, AVI, etc.)
    // Split into two separate pipelines for better reliability
    
    // Video pipeline
    const videoPipeline = [
      // File source with automatic format detection
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin', 'name=decode',
      
      // Connect video pad when available
      'decode.',
      '!', 'queue2',
        'max-size-buffers=0',
        'max-size-bytes=0',
        'max-size-time=0',
        'use-buffering=true',
      '!', 'videoconvert',
      '!', 'videoscale', 'method=1',
      '!', 'videorate', 'drop-only=true', 'max-rate=' + frameRate,
      '!', \`video/x-raw,width=\${width},height=\${height},framerate=\${frameRate}/1\`,
      
      // VP8 encoding
      '!', 'vp8enc',
        'deadline=1',
        'cpu-used=4',
        'target-bitrate=1500000',
        'keyframe-max-dist=60',
        'threads=4',
        'error-resilient=1',
        'end-usage=vbr',        // VBR for better quality
        'min-quantizer=4',
        'max-quantizer=56',
        'undershoot=95',
        'buffer-size=6000',
        'buffer-initial-size=4000',
        'buffer-optimal-size=5000',
      
      // RTP payload
      '!', 'rtpvp8pay',
        'pt=96',
        \`ssrc=\${this.videoSSRC}\`,
        'picture-id-mode=2',
        'mtu=1200',
      
      // UDP output with sync
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.videoRtpPort}\`,
        'sync=true',
        'async=false'
    ];
    
    // Audio pipeline
    const audioPipeline = [
      // File source with automatic format detection
      'filesrc', \`location=\${videoFile}\`,
      '!', 'decodebin', 'name=decode',
      
      // Connect audio pad when available
      'decode.',
      '!', 'queue2',
        'max-size-buffers=0',
        'max-size-bytes=0',
        'max-size-time=0',
        'use-buffering=true',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2,format=S16LE',
      
      // Opus encoding
      '!', 'opusenc',
        'bitrate=128000',
        'frame-size=20',
        'complexity=0',
        'audio-type=generic',
        'bandwidth=fullband',
        'inband-fec=true',
        'packet-loss-percentage=0',
        'dtx=false',
      
      // RTP payload
      '!', 'rtpopuspay',
        'pt=111',
        \`ssrc=\${this.audioSSRC}\`,
        'mtu=1200',
      
      // UDP output with sync
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.audioRtpPort}\`,
        'sync=true',
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting video pipeline for full playback\`);
    
    // Start video pipeline
    this.gstreamerVideoProcess = spawn(gstreamerPath, ['-v', ...videoPipeline], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(\`🔊 ViewBot \${this.botId}: Starting audio pipeline for full playback\`);
    
    // Start audio pipeline
    this.gstreamerAudioProcess = spawn(gstreamerPath, ['-v', ...audioPipeline], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let videoStarted = false;
    let audioStarted = false;
    let videoEOS = false;
    let audioEOS = false;
    
    // Monitor video pipeline
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: Video pipeline error:\`, output.substring(0, 500));
      } else if (output.includes('caps = video/x-raw')) {
        console.log(\`📹 ViewBot \${this.botId}: Video stream detected\`);
      } else if (output.includes('PLAYING')) {
        videoStarted = true;
        console.log(\`▶️ ViewBot \${this.botId}: Video pipeline playing\`);
      } else if (output.includes('EOS')) {
        videoEOS = true;
        console.log(\`🏁 ViewBot \${this.botId}: Video reached end of stream\`);
      } else if (output.includes('Freeing pipeline')) {
        console.log(\`✅ ViewBot \${this.botId}: Video pipeline completed\`);
      }
    });
    
    // Monitor audio pipeline
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: Audio pipeline error:\`, output.substring(0, 500));
      } else if (output.includes('caps = audio/x-raw')) {
        console.log(\`🔊 ViewBot \${this.botId}: Audio stream detected\`);
      } else if (output.includes('PLAYING')) {
        audioStarted = true;
        console.log(\`▶️ ViewBot \${this.botId}: Audio pipeline playing\`);
      } else if (output.includes('EOS')) {
        audioEOS = true;
        console.log(\`🏁 ViewBot \${this.botId}: Audio reached end of stream\`);
      } else if (output.includes('Freeing pipeline')) {
        console.log(\`✅ ViewBot \${this.botId}: Audio pipeline completed\`);
      }
    });
    
    // Handle video process exit
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: Video pipeline exited (code: \${code})\`);
      if (code === 0) {
        console.log(\`   Video playback completed successfully\`);
      }
      this.gstreamerVideoProcess = null;
      
      // Check if we should restart or stop
      if (!videoEOS && code !== 0) {
        console.warn(\`⚠️ ViewBot \${this.botId}: Video stopped unexpectedly\`);
      }
    });
    
    // Handle audio process exit
    this.gstreamerAudioProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: Audio pipeline exited (code: \${code})\`);
      if (code === 0) {
        console.log(\`   Audio playback completed successfully\`);
      }
      this.gstreamerAudioProcess = null;
      
      // Check if we should restart or stop
      if (!audioEOS && code !== 0) {
        console.warn(\`⚠️ ViewBot \${this.botId}: Audio stopped unexpectedly\`);
      }
    });
    
    // Wait for both pipelines to start
    await new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        if (!videoStarted && !audioStarted) {
          const error = new Error('GStreamer pipelines failed to start');
          console.error(\`❌ ViewBot \${this.botId}: \${error.message}\`);
          this.cleanupGStreamerProcesses();
          reject(error);
        } else {
          console.log(\`⚠️ ViewBot \${this.botId}: Partial start (Video: \${videoStarted}, Audio: \${audioStarted})\`);
          resolve();
        }
      }, 30000); // 30 seconds for large files
      
      const checkInterval = setInterval(() => {
        if (videoStarted || audioStarted) {
          clearTimeout(startTimeout);
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
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Stopping video pipeline\`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Stopping audio pipeline\`);
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
    if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
      console.log(\`🧹 ViewBot \${this.botId}: Stopping combined pipeline\`);
      this.gstreamerProcess.kill('SIGTERM');
      this.gstreamerProcess = null;
    }
  }
`;

async function applyFullPlaybackFix() {
  console.log('🔧 Applying GStreamer full playback fix...');
  
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
    console.error('❌ Could not find method boundary');
    return;
  }
  
  // Replace the methods
  const beforeMethod = content.substring(0, methodStart);
  const afterMethod = content.substring(methodEnd);
  content = beforeMethod + GSTREAMER_FULL_PLAYBACK_FIX + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ GStreamer full playback fixed!');
  console.log('\n🔑 Key improvements:');
  console.log('1. ✅ Using decodebin for automatic format detection');
  console.log('2. ✅ Separate pipelines for video and audio (more reliable)');
  console.log('3. ✅ queue2 with buffering for smooth playback');
  console.log('4. ✅ VBR encoding with buffer management');
  console.log('5. ✅ Proper EOS detection and handling');
  console.log('6. ✅ videorate with drop-only for frame rate control');
  console.log('7. ✅ Removed -e flag to let pipeline run to completion');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

applyFullPlaybackFix().catch(console.error);