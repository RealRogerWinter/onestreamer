/**
 * Fix GStreamer audio/video synchronization issues
 * Ensures proper playback speed and audio delivery
 */

const fs = require('fs');
const path = require('path');

// Fixed GStreamer implementation with proper sync
const GSTREAMER_SYNC_FIX = `
  /**
   * Starts GStreamer-based video file streaming with proper A/V sync
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
    
    // Create RTP parameters with exact SSRCs
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
      
      // Start synchronized GStreamer pipeline
      await this.startSynchronizedGStreamerPipeline(videoFile, width, height, frameRate);
      
      this.useGStreamer = true;
      
      console.log(\`✅ ViewBot \${this.botId}: GStreamer streaming started with A/V sync\`);
      
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
   * Start GStreamer with proper synchronization
   */
  async startSynchronizedGStreamerPipeline(videoFile, width, height, frameRate) {
    const { spawn } = require('child_process');
    
    // Build pipeline with proper sync and timing
    const pipeline = [
      // Use playbin for automatic sync handling
      'filesrc', \`location=\${videoFile}\`,
      '!', 'qtdemux', 'name=demux',
      
      // Video branch with proper timestamps
      'demux.video_0',
      '!', 'queue', 'max-size-time=1000000000', 'max-size-buffers=0', 'max-size-bytes=0',
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', 'videorate',
      '!', \`video/x-raw,width=\${width},height=\${height},framerate=\${frameRate}/1\`,
      
      // VP8 encoding with controlled bitrate
      '!', 'vp8enc',
        'deadline=1',
        'cpu-used=4',
        'target-bitrate=1500000',
        'keyframe-max-dist=60',
        'threads=4',
        'error-resilient=1',
        'end-usage=cbr',        // Constant bitrate for consistent timing
        'min-quantizer=4',
        'max-quantizer=56',
      
      // RTP with proper timestamps
      '!', 'rtpvp8pay',
        'pt=96',
        \`ssrc=\${this.videoSSRC}\`,
        'picture-id-mode=2',
        'mtu=1200',
      
      // Send video with sync
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.videoRtpPort}\`,
        'sync=true',           // Enable sync
        'async=false',
      
      // Audio branch with proper timestamps
      'demux.audio_0',
      '!', 'queue', 'max-size-time=1000000000', 'max-size-buffers=0', 'max-size-bytes=0',
      '!', 'decodebin',
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
      
      // RTP with proper timestamps
      '!', 'rtpopuspay',
        'pt=111',
        \`ssrc=\${this.audioSSRC}\`,
        'mtu=1200',
      
      // Send audio with sync
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.audioRtpPort}\`,
        'sync=true',           // Enable sync
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🚀 ViewBot \${this.botId}: Launching synchronized GStreamer pipeline\`);
    console.log(\`   Video: port=\${this.videoRtpPort}, ssrc=\${this.videoSSRC}\`);
    console.log(\`   Audio: port=\${this.audioRtpPort}, ssrc=\${this.audioSSRC}\`);
    
    this.gstreamerProcess = spawn(gstreamerPath, ['-e', ...pipeline], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let pipelineStarted = false;
    let hasAudio = false;
    let hasVideo = false;
    let errorBuffer = '';
    
    // Monitor pipeline
    this.gstreamerProcess.stderr.on('data', (data) => {
      const output = data.toString();
      errorBuffer += output;
      
      // Check for specific states
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer error:\`, output);
      } else if (output.includes('WARNING')) {
        if (output.includes('audio')) {
          console.warn(\`⚠️ ViewBot \${this.botId}: Audio warning:\`, output);
        }
      } else if (output.includes('caps = video/x-raw')) {
        hasVideo = true;
        console.log(\`📹 ViewBot \${this.botId}: Video stream detected\`);
      } else if (output.includes('caps = audio/x-raw')) {
        hasAudio = true;
        console.log(\`🔊 ViewBot \${this.botId}: Audio stream detected\`);
      } else if (output.includes('Pipeline is PREROLLED')) {
        console.log(\`📺 ViewBot \${this.botId}: Pipeline prerolled\`);
        pipelineStarted = true;
      } else if (output.includes('PLAYING')) {
        console.log(\`▶️ ViewBot \${this.botId}: Pipeline playing\`);
        pipelineStarted = true;
      }
    });
    
    this.gstreamerProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: GStreamer launch error:\`, error);
      throw error;
    });
    
    this.gstreamerProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: GStreamer exited (code: \${code}, signal: \${signal})\`);
      if (code === 255) {
        console.log(\`   Pipeline completed normally (end of file)\`);
      } else if (code !== 0 && errorBuffer) {
        console.error(\`   Last output:\`, errorBuffer.slice(-1000));
      }
      this.gstreamerProcess = null;
    });
    
    // Wait for pipeline to start
    await new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        if (!pipelineStarted) {
          const error = new Error('GStreamer pipeline failed to start');
          console.error(\`❌ ViewBot \${this.botId}: \${error.message}\`);
          console.error(\`   Has video: \${hasVideo}, Has audio: \${hasAudio}\`);
          if (errorBuffer) {
            console.error(\`   Last output:\`, errorBuffer.slice(-2000));
          }
          this.cleanupGStreamerProcesses();
          reject(error);
        } else {
          resolve();
        }
      }, 20000); // 20 seconds for large files
      
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
      try {
        // Send EOS signal for graceful shutdown
        this.gstreamerProcess.stdin.write('q');
        setTimeout(() => {
          if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
            this.gstreamerProcess.kill('SIGTERM');
          }
        }, 1000);
      } catch (e) {
        this.gstreamerProcess.kill('SIGTERM');
      }
      this.gstreamerProcess = null;
    }
    // Clean up any other processes
    if (this.gstreamerVideoProcess) {
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    if (this.gstreamerAudioProcess) {
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
  }
`;

async function applySyncFix() {
  console.log('🔧 Applying GStreamer synchronization fix...');
  
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
  content = beforeMethod + GSTREAMER_SYNC_FIX + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ GStreamer synchronization fixed!');
  console.log('\n🔑 Key improvements:');
  console.log('1. ✅ Using qtdemux for proper container parsing');
  console.log('2. ✅ Added queue buffers for timing management');
  console.log('3. ✅ Enabled sync=true on udpsink for proper timestamps');
  console.log('4. ✅ Fixed audio pipeline with proper Opus encoding settings');
  console.log('5. ✅ Using CBR (constant bitrate) for consistent timing');
  console.log('6. ✅ Separate audio/video branches from demuxer');
  console.log('7. ✅ Added -e flag for proper EOS handling');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

applySyncFix().catch(console.error);