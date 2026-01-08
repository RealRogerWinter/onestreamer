/**
 * Simple test to diagnose GStreamer playback issues
 * Tests if videos play completely with different configurations
 */

const { spawn } = require('child_process');
const fs = require('fs');

// Use the manual test video which should exist
const testVideo = 'C:\\onestreamer\\manual_test_video.mp4';

// Test if file exists
if (!fs.existsSync(testVideo)) {
  // Try uploads folder
  const uploads = 'C:\\onestreamer\\server\\uploads\\upload_test_video_1754662983845.mp4';
  if (fs.existsSync(uploads)) {
    console.log('Using uploads video');
  } else {
    console.error('No test video found!');
    process.exit(1);
  }
}

console.log('🎬 Testing GStreamer playback with:', testVideo);
console.log('=' .repeat(60));

// Test 1: Basic playback to check if video plays completely
async function testBasicPlayback() {
  console.log('\n1️⃣ Testing basic playback (filesrc → decodebin → fakesink)');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let pipelineStarted = false;
    let eosReceived = false;
    let exitCode = null;
    
    const proc = spawn(gstreamerPath, [
      '-v',  // Verbose
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'fakesink'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    proc.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('PLAYING')) {
        if (!pipelineStarted) {
          pipelineStarted = true;
          console.log('   ✅ Pipeline started');
        }
      } else if (output.includes('EOS')) {
        eosReceived = true;
        console.log('   ✅ EOS received - video played completely!');
      } else if (output.includes('ERROR')) {
        console.log('   ❌ Error:', output.substring(0, 200));
      }
    });
    
    proc.on('exit', (code) => {
      exitCode = code;
      const duration = (Date.now() - startTime) / 1000;
      
      console.log(`   Duration: ${duration.toFixed(2)}s`);
      console.log(`   Exit code: ${code}`);
      console.log(`   Result: ${eosReceived ? '✅ COMPLETE' : '❌ INCOMPLETE'}`);
      
      resolve({ duration, eosReceived, exitCode });
    });
    
    // Safety timeout - 30 seconds
    setTimeout(() => {
      if (!proc.killed) {
        console.log('   ⏱️ Timeout - stopping test');
        proc.kill();
      }
    }, 30000);
  });
}

// Test 2: With RTP elements (similar to our implementation)
async function testWithRTP() {
  console.log('\n2️⃣ Testing with RTP elements (VP8 + RTP)');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let pipelineStarted = false;
    let eosReceived = false;
    
    const proc = spawn(gstreamerPath, [
      '-v',
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
      '!', 'rtpvp8pay',
      '!', 'fakesink'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    proc.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('PLAYING')) {
        if (!pipelineStarted) {
          pipelineStarted = true;
          console.log('   ✅ Pipeline started');
        }
      } else if (output.includes('EOS')) {
        eosReceived = true;
        console.log('   ✅ EOS received');
      } else if (output.includes('ERROR')) {
        console.log('   ❌ Error:', output.substring(0, 200));
      }
    });
    
    proc.on('exit', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      
      console.log(`   Duration: ${duration.toFixed(2)}s`);
      console.log(`   Exit code: ${code}`);
      console.log(`   Result: ${eosReceived ? '✅ COMPLETE' : '❌ INCOMPLETE'}`);
      
      resolve({ duration, eosReceived, exitCode: code });
    });
    
    setTimeout(() => {
      if (!proc.killed) {
        console.log('   ⏱️ Timeout - stopping test');
        proc.kill();
      }
    }, 30000);
  });
}

// Test 3: With rtpbin
async function testWithRtpBin() {
  console.log('\n3️⃣ Testing with rtpbin');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let pipelineStarted = false;
    let eosReceived = false;
    
    const proc = spawn(gstreamerPath, [
      '-v',
      'rtpbin', 'name=rtpbin',
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'vp8enc', 'deadline=1',
      '!', 'rtpvp8pay',
      '!', 'rtpbin.send_rtp_sink_0',
      'rtpbin.send_rtp_src_0',
      '!', 'fakesink'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    proc.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('PLAYING')) {
        if (!pipelineStarted) {
          pipelineStarted = true;
          console.log('   ✅ Pipeline started');
        }
      } else if (output.includes('EOS')) {
        eosReceived = true;
        console.log('   ✅ EOS received');
      } else if (output.includes('ERROR')) {
        console.log('   ❌ Error:', output.substring(0, 200));
      }
    });
    
    proc.on('exit', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      
      console.log(`   Duration: ${duration.toFixed(2)}s`);
      console.log(`   Exit code: ${code}`);
      console.log(`   Result: ${eosReceived ? '✅ COMPLETE' : '❌ INCOMPLETE'}`);
      
      resolve({ duration, eosReceived, exitCode: code });
    });
    
    setTimeout(() => {
      if (!proc.killed) {
        console.log('   ⏱️ Timeout - stopping test');
        proc.kill();
      }
    }, 30000);
  });
}

