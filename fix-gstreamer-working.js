/**
 * Working GStreamer fix for ViewBot
 * Fixes pipeline syntax and MediaSoup integration
 */

const fs = require('fs');
const path = require('path');

// Updated working GStreamer implementation
const WORKING_GSTREAMER_METHOD = `
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
      
      // Create separate pipelines for video and audio to avoid sync issues
      // This approach is more reliable than a single complex pipeline
      
      // Start video pipeline
      await this.startGStreamerVideoPipeline(videoFile, width, height, frameRate);
      
      // Start audio pipeline
      await this.startGStreamerAudioPipeline(videoFile);
      
      // Mark as using GStreamer
      this.useGStreamer = true;
      
      console.log(\`✅ ViewBot \${this.botId}: GStreamer streaming started successfully\`);
      
    } catch (error) {
      console.error(\`❌ ViewBot \${this.botId}: GStreamer launch failed:\`, error);
      
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
    
    // Build video-only pipeline with proper syntax
    const videoPipeline = [
      'filesrc', \`location="\${videoFile}"\`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', \`video/x-raw,width=\${width},height=\${height}\`,
      '!', 'videorate',
      '!', \`video/x-raw,framerate=\${frameRate}/1\`,
      '!', 'vp8enc',
        'deadline=1',           // Real-time mode
        'cpu-used=8',          // Fastest encoding
        'error-resilient=1',   // Error resilience
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
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting GStreamer video pipeline on port \${this.videoRtpPort}\`);
    
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    this.gstreamerVideoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer video error:\`, output);
      } else if (output.includes('PLAYING')) {
        console.log(\`▶️ ViewBot \${this.botId}: GStreamer video pipeline playing\`);
      }
    });
    
    this.gstreamerVideoProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer video:\`, error);
      throw error;
    });
    
    // Wait for pipeline to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('GStreamer video pipeline timeout'));
      }, 5000);
      
      const checkPlaying = (data) => {
        const output = data.toString();
        if (output.includes('PLAYING') || output.includes('Redistribute latency')) {
          clearTimeout(timeout);
          this.gstreamerVideoProcess.stderr.removeListener('data', checkPlaying);
          resolve();
        }
      };
      
      this.gstreamerVideoProcess.stderr.on('data', checkPlaying);
    });
  }
  
  async startGStreamerAudioPipeline(videoFile) {
    const { spawn } = require('child_process');
    
    // Build audio-only pipeline
    const audioPipeline = [
      'filesrc', \`location="\${videoFile}"\`,
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
    
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('ERROR')) {
        console.error(\`❌ ViewBot \${this.botId}: GStreamer audio error:\`, output);
      } else if (output.includes('PLAYING')) {
        console.log(\`▶️ ViewBot \${this.botId}: GStreamer audio pipeline playing\`);
      }
    });
    
    this.gstreamerAudioProcess.on('error', (error) => {
      console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer audio:\`, error);
      // Audio failure is not critical
      console.warn(\`⚠️ ViewBot \${this.botId}: Continuing without audio\`);
    });
    
    // Wait for pipeline to start (don't fail if audio doesn't work)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(\`⚠️ ViewBot \${this.botId}: Audio pipeline timeout, continuing\`);
        resolve();
      }, 3000);
      
      const checkPlaying = (data) => {
        const output = data.toString();
        if (output.includes('PLAYING') || output.includes('Redistribute latency')) {
          clearTimeout(timeout);
          this.gstreamerAudioProcess.stderr.removeListener('data', checkPlaying);
          resolve();
        }
      };
      
      this.gstreamerAudioProcess.stderr.on('data', checkPlaying);
    });
  }
`;

// Additional cleanup method update
const CLEANUP_UPDATE = `
    // Clean up GStreamer processes if they exist
    if (this.gstreamerVideoProcess && !this.gstreamerVideoProcess.killed) {
      console.log(\`🛑 ViewBot \${this.botId}: Killing GStreamer video process\`);
      this.gstreamerVideoProcess.kill('SIGTERM');
      this.gstreamerVideoProcess = null;
    }
    
    if (this.gstreamerAudioProcess && !this.gstreamerAudioProcess.killed) {
      console.log(\`🛑 ViewBot \${this.botId}: Killing GStreamer audio process\`);
      this.gstreamerAudioProcess.kill('SIGTERM');
      this.gstreamerAudioProcess = null;
    }
    
    // Original cleanup for single process
    if (this.gstreamerProcess && !this.gstreamerProcess.killed) {
      console.log(\`🛑 ViewBot \${this.botId}: Killing GStreamer process\`);
      this.gstreamerProcess.kill('SIGTERM');
      this.gstreamerProcess = null;
      this.useGStreamer = false;
    }
`;

async function applyFix() {
  console.log('🔧 Applying working GStreamer fix...');
  
  const filePath = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find the startGStreamerVideoFileStreaming method
  const methodStart = content.indexOf('async startGStreamerVideoFileStreaming()');
  if (methodStart === -1) {
    console.error('❌ Could not find startGStreamerVideoFileStreaming method');
    return;
  }
  
  // Find the end of the method
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
        methodEnd = i + 1;
        break;
      }
    }
  }
  
  // Replace the method
  const beforeMethod = content.substring(0, methodStart);
  const afterMethod = content.substring(methodEnd);
  content = beforeMethod + WORKING_GSTREAMER_METHOD + afterMethod;
  
  // Update cleanup section
  const cleanupIndex = content.indexOf('// Clean up GStreamer process if exists');
  if (cleanupIndex !== -1) {
    // Find the cleanup block and replace it
    const cleanupEnd = content.indexOf('this.useGStreamer = false;', cleanupIndex) + 'this.useGStreamer = false;'.length;
    const beforeCleanup = content.substring(0, cleanupIndex);
    const afterCleanup = content.substring(cleanupEnd);
    content = beforeCleanup + CLEANUP_UPDATE + afterCleanup;
  }
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ GStreamer implementation fixed!');
  console.log('\nKey fixes applied:');
  console.log('1. ✅ Separated video and audio pipelines for better reliability');
  console.log('2. ✅ Fixed GStreamer command-line argument syntax');
  console.log('3. ✅ Added proper pipeline state detection');
  console.log('4. ✅ Improved error handling with FFmpeg fallback');
  console.log('5. ✅ Added proper process cleanup');
  console.log('\nRestart the server to apply changes.');
}

applyFix().catch(console.error);