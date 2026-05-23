/**
 * Add extensive debugging to GStreamer implementation in ViewBotClientService.js
 * This will help identify exactly where and why the video hangs
 */

const fs = require('fs');
const path = require('path');

// Enhanced GStreamer implementation with comprehensive debugging
const DEBUGGING_IMPLEMENTATION = `
  /**
   * Starts GStreamer-based video file streaming without rtpbin
   * Uses direct RTP streaming to avoid rtpbin's EOS issues
   * ENHANCED WITH EXTENSIVE DEBUGGING
   */
  async startGStreamerVideoFileStreaming() {
    console.log(\`🎬 ViewBot \${this.botId}: Starting GStreamer-based video file streaming (DEBUGGING MODE)\`);
    console.log(\`📂 Video file: \${this.config.videoFile}\`);
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    console.log(\`📐 Resolution: \${width}x\${height} @ \${frameRate}fps\`);
    
    // Check file exists first
    if (!fs.existsSync(this.config.videoFile)) {
      console.error(\`❌ ViewBot \${this.botId}: Video file not found: \${this.config.videoFile}\`);
      throw new Error(\`Video file not found: \${this.config.videoFile}\`);
    }
    
    // Get file info
    const stats = fs.statSync(this.config.videoFile);
    console.log(\`📊 File size: \${(stats.size / 1024 / 1024).toFixed(2)} MB\`);
    
    // Generate fixed SSRCs that will be used by both GStreamer and MediaSoup
    const videoSSRC = 11111111;
    const audioSSRC = 22222222;
    
    console.log(\`🔑 Using SSRCs - Video: \${videoSSRC}, Audio: \${audioSSRC}\`);
    
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
    console.log(\`   Step 1: Creating video producer...\`);
    
    // Store SSRCs for use in GStreamer
    this.videoSSRC = videoSSRC;
    this.audioSSRC = audioSSRC;
    
    try {
      await this.createWebRTCProducer('video', videoRtpParams);
      console.log(\`   ✅ Video producer created\`);
    } catch (err) {
      console.error(\`   ❌ Failed to create video producer:\`, err.message);
      throw err;
    }
    
    try {
      console.log(\`   Step 2: Creating audio producer...\`);
      await this.createWebRTCProducer('audio', audioRtpParams);
      console.log(\`   ✅ Audio producer created\`);
    } catch (err) {
      console.error(\`   ❌ Failed to create audio producer:\`, err.message);
      throw err;
    }
    
    // Wait for transports to be ready
    console.log(\`⏳ Waiting for transports to be ready...\`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      console.error(\`❌ ViewBot \${this.botId}: Failed to get RTP ports from server\`);
      console.error(\`   Video port: \${this.videoRtpPort}, Audio port: \${this.audioRtpPort}\`);
      throw new Error('Failed to get RTP ports from server');
    }
    
    console.log(\`✅ ViewBot \${this.botId}: MediaSoup PlainTransport ready\`);
    console.log(\`   Video: RTP port \${this.videoRtpPort}, SSRC \${videoSSRC}\`);
    console.log(\`   Audio: RTP port \${this.audioRtpPort}, SSRC \${audioSSRC}\`);
    
    try {
      // IMPORTANT: Use forward slashes for Windows paths in GStreamer
      const videoFile = this.config.videoFile.replace(/\\\\/g, '/');
      console.log(\`📁 Converted path for GStreamer: \${videoFile}\`);
      
      // Start separate pipelines without rtpbin
      console.log(\`🚀 Starting GStreamer pipelines...\`);
      await this.startDirectRTPPipelines(videoFile, width, height, frameRate);
      
      // Mark as using GStreamer
      this.useGStreamer = true;
      
      console.log(\`✅ ViewBot \${this.botId}: GStreamer streaming started successfully\`);
      
    } catch (error) {
      console.error(\`❌ ViewBot \${this.botId}: GStreamer launch failed:\`, error.message);
      console.error(\`   Full error:\`, error);
      
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
   * ENHANCED WITH EXTENSIVE DEBUGGING
   */
  async startDirectRTPPipelines(videoFile, width, height, frameRate) {
    console.log(\`🎬 ViewBot \${this.botId}: startDirectRTPPipelines called\`);
    console.log(\`   File: \${videoFile}\`);
    console.log(\`   Settings: \${width}x\${height}@\${frameRate}fps\`);
    
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
    
    // Check if GStreamer exists
    if (!fs.existsSync(gstreamerPath)) {
      console.error(\`❌ GStreamer not found at: \${gstreamerPath}\`);
      throw new Error('GStreamer not found');
    }
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting video pipeline (no rtpbin)\`);
    console.log(\`   Command: gst-launch-1.0 \${videoPipeline.slice(0, 10).join(' ')}...\`);
    
    // Start video pipeline
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(\`   Video PID: \${this.gstreamerVideoProcess.pid}\`);
    
    console.log(\`🔊 ViewBot \${this.botId}: Starting audio pipeline (no rtpbin)\`);
    console.log(\`   Command: gst-launch-1.0 \${audioPipeline.slice(0, 10).join(' ')}...\`);
    
    // Start audio pipeline
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(\`   Audio PID: \${this.gstreamerAudioProcess.pid}\`);
    
    let videoStarted = false;
    let audioStarted = false;
    let videoEOS = false;
    let audioEOS = false;
    let videoError = '';
    let audioError = '';
    let videoPipelineStage = 'INITIALIZING';
    let audioPipelineStage = 'INITIALIZING';
    let lastVideoLog = Date.now();
    let lastAudioLog = Date.now();
    
    // Monitor video pipeline
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      const now = Date.now();
      
      // Log every 5 seconds or on important events
      const shouldLog = (now - lastVideoLog > 5000) || 
                       output.includes('ERROR') || 
                       output.includes('WARNING') ||
                       output.includes('PLAYING') ||
                       output.includes('EOS') ||
                       output.includes('Setting pipeline');
      
      if (shouldLog) {
        console.log(\`📹 Video pipeline [\${videoPipelineStage}]: \${output.substring(0, 200)}\`);
        lastVideoLog = now;
      }
      
      if (output.includes('ERROR')) {
        videoError = output.substring(0, 500);
        videoPipelineStage = 'ERROR';
        console.error(\`❌ ViewBot \${this.botId}: Video pipeline error:\`);
        console.error(output);
      } else if (output.includes('WARNING')) {
        console.warn(\`⚠️ ViewBot \${this.botId}: Video pipeline warning: \${output.substring(0, 200)}\`);
      } else if (output.includes('Setting pipeline to PAUSED')) {
        videoPipelineStage = 'PAUSED';
        console.log(\`⏸️ ViewBot \${this.botId}: Video pipeline PAUSED\`);
      } else if (output.includes('Setting pipeline to PLAYING')) {
        videoPipelineStage = 'PLAYING';
        if (!videoStarted) {
          videoStarted = true;
          console.log(\`▶️ ViewBot \${this.botId}: Video pipeline PLAYING\`);
        }
      } else if (output.includes('EOS')) {
        videoEOS = true;
        videoPipelineStage = 'EOS';
        console.log(\`🏁 ViewBot \${this.botId}: Video EOS received - complete playback!\`);
      } else if (output.includes('Setting pipeline')) {
        console.log(\`🔧 ViewBot \${this.botId}: Video pipeline state change: \${output.substring(0, 100)}\`);
      } else if (output.includes('caps = video/')) {
        console.log(\`📹 ViewBot \${this.botId}: Video stream detected: \${output.substring(0, 150)}\`);
      } else if (output.includes('Freeing pipeline')) {
        videoPipelineStage = 'FREED';
        console.log(\`🧹 ViewBot \${this.botId}: Video pipeline freed\`);
      }
    });
    
    // Monitor audio pipeline
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      const now = Date.now();
      
      // Log every 5 seconds or on important events
      const shouldLog = (now - lastAudioLog > 5000) || 
                       output.includes('ERROR') || 
                       output.includes('WARNING') ||
                       output.includes('PLAYING') ||
                       output.includes('EOS');
      
      if (shouldLog) {
        console.log(\`🔊 Audio pipeline [\${audioPipelineStage}]: \${output.substring(0, 200)}\`);
        lastAudioLog = now;
      }
      
      if (output.includes('ERROR')) {
        audioError = output.substring(0, 500);
        audioPipelineStage = 'ERROR';
        console.error(\`❌ ViewBot \${this.botId}: Audio pipeline error:\`);
        console.error(output);
      } else if (output.includes('WARNING')) {
        console.warn(\`⚠️ ViewBot \${this.botId}: Audio pipeline warning: \${output.substring(0, 200)}\`);
      } else if (output.includes('Setting pipeline to PAUSED')) {
        audioPipelineStage = 'PAUSED';
        console.log(\`⏸️ ViewBot \${this.botId}: Audio pipeline PAUSED\`);
      } else if (output.includes('Setting pipeline to PLAYING')) {
        audioPipelineStage = 'PLAYING';
        if (!audioStarted) {
          audioStarted = true;
          console.log(\`▶️ ViewBot \${this.botId}: Audio pipeline PLAYING\`);
        }
      } else if (output.includes('EOS')) {
        audioEOS = true;
        audioPipelineStage = 'EOS';
        console.log(\`🏁 ViewBot \${this.botId}: Audio EOS received - complete playback!\`);
      } else if (output.includes('caps = audio/')) {
        console.log(\`🔊 ViewBot \${this.botId}: Audio stream detected: \${output.substring(0, 150)}\`);
      } else if (output.includes('Freeing pipeline')) {
        audioPipelineStage = 'FREED';
        console.log(\`🧹 ViewBot \${this.botId}: Audio pipeline freed\`);
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start video pipeline:\`, error);
      console.error(\`   Error details:\`, error.message);
      throw error;
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start audio pipeline:\`, error);
      console.error(\`   Error details:\`, error.message);
      // Audio failure is not critical, continue
    });
    
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      console.log(\`🛑 ViewBot \${this.botId}: Video pipeline exited\`);
      console.log(\`   Exit code: \${code}\`);
      console.log(\`   Signal: \${signal}\`);
      console.log(\`   Final stage: \${videoPipelineStage}\`);
      
      if (videoEOS) {
        console.log(\`   ✅ Video played to completion\`);
      } else if (code === 0) {
        console.log(\`   ✅ Video pipeline completed normally\`);
      } else if (videoError) {
        console.error(\`   ❌ Video error: \${videoError}\`);
      } else {
        console.log(\`   ⚠️ Video pipeline stopped unexpectedly\`);
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
      console.log(\`🛑 ViewBot \${this.botId}: Audio pipeline exited\`);
      console.log(\`   Exit code: \${code}\`);
      console.log(\`   Signal: \${signal}\`);
      console.log(\`   Final stage: \${audioPipelineStage}\`);
      
      if (audioEOS) {
        console.log(\`   ✅ Audio played to completion\`);
      } else if (code === 0) {
        console.log(\`   ✅ Audio pipeline completed normally\`);
      } else if (audioError) {
        console.error(\`   ❌ Audio error: \${audioError}\`);
      } else {
        console.log(\`   ⚠️ Audio pipeline stopped unexpectedly\`);
      }
      
      this.gstreamerAudioProcess = null;
    });
    
    // Wait for pipelines to start with detailed monitoring
    console.log(\`⏳ Waiting for pipelines to start (15 second timeout)...\`);
    const startTime = Date.now();
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(\`⏰ Timeout reached after \${elapsed}s\`);
        console.log(\`   Video started: \${videoStarted}\`);
        console.log(\`   Audio started: \${audioStarted}\`);
        console.log(\`   Video stage: \${videoPipelineStage}\`);
        console.log(\`   Audio stage: \${audioPipelineStage}\`);
        
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
      
      let checkCount = 0;
      const checkInterval = setInterval(() => {
        checkCount++;
        if (checkCount % 10 === 0) { // Log every second
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(\`   [\${elapsed}s] Checking... Video: \${videoPipelineStage}, Audio: \${audioPipelineStage}\`);
        }
        
        if (videoStarted || audioStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(\`✅ ViewBot \${this.botId}: Pipelines started after \${elapsed}s\`);
          console.log(\`   Video: \${videoStarted ? '✅ Started' : '❌ Not started'} (stage: \${videoPipelineStage})\`);
          console.log(\`   Audio: \${audioStarted ? '✅ Started' : '❌ Not started'} (stage: \${audioPipelineStage})\`);
          resolve();
        }
      }, 100);
    });
  }
  
  /**
   * Clean up GStreamer processes
   */
  cleanupGStreamerProcesses() {
    console.log(\`🧹 ViewBot \${this.botId}: Cleaning up GStreamer processes...\`);
    this.stopping = true;
    
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      console.log(\`   Killing video pipeline (PID: \${this.gstreamerVideoProcess.pid})\`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      console.log(\`   Killing audio pipeline (PID: \${this.gstreamerAudioProcess.pid})\`);
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
    if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
      console.log(\`   Killing GStreamer process (PID: \${this.gstreamerProcess.pid})\`);
      this.gstreamerProcess.kill('SIGTERM');
      this.gstreamerProcess = null;
    }
    console.log(\`   ✅ Cleanup complete\`);
  }
`;

