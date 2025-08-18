/**
 * Final fix for GStreamer ViewBot - addresses the actual pipeline issues
 */

const fs = require('fs');
const path = require('path');

// The correct GStreamer implementation
const FIXED_GSTREAMER_METHOD = `
  async startGStreamerVideoFileStreaming() {
    console.log(\`🎬 ViewBot \${this.botId}: Starting GStreamer-based video file streaming\`);
    
    const { width = 1280, height = 720, frameRate = 30 } = this.config;
    
    // Check file exists first
    if (!fs.existsSync(this.config.videoFile)) {
      throw new Error(\`Video file not found: \${this.config.videoFile}\`);
    }
    
    // Create RTP parameters for both audio and video
    const videoRtpParams = this.createVideoRtpParameters();
    const audioRtpParams = this.createAudioRtpParameters();
    
    // Create MediaSoup producers using socket events
    console.log(\`📡 ViewBot \${this.botId}: Creating MediaSoup producers for GStreamer...\`);
    await Promise.all([
      this.createWebRTCProducer('video', videoRtpParams),
      this.createWebRTCProducer('audio', audioRtpParams)
    ]);
    
    // Wait for transports to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      throw new Error('Failed to get RTP ports from server');
    }
    
    console.log(\`✅ ViewBot \${this.botId}: MediaSoup producers created\`);
    console.log(\`   Video RTP Port: \${this.videoRtpPort}\`);
    console.log(\`   Audio RTP Port: \${this.audioRtpPort}\`);
    
    try {
      const videoFile = this.config.videoFile.replace(/\\\\/g, '/');
      
      // Start video pipeline with better error handling
      await this.startGStreamerVideoPipeline(videoFile, width, height, frameRate);
      
      // Start audio pipeline separately
      await this.startGStreamerAudioPipeline(videoFile);
      
      // Mark as using GStreamer
      this.useGStreamer = true;
      
      console.log(\`✅ ViewBot \${this.botId}: GStreamer streaming started successfully\`);
      
    } catch (error) {
      console.error(\`❌ ViewBot \${this.botId}: GStreamer launch failed:\`, error.message);
      console.error(\`   Full error:\`, error);
      
      // Clean up any started processes
      if (this.gstreamerVideoProcess) {
        this.gstreamerVideoProcess.kill();
        this.gstreamerVideoProcess = null;
      }
      if (this.gstreamerAudioProcess) {
        this.gstreamerAudioProcess.kill();
        this.gstreamerAudioProcess = null;
      }
      
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
    
    // Build video-only pipeline WITHOUT quotes in filesrc location
    // GStreamer spawn with array args doesn't need quotes
    const videoPipeline = [
      'filesrc',
      \`location=\${videoFile}\`,  // No quotes needed here
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
        \`ssrc=\${Math.floor(Math.random() * 0xFFFFFFFF)}\`,
        'pt=96',
        'mtu=1200',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.videoRtpPort}\`,
        'sync=false',
        'async=false'
    ];
    
    const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting GStreamer video pipeline\`);
    console.log(\`   File: \${videoFile}\`);
    console.log(\`   Port: \${this.videoRtpPort}\`);
    
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let errorOutput = '';
    let hasStarted = false;
    
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer video error:\`, output);
      } else if (output.includes('WARNING')) {
        console.warn(\`⚠️ ViewBot \${this.botId}: GStreamer video warning:\`, output);
      } else if (output.includes('PLAYING')) {
        hasStarted = true;
        console.log(\`▶️ ViewBot \${this.botId}: GStreamer video pipeline playing\`);
      } else if (output.includes('Setting pipeline to PLAYING')) {
        console.log(\`🎬 ViewBot \${this.botId}: GStreamer video pipeline starting...\`);
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer video:\`, error);
      throw error;
    });
    
    this.gstreamerVideoProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer video exited with code \${code}\`);
        if (errorOutput) {
          console.error(\`   Last output: \${errorOutput.slice(-500)}\`);
        }
      }
    });
    
    // Wait for pipeline to start with better detection
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!hasStarted) {
          const error = new Error('GStreamer video pipeline timeout - pipeline did not reach PLAYING state');
          console.error(\`❌ ViewBot \${this.botId}: \${error.message}\`);
          if (errorOutput) {
            console.error(\`   Last output: \${errorOutput.slice(-500)}\`);
          }
          reject(error);
        } else {
          resolve();
        }
      }, 10000); // Increase timeout to 10 seconds
      
      const checkInterval = setInterval(() => {
        if (hasStarted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      
      // Also resolve if we see certain indicators
      this.gstreamerVideoProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('PLAYING') || 
            output.includes('Redistribute latency') ||
            output.includes('Pipeline is PREROLLED')) {
          hasStarted = true;
        }
      });
    });
    
    console.log(\`✅ ViewBot \${this.botId}: GStreamer video pipeline started successfully\`);
  }
  
  async startGStreamerAudioPipeline(videoFile) {
    const { spawn } = require('child_process');
    
    // Build audio-only pipeline WITHOUT quotes
    const audioPipeline = [
      'filesrc',
      \`location=\${videoFile}\`,  // No quotes needed
      '!', 'decodebin',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc',
        'bitrate=128000',
      '!', 'rtpopuspay',
        \`ssrc=\${Math.floor(Math.random() * 0xFFFFFFFF)}\`,
        'pt=111',
        'mtu=1200',
      '!', 'udpsink',
        'host=127.0.0.1',
        \`port=\${this.audioRtpPort}\`,
        'sync=false',
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
      // Audio failure is not critical - continue without audio
      console.warn(\`⚠️ ViewBot \${this.botId}: Continuing without audio\`);
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
      console.log(\`✅ ViewBot \${this.botId}: GStreamer audio pipeline started successfully\`);
    }
  }
`;

