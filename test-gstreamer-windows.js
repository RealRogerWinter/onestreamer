/**
 * Test GStreamer on Windows with proper spawn options
 * Windows requires special handling for console applications
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Test video - use Windows path
const testVideo = 'C:\\onestreamer\\uploads\\sync_test.mp4';

// Check if file exists
if (!fs.existsSync(testVideo)) {
  console.error('❌ Test video not found:', testVideo);
  process.exit(1);
}

console.log('🎬 Testing GStreamer on Windows');
console.log('📂 Video file:', testVideo);
console.log('=' .repeat(60));

// Test 1: Using exec instead of spawn
async function testWithExec() {
  console.log('\n🧪 Test 1: Using exec() command');
  
  const gstreamerPath = '"C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe"';
  const command = `${gstreamerPath} -v filesrc location="${testVideo}" ! decodebin ! fakesink`;
  
  console.log('📋 Command:', command);
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    exec(command, { 
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: false 
    }, (error, stdout, stderr) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log(`\n⏱️ Duration: ${duration}s`);
      
      if (error) {
        console.log('❌ Error:', error.message);
      }
      
      if (stdout) {
        console.log('📤 STDOUT:', stdout.substring(0, 500));
      }
      
      if (stderr) {
        console.log('📤 STDERR:', stderr.substring(0, 500));
      }
      
      resolve({ 
        hasOutput: !!(stdout || stderr), 
        error: error?.message 
      });
    });
    
    // Timeout
    setTimeout(() => {
      console.log('⏰ Timeout after 10 seconds');
      resolve({ hasOutput: false, error: 'timeout' });
    }, 10000);
  });
}

// Test 2: Using spawn with shell option
async function testWithSpawnShell() {
  console.log('\n🧪 Test 2: Using spawn() with shell: true');
  
  const command = '"C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe"';
  const args = [
    '-v',
    'filesrc', `location="${testVideo}"`,
    '!', 'decodebin',
    '!', 'fakesink'
  ];
  
  console.log('📋 Command:', command, args.join(' '));
  
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      shell: true,
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let hasOutput = false;
    let outputBuffer = '';
    
    proc.stdout.on('data', (data) => {
      hasOutput = true;
      const output = data.toString();
      outputBuffer += output;
      console.log('[STDOUT]:', output.trim().substring(0, 200));
    });
    
    proc.stderr.on('data', (data) => {
      hasOutput = true;
      const output = data.toString();
      outputBuffer += output;
      console.log('[STDERR]:', output.trim().substring(0, 200));
    });
    
    proc.on('error', (error) => {
      console.error('❌ Process error:', error.message);
    });
    
    proc.on('exit', (code) => {
      console.log(`Exit code: ${code}`);
      console.log(`Output received: ${hasOutput ? 'Yes' : 'No'}`);
      
      if (!hasOutput) {
        console.log('⚠️ No output received');
      }
      
      resolve({ hasOutput, output: outputBuffer });
    });
    
    setTimeout(() => {
      if (!proc.killed) {
        console.log('⏰ Killing after 5 seconds');
        proc.kill();
      }
    }, 5000);
  });
}

// Test 3: Direct test with UDP sink (actual pipeline)
async function testActualPipeline() {
  console.log('\n🧪 Test 3: Testing actual ViewBot pipeline with exec()');
  
  const gstreamerPath = '"C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe"';
  
  // Build the full command as a string
  const command = `${gstreamerPath} -e -v filesrc location="${testVideo}" ! decodebin ! queue max-size-buffers=200 max-size-time=2000000000 max-size-bytes=10485760 ! videoconvert ! videoscale ! video/x-raw,width=1280,height=720 ! videorate ! video/x-raw,framerate=30/1 ! vp8enc deadline=1 cpu-used=4 error-resilient=1 target-bitrate=1500000 keyframe-max-dist=30 threads=2 ! rtpvp8pay ssrc=11111111 pt=96 mtu=1200 picture-id-mode=2 ! udpsink host=127.0.0.1 port=15004 sync=true async=false`;
  
  console.log('📋 Full command:', command.substring(0, 200) + '...');
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const proc = exec(command, {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: false
    });
    
    let outputBuffer = '';
    let errorBuffer = '';
    let hasOutput = false;
    
    proc.stdout.on('data', (data) => {
      hasOutput = true;
      outputBuffer += data.toString();
      console.log('[OUT]:', data.toString().trim().substring(0, 200));
    });
    
    proc.stderr.on('data', (data) => {
      hasOutput = true;
      errorBuffer += data.toString();
      const output = data.toString().trim();
      
      // Log important events
      if (output.includes('ERROR')) {
        console.log('❌ ERROR:', output);
      } else if (output.includes('WARNING')) {
        console.log('⚠️ WARNING:', output.substring(0, 200));
      } else if (output.includes('PLAYING')) {
        console.log('▶️ Pipeline PLAYING');
      } else if (output.includes('Setting pipeline')) {
        console.log('🔧', output.substring(0, 100));
      } else {
        // Log first 200 chars of other output
        console.log('[ERR]:', output.substring(0, 200));
      }
    });
    
    proc.on('exit', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log(`\n📊 Results:`);
      console.log(`   Duration: ${duration}s`);
      console.log(`   Exit code: ${code}`);
      console.log(`   Output received: ${hasOutput ? 'Yes' : 'No'}`);
      
      if (errorBuffer.includes('ERROR')) {
        console.log('\n❌ Errors found in pipeline');
      } else if (errorBuffer.includes('PLAYING')) {
        console.log('\n✅ Pipeline reached PLAYING state');
      }
      
      resolve({ code, hasOutput, duration });
    });
    
    // Let it run for 10 seconds
    setTimeout(() => {
      if (proc.exitCode === null) {
        console.log('⏰ Terminating after 10 seconds');
        proc.kill();
      }
    }, 10000);
  });
}

async function runTests() {
  // Test 1: exec
  const execResult = await testWithExec();
  
  if (!execResult.hasOutput) {
    console.log('\n⚠️ exec() produced no output');
  }
  
  // Test 2: spawn with shell
  const spawnResult = await testWithSpawnShell();
  
  if (!spawnResult.hasOutput) {
    console.log('\n⚠️ spawn() with shell produced no output');
  }
  
  // Test 3: actual pipeline
  const pipelineResult = await testActualPipeline();
  
  // Summary
  console.log('\n' + '=' .repeat(60));
  console.log('📊 SUMMARY:');
  console.log(`   exec() test: ${execResult.hasOutput ? '✅ Has output' : '❌ No output'}`);
  console.log(`   spawn() shell test: ${spawnResult.hasOutput ? '✅ Has output' : '❌ No output'}`);
  console.log(`   Actual pipeline: ${pipelineResult.hasOutput ? '✅ Has output' : '❌ No output'}`);
  
  if (!execResult.hasOutput && !spawnResult.hasOutput && !pipelineResult.hasOutput) {
    console.log('\n❌ CRITICAL ISSUE: GStreamer is not producing any output when spawned from Node.js');
    console.log('\nPossible solutions:');
    console.log('1. Check Windows Defender or antivirus blocking GStreamer');
    console.log('2. Try running Node.js as Administrator');
    console.log('3. Check if GStreamer needs environment variables set');
    console.log('4. Use FFmpeg instead (which is already working)');
  }
}

runTests().catch(console.error);