async function addDebugging() {
  console.log('🔧 Adding extensive debugging to GStreamer implementation...');
  
  const filePath = path.join(__dirname, '..', '..', 'server', 'services', 'ViewBotClientService.js');
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find the startGStreamerVideoFileStreaming method
  const methodStart = content.indexOf('async startGStreamerVideoFileStreaming()');
  if (methodStart === -1) {
    console.error('❌ Could not find startGStreamerVideoFileStreaming method');
    return;
  }
  
  // Find the end of GStreamer methods (look for cleanupGStreamerProcesses)
  let methodEnd = content.indexOf('async startFFmpegVideoGeneration()', methodStart);
  if (methodEnd === -1) {
    methodEnd = content.indexOf('\n  /**\n   * Starts FFmpeg', methodStart);
  }
  if (methodEnd === -1) {
    // Try to find the next class method after cleanup
    const cleanupEnd = content.indexOf('cleanupGStreamerProcesses() {', methodStart);
    if (cleanupEnd !== -1) {
      // Find the end of cleanup method
      let braceCount = 0;
      let inMethod = false;
      for (let i = cleanupEnd; i < content.length; i++) {
        if (content[i] === '{') {
          braceCount++;
          inMethod = true;
        } else if (content[i] === '}' && inMethod) {
          braceCount--;
          if (braceCount === 0) {
            methodEnd = i + 1;
            // Skip to next line
            while (methodEnd < content.length && content[methodEnd] !== '\n') {
              methodEnd++;
            }
            break;
          }
        }
      }
    }
  }
  
  if (methodEnd === -1) {
    console.error('❌ Could not find end of GStreamer methods');
    return;
  }
  
  // Replace the methods
  const beforeMethod = content.substring(0, methodStart);
  const afterMethod = content.substring(methodEnd);
  content = beforeMethod + DEBUGGING_IMPLEMENTATION + '\n  ' + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ Extensive debugging added to GStreamer implementation!');
  console.log('\n🔍 Debug features added:');
  console.log('1. ✅ Detailed logging at every step');
  console.log('2. ✅ Pipeline state tracking');
  console.log('3. ✅ Timing information');
  console.log('4. ✅ Error capture and reporting');
  console.log('5. ✅ Process PID logging');
  console.log('6. ✅ File path and size info');
  console.log('7. ✅ MediaSoup connection details');
  console.log('8. ✅ Periodic status updates');
  console.log('9. ✅ Comprehensive exit diagnostics');
  console.log('\n⚠️ Restart the server to apply debugging');
  console.log('📝 Then check server logs when attempting to use GStreamer');
}

addDebugging().catch(console.error);