async function applyFinalFix() {
  console.log('🔧 Applying final GStreamer fix...');
  
  const filePath = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find the startGStreamerVideoFileStreaming method
  const methodStart = content.indexOf('async startGStreamerVideoFileStreaming()');
  if (methodStart === -1) {
    console.error('❌ Could not find startGStreamerVideoFileStreaming method');
    return;
  }
  
  // Find the end of the method by counting braces
  let braceCount = 0;
  let inMethod = false;
  let methodEnd = methodStart;
  
  for (let i = methodStart; i < content.length; i++) {
    if (content[i] === '{') {
      braceCount++;
      inMethod = true;
    } else if (content[i] === '}') {
      braceCount--;
      if (inMethod && braceCount === 0) {
        // Find the end of startGStreamerAudioPipeline too
        const audioMethodEnd = content.indexOf('  }', i);
        if (audioMethodEnd !== -1) {
          methodEnd = audioMethodEnd + 3;
        } else {
          methodEnd = i + 1;
        }
        break;
      }
    }
  }
  
  // Replace the methods
  const beforeMethod = content.substring(0, methodStart);
  const afterMethod = content.substring(methodEnd);
  content = beforeMethod + FIXED_GSTREAMER_METHOD + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ GStreamer implementation fixed!');
  console.log('\n🔑 Key fixes applied:');
  console.log('1. ✅ Removed quotes from filesrc location parameter');
  console.log('2. ✅ Added better error logging and output capture');
  console.log('3. ✅ Increased timeout to 10 seconds for slow-loading videos');
  console.log('4. ✅ Improved pipeline state detection');
  console.log('5. ✅ Added proper cleanup on failure');
  console.log('\n⚠️ IMPORTANT: Restart the server for changes to take effect');
  console.log('\nTo use GStreamer with ViewBots:');
  console.log('1. Select "GStreamer" in the Streaming Method panel');
  console.log('2. Create a ViewBot with "Video File" content type');
  console.log('3. Enter the full path to a video file');
  console.log('4. Start the ViewBot');
}

applyFinalFix().catch(console.error);