// Test 4: With queue2 and rtpbin (current implementation)
async function testCurrentImplementation() {
  console.log('\n4️⃣ Testing current implementation (queue2 + rtpbin)');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let pipelineStarted = false;
    let eosReceived = false;
    
    const proc = spawn(gstreamerPath, [
      '-e', '-v',
      'rtpbin', 'name=rtpbin', 'latency=0',
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin', 'name=decoder',
      'decoder.',
      '!', 'queue2',
        'use-buffering=true',
        'max-size-buffers=0',
        'max-size-bytes=0',
        'max-size-time=10000000000',
      '!', 'videoconvert',
      '!', 'vp8enc', 'deadline=1',
      '!', 'rtpvp8pay',
      '!', 'rtpbin.send_rtp_sink_0',
      'rtpbin.send_rtp_src_0',
      '!', 'fakesink'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    proc.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('PLAYING')) {
        if (!pipelineStarted) {
          pipelineStarted = true;
          console.log('   ✅ Pipeline started');
        }
      } else if (output.includes('Buffering')) {
        const match = output.match(/(\d+)%/);
        if (match) {
          console.log(`   ⏳ Buffering: ${match[1]}%`);
        }
      } else if (output.includes('EOS')) {
        eosReceived = true;
        console.log('   ✅ EOS received');
      } else if (output.includes('ERROR')) {
        console.log('   ❌ Error:', output.substring(0, 200));
      }
    });
    
    proc.on('exit', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      
      console.log(`   Duration: ${duration.toFixed(2)}s`);
      console.log(`   Exit code: ${code}`);
      console.log(`   Result: ${eosReceived ? '✅ COMPLETE' : '❌ INCOMPLETE'}`);
      
      resolve({ duration, eosReceived, exitCode: code });
    });
    
    setTimeout(() => {
      if (!proc.killed) {
        console.log('   ⏱️ Timeout - stopping test');
        proc.kill();
      }
    }, 30000);
  });
}

// Run all tests
async function runTests() {
  const results = [];
  
  results.push(await testBasicPlayback());
  results.push(await testWithRTP());
  results.push(await testWithRtpBin());
  results.push(await testCurrentImplementation());
  
  // Summary
  console.log('\n' + '=' .repeat(60));
  console.log('📊 SUMMARY:');
  console.log('=' .repeat(60));
  
  const tests = [
    'Basic playback',
    'With RTP elements',
    'With rtpbin',
    'Current implementation'
  ];
  
  tests.forEach((name, i) => {
    const result = results[i];
    const status = result.eosReceived ? '✅' : '❌';
    console.log(`${status} ${name}: ${result.duration.toFixed(2)}s, EOS: ${result.eosReceived}`);
  });
  
  // Identify issue
  console.log('\n🔍 ANALYSIS:');
  
  if (results[0].eosReceived && !results[2].eosReceived) {
    console.log('❌ Issue appears to be with rtpbin - it prevents EOS propagation');
    console.log('💡 Solution: Need to handle EOS differently with rtpbin');
  } else if (results[0].eosReceived && !results[1].eosReceived) {
    console.log('❌ Issue appears to be with VP8 encoding or RTP');
    console.log('💡 Solution: Check encoder settings or RTP configuration');
  } else if (!results[0].eosReceived) {
    console.log('❌ Basic playback doesn\'t complete - file or GStreamer issue');
    console.log('💡 Check if file is valid and GStreamer is properly installed');
  } else {
    console.log('✅ All tests completed successfully!');
  }
}

runTests().catch(console.error);