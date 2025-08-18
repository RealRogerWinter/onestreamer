/**
 * Direct test of GStreamer pipeline to diagnose hanging issue
 * This will show exactly what's happening when GStreamer tries to start
 */

const { spawn } = require('child_process');
const fs = require('fs');

// Test video
const testVideo = 'C:/onestreamer/uploads/sync_test.mp4';

// Check if file exists
if (!fs.existsSync(testVideo.replace(/\//g, '\\'))) {
  console.error('❌ Test video not found:', testVideo);
  process.exit(1);
}

console.log('🎬 Testing GStreamer pipeline directly');
console.log('📂 Video file:', testVideo);
console.log('=' .repeat(60));

// Test the exact pipeline that ViewBot uses
async function testViewBotPipeline() {
  console.log('\n🧪 Testing ViewBot pipeline (direct RTP without rtpbin)');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  // Check if GStreamer exists
  if (!fs.existsSync(gstreamerPath)) {
    console.error('❌ GStreamer not found at:', gstreamerPath);
    return;
  }
  
  // Video pipeline - exactly as ViewBot uses it
  const videoPipeline = [
    '-e',  // Force EOS on shutdown
    '-v',  // Verbose for debugging
    'filesrc', `location=${testVideo}`,
    '!', 'decodebin',
    '!', 'queue',
      'max-size-buffers=200',
      'max-size-time=2000000000',  // 2 seconds
      'max-size-bytes=10485760',   // 10MB
    '!', 'videoconvert',
    '!', 'videoscale',
    '!', 'video/x-raw,width=1280,height=720',
    '!', 'videorate',
    '!', 'video/x-raw,framerate=30/1',
    '!', 'vp8enc',
      'deadline=1',
      'cpu-used=4',
      'error-resilient=1',
      'target-bitrate=1500000',
      'keyframe-max-dist=30',
      'threads=2',
    '!', 'rtpvp8pay',
      'ssrc=11111111',
      'pt=96',
      'mtu=1200',
      'picture-id-mode=2',
    '!', 'udpsink',
      'host=127.0.0.1',
      'port=15004',
      'sync=true',
      'async=false'
  ];
  
  console.log('📋 Command:', gstreamerPath);
  console.log('📋 Args:', videoPipeline.join(' '));
  console.log('\n🚀 Starting pipeline...\n');
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let pipelineState = 'INITIALIZING';
    let errorBuffer = '';
    let outputBuffer = '';
    let lastOutput = Date.now();
    
    const proc = spawn(gstreamerPath, videoPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    console.log(`✅ Process started with PID: ${proc.pid}`);
    
    // Monitor stderr (GStreamer output)
    proc.stderr.on('data', (data) => {
      const output = data.toString();
      outputBuffer += output;
      lastOutput = Date.now();
      
      // Print all output for debugging
      console.log('[GSTREAMER]:', output.trim());
      
      // Track state changes
      if (output.includes('ERROR')) {
        pipelineState = 'ERROR';
        errorBuffer = output;
      } else if (output.includes('Setting pipeline to PAUSED')) {
        pipelineState = 'PAUSED';
      } else if (output.includes('Setting pipeline to PLAYING')) {
        pipelineState = 'PLAYING';
      } else if (output.includes('Setting pipeline to NULL')) {
        pipelineState = 'NULL';
      } else if (output.includes('EOS')) {
        pipelineState = 'EOS';
      }
    });
    
    // Monitor stdout
    proc.stdout.on('data', (data) => {
      console.log('[STDOUT]:', data.toString().trim());
    });
    
    proc.on('error', (error) => {
      console.error('❌ Failed to start process:', error.message);
      console.error('   Error code:', error.code);
      console.error('   Error details:', error);
      resolve({ error: error.message });
    });
    
    proc.on('exit', (code, signal) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('\n' + '=' .repeat(60));
      console.log('📊 Pipeline Results:');
      console.log(`   Duration: ${duration}s`);
      console.log(`   Exit code: ${code}`);
      console.log(`   Signal: ${signal}`);
      console.log(`   Final state: ${pipelineState}`);
      
      if (errorBuffer) {
        console.log('\n❌ Error details:');
        console.log(errorBuffer);
      }
      
      if (outputBuffer.length === 0) {
        console.log('\n⚠️ No output received from GStreamer!');
      }
      
      resolve({ code, signal, duration, pipelineState });
    });
    
    // Check for hanging
    const hangChecker = setInterval(() => {
      const timeSinceOutput = (Date.now() - lastOutput) / 1000;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      
      if (timeSinceOutput > 5) {
        console.log(`\n⚠️ [${elapsed}s] Pipeline appears to be hanging (no output for ${timeSinceOutput.toFixed(1)}s)`);
        console.log(`   Current state: ${pipelineState}`);
        console.log(`   Process still running: ${!proc.killed}`);
        
        if (timeSinceOutput > 15) {
          console.log('\n❌ Pipeline hung for too long, terminating...');
          clearInterval(hangChecker);
          proc.kill('SIGTERM');
        }
      }
    }, 1000);
    
    // Safety timeout
    setTimeout(() => {
      if (!proc.killed) {
        console.log('\n⏰ Safety timeout reached (30s), terminating...');
        clearInterval(hangChecker);
        proc.kill('SIGTERM');
      }
    }, 30000);
  });
}

// Test simpler pipeline first
async function testSimplePipeline() {
  console.log('\n🧪 Testing simple pipeline (filesrc → decodebin → fakesink)');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  const simplePipeline = [
    '-v',
    'filesrc', `location=${testVideo}`,
    '!', 'decodebin',
    '!', 'fakesink'
  ];
  
  console.log('📋 Command:', simplePipeline.join(' '));
  
  return new Promise((resolve) => {
    const proc = spawn(gstreamerPath, simplePipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let hasOutput = false;
    
    proc.stderr.on('data', (data) => {
      hasOutput = true;
      console.log('[SIMPLE]:', data.toString().trim().substring(0, 200));
    });
    
    proc.on('exit', (code) => {
      console.log(`   Exit code: ${code}`);
      console.log(`   Output received: ${hasOutput ? 'Yes' : 'No'}`);
      resolve({ code, hasOutput });
    });
    
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill();
      }
    }, 5000);
  });
}

async function runTests() {
  // Test simple pipeline first
  const simple = await testSimplePipeline();
  
  if (!simple.hasOutput) {
    console.log('\n❌ GStreamer is not producing any output!');
    console.log('Possible issues:');
    console.log('1. GStreamer may not be properly installed');
    console.log('2. Path format issues');
    console.log('3. Permission issues');
    console.log('4. Missing codecs');
    return;
  }
  
  // Test the actual ViewBot pipeline
  const result = await testViewBotPipeline();
  
  console.log('\n' + '=' .repeat(60));
  console.log('🔍 DIAGNOSIS:');
  
  if (result.error) {
    console.log('❌ Process failed to start:', result.error);
    console.log('   Check if GStreamer is installed and accessible');
  } else if (result.pipelineState === 'ERROR') {
    console.log('❌ Pipeline encountered an error');
    console.log('   Check the error details above');
  } else if (result.pipelineState === 'INITIALIZING') {
    console.log('❌ Pipeline never started playing');
    console.log('   Likely hanging during initialization');
  } else if (result.pipelineState === 'PLAYING') {
    console.log('⚠️ Pipeline started but may have hung during playback');
  } else if (result.pipelineState === 'EOS') {
    console.log('✅ Pipeline completed successfully!');
  }
}

runTests().catch(console.error);