/**
 * Fix GStreamer spawn issue on Windows
 * The problem: GStreamer doesn't output anything when spawned without shell: true on Windows
 */

const fs = require('fs');
const path = require('path');

// Fix the spawn issue in ViewBotClientService.js
const SPAWN_FIX = `
  /**
   * Start GStreamer pipelines without rtpbin for complete playback
   * Uses separate video and audio pipelines with direct RTP streaming
   * FIXED: Use shell: true on Windows for GStreamer to work properly
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
    
    const gstreamerPath = '"C:\\\\Program Files\\\\gstreamer\\\\1.0\\\\msvc_x86_64\\\\bin\\\\gst-launch-1.0.exe"';
    
    console.log(\`🎥 ViewBot \${this.botId}: Starting video pipeline (no rtpbin)\`);
    
    // CRITICAL FIX: Use shell: true on Windows for GStreamer to work
    this.gstreamerVideoProcess = spawn(gstreamerPath, videoPipeline, {
      shell: true,  // REQUIRED for GStreamer on Windows
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(\`🔊 ViewBot \${this.botId}: Starting audio pipeline (no rtpbin)\`);
    
    // CRITICAL FIX: Use shell: true on Windows for GStreamer to work
    this.gstreamerAudioProcess = spawn(gstreamerPath, audioPipeline, {
      shell: true,  // REQUIRED for GStreamer on Windows
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
        console.error(output);
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
    
    // Also monitor stdout for Windows
    this.gstreamerVideoProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Setting pipeline')) {
        console.log(\`🔧 ViewBot \${this.botId}: Video pipeline state: \${output.trim()}\`);
      }
    });
    
    // Monitor audio pipeline
    this.gstreamerAudioProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('ERROR')) {
        audioError = output.substring(0, 200);
        console.error(\`❌ ViewBot \${this.botId}: Audio pipeline error\`);
        console.error(output);
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
    
    // Also monitor stdout for Windows
    this.gstreamerAudioProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Setting pipeline')) {
        console.log(\`🔧 ViewBot \${this.botId}: Audio pipeline state: \${output.trim()}\`);
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
`;

async function applySpawnFix() {
  console.log('🔧 Applying GStreamer spawn fix for Windows...');
  
  const filePath = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find the startDirectRTPPipelines method
  const methodStart = content.indexOf('async startDirectRTPPipelines(');
  if (methodStart === -1) {
    console.error('❌ Could not find startDirectRTPPipelines method');
    return;
  }
  
  // Find the end of the method
  let braceCount = 0;
  let inMethod = false;
  let methodEnd = -1;
  
  for (let i = methodStart; i < content.length; i++) {
    if (content[i] === '{') {
      braceCount++;
      inMethod = true;
    } else if (content[i] === '}' && inMethod) {
      braceCount--;
      if (braceCount === 0) {
        methodEnd = i + 1;
        break;
      }
    }
  }
  
  if (methodEnd === -1) {
    console.error('❌ Could not find end of startDirectRTPPipelines method');
    return;
  }
  
  // Replace the method
  const beforeMethod = content.substring(0, methodStart);
  const afterMethod = content.substring(methodEnd);
  content = beforeMethod + SPAWN_FIX + afterMethod;
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('✅ GStreamer spawn fix applied!');
  console.log('\n🔑 Key fix:');
  console.log('   Added shell: true to spawn options for Windows compatibility');
  console.log('   This allows GStreamer to properly execute on Windows');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

applySpawnFix().catch(console.error);