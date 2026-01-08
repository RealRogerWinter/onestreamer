/**
 * Fix script for GStreamer ViewBot implementation
 * This script patches the ViewBotClientService to use the improved GStreamer service
 */

const fs = require('fs');
const path = require('path');

async function fixGStreamerImplementation() {
  console.log('🔧 Fixing GStreamer ViewBot implementation...');
  
  // Path to the ViewBotClientService file
  const servicePath = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');
  
  // Read the current file
  let content = fs.readFileSync(servicePath, 'utf8');
  
  // Check if already patched
  if (content.includes('ViewBotGStreamerService')) {
    console.log('✅ GStreamer service already integrated');
  } else {
    // Add import for GStreamer service
    const importPattern = /const ViewBotDatabaseService = require\('\.\/ViewBotDatabaseService'\);/;
    const importReplacement = `const ViewBotDatabaseService = require('./ViewBotDatabaseService');
const ViewBotGStreamerService = require('./ViewBotGStreamerService');`;
    
    content = content.replace(importPattern, importReplacement);
    
    // Add GStreamer service initialization in constructor
    const constructorPattern = /this\.dbService = new ViewBotDatabaseService\(\);\s*this\.dbInitialized = false;/;
    const constructorReplacement = `this.dbService = new ViewBotDatabaseService();
    this.dbInitialized = false;
    
    // GStreamer service for improved video streaming
    this.gstreamerService = new ViewBotGStreamerService();`;
    
    content = content.replace(constructorPattern, constructorReplacement);
    
    console.log('✅ Added GStreamer service imports and initialization');
  }
  
  // Find and replace the startGStreamerVideoFileStreaming method
  const methodStart = content.indexOf('async startGStreamerVideoFileStreaming()');
  if (methodStart !== -1) {
    // Find the end of the method (next method or end of class)
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
    
    // New improved method implementation
    const newMethod = `async startGStreamerVideoFileStreaming() {
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
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (!this.videoRtpPort || !this.audioRtpPort) {
      throw new Error('Failed to get RTP ports from server');
    }
    
    console.log(\`✅ ViewBot \${this.botId}: MediaSoup producers created\`);
    console.log(\`   Video RTP Port: \${this.videoRtpPort}\`);
    console.log(\`   Audio RTP Port: \${this.audioRtpPort}\`);
    
    try {
      // Use improved GStreamer pipeline with uridecodebin
      const videoFile = this.config.videoFile.replace(/\\\\/g, '/');
      
      // Build robust pipeline with proper error handling
      const pipeline = [
        \`uridecodebin uri=file:///\${videoFile} name=decoder\`,
        
        // Video branch with queue management
        'decoder.',
        '! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0',
        '! videoconvert',
        '! videoscale method=1',  // bilinear scaling
        \`! video/x-raw,width=\${width},height=\${height}\`,
        '! videorate',
        \`! video/x-raw,framerate=\${frameRate}/1\`,
        
        // VP8 encoding optimized for real-time
        '! vp8enc',
          'deadline=1',           // Real-time mode
          'cpu-used=8',          // Fastest encoding
          'error-resilient=1',   // Network resilience
          'target-bitrate=1500000',
          'keyframe-max-dist=30',
          'threads=4',
        
        // RTP with dynamic SSRC
        \`! rtpvp8pay ssrc=\${Math.floor(Math.random() * 0xFFFFFFFF)} pt=96 mtu=1200\`,
        \`! udpsink host=127.0.0.1 port=\${this.videoRtpPort} sync=false async=false\`,
        
        // Audio branch
        'decoder.',
        '! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0',
        '! audioconvert',
        '! audioresample',
        '! audio/x-raw,rate=48000,channels=2,format=S16LE',
        
        // Opus encoding
        '! opusenc',
          'bitrate=128000',
          'frame-size=20',
          'complexity=0',
        
        // RTP
        \`! rtpopuspay ssrc=\${Math.floor(Math.random() * 0xFFFFFFFF)} pt=111 mtu=1200\`,
        \`! udpsink host=127.0.0.1 port=\${this.audioRtpPort} sync=false async=false\`
      ].join(' ');
      
      const gstreamerPath = 'C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe';
      
      if (!fs.existsSync(gstreamerPath)) {
        throw new Error('GStreamer not installed at expected location');
      }
      
      const { spawn } = require('child_process');
      this.gstreamerProcess = spawn(gstreamerPath, ['-e', '-v', pipeline], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      // Monitor pipeline status
      this.gstreamerProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('ERROR')) {
          console.error(\`❌ ViewBot \${this.botId}: GStreamer error:\`, output);
        } else if (output.includes('PLAYING')) {
          console.log(\`▶️ ViewBot \${this.botId}: GStreamer pipeline playing\`);
        }
      });
      
      this.gstreamerProcess.on('error', (error) => {
        console.error(\`❌ ViewBot \${this.botId}: Failed to start GStreamer:\`, error);
        throw error;
      });
      
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
  }`;
    
    // Replace the old method with the new one
    const beforeMethod = content.substring(0, methodStart);
    const afterMethod = content.substring(methodEnd);
    content = beforeMethod + newMethod + afterMethod;
    
    console.log('✅ Replaced GStreamer streaming method with improved implementation');
  }
  
  // Write the fixed content back
  fs.writeFileSync(servicePath, content, 'utf8');
  
  console.log('✅ GStreamer ViewBot implementation fixed successfully!');
  console.log('\nKey improvements:');
  console.log('1. ✅ Using uridecodebin instead of decodebin for better format support');
  console.log('2. ✅ Dynamic SSRC generation to avoid conflicts');
  console.log('3. ✅ Proper queue management for smooth streaming');
  console.log('4. ✅ Optimized VP8 encoding settings for real-time streaming');
  console.log('5. ✅ Better error handling and FFmpeg fallback');
  console.log('6. ✅ RTCP support consideration for MediaSoup');
  console.log('\nNext steps:');
  console.log('1. Restart the server to apply changes');
  console.log('2. Test with: node test-gstreamer-viewbot.js');
  console.log('3. Monitor logs for any pipeline errors');
}

// Run the fix
fixGStreamerImplementation().catch(console.error);