/**
 * Comprehensive test to diagnose GStreamer full playback issues
 * Using sync_test.mp4 as the test file
 */

const { spawn } = require('child_process');
const fs = require('fs');

const testVideo = 'C:\\onestreamer\\uploads\\sync_test.mp4';

// Verify file exists
if (!fs.existsSync(testVideo)) {
  console.error('❌ Test video not found:', testVideo);
  process.exit(1);
}

console.log('🎬 Testing GStreamer playback with:', testVideo);
console.log('=' .repeat(60));

// First, get video info
async function getVideoInfo() {
  console.log('\n📊 Getting video information...');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-discoverer-1.0.exe';
  
  return new Promise((resolve) => {
    const proc = spawn(gstreamerPath, [testVideo], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let output = '';
    proc.stdout.on('data', (data) => output += data.toString());
    proc.stderr.on('data', (data) => output += data.toString());
    
    proc.on('exit', () => {
      // Extract duration
      const durationMatch = output.match(/Duration: ([\d:.]+)/);
      const videoMatch = output.match(/video: (.+)/);
      const audioMatch = output.match(/audio: (.+)/);
      
      if (durationMatch) {
        console.log('   Duration:', durationMatch[1]);
      }
      if (videoMatch) {
        console.log('   Video:', videoMatch[1]);
      }
      if (audioMatch) {
        console.log('   Audio:', audioMatch[1]);
      }
      
      resolve(output);
    });
  });
}

// Test different pipeline configurations
async function testPipeline(name, args, expectedToComplete = true) {
  console.log(`\n🧪 Testing: ${name}`);
  console.log('   Pipeline:', args.slice(0, 10).join(' '), '...');
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let pipelineState = 'STOPPED';
    let eosReceived = false;
    let errorMessage = '';
    let bufferingEvents = 0;
    let lastPosition = 0;
    
    const proc = spawn(gstreamerPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Monitor stderr for GStreamer output
    proc.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Track pipeline state changes
      if (output.includes('PAUSED')) {
        pipelineState = 'PAUSED';
      } else if (output.includes('PLAYING')) {
        if (pipelineState !== 'PLAYING') {
          pipelineState = 'PLAYING';
          console.log('   ▶️ Pipeline PLAYING');
        }
      } else if (output.includes('EOS')) {
        eosReceived = true;
        console.log('   🏁 EOS received - video completed!');
      } else if (output.includes('ERROR')) {
        errorMessage = output.substring(output.indexOf('ERROR'), output.indexOf('ERROR') + 200);
        console.log('   ❌ Error detected');
      } else if (output.includes('Buffering')) {
        bufferingEvents++;
        const match = output.match(/(\d+)%/);
        if (match && bufferingEvents <= 5) { // Only show first 5 buffering events
          console.log(`   ⏳ Buffering: ${match[1]}%`);
        }
      } else if (output.includes('Position')) {
        const match = output.match(/Position: ([\d:.]+)/);
        if (match) {
          lastPosition = match[1];
        }
      }
      
      // Debug: Check for specific issues
      if (output.includes('not-linked')) {
        console.log('   ⚠️ Pad not-linked error detected');
      }
      if (output.includes('not-negotiated')) {
        console.log('   ⚠️ Caps not-negotiated error detected');
      }
    });
    
    proc.on('exit', (code, signal) => {
      const duration = (Date.now() - startTime) / 1000;
      
      console.log(`   ⏱️ Duration: ${duration.toFixed(2)}s`);
      console.log(`   📊 Exit code: ${code}, Signal: ${signal}`);
      console.log(`   🎯 EOS: ${eosReceived ? '✅ Yes' : '❌ No'}`);
      console.log(`   🚦 Final state: ${pipelineState}`);
      
      if (errorMessage) {
        console.log(`   💥 Error: ${errorMessage.substring(0, 100)}...`);
      }
      
      const success = eosReceived || (expectedToComplete && duration > 5);
      console.log(`   📋 Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);
      
      resolve({
        name,
        duration,
        eosReceived,
        exitCode: code,
        success,
        errorMessage
      });
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (!proc.killed) {
        console.log('   ⏰ Timeout reached, stopping...');
        proc.kill('SIGTERM');
      }
    }, 30000);
  });
}

async function runTests() {
  // Get video info first
  await getVideoInfo();
  
  const results = [];
  
  // Test 1: Most basic pipeline
  results.push(await testPipeline(
    'Basic (filesrc → decodebin → fakesink)',
    ['-v', 'filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'fakesink', 'sync=true']
  ));
  
  // Test 2: With video processing
  results.push(await testPipeline(
    'Video processing (with videoconvert)',
    ['-v', 'filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'videoconvert', '!', 'fakesink', 'sync=true']
  ));
  
  // Test 3: With queue
  results.push(await testPipeline(
    'With queue (default settings)',
    ['-v', 'filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'queue', '!', 'videoconvert', '!', 'fakesink', 'sync=true']
  ));
  
  // Test 4: With queue (no limits)
  results.push(await testPipeline(
    'With queue (max-size-time=0)',
    ['-v', 'filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'queue', 'max-size-time=0', 'max-size-buffers=200', '!', 'videoconvert', '!', 'fakesink', 'sync=true']
  ));
  
  // Test 5: With VP8 encoding
  results.push(await testPipeline(
    'VP8 encoding',
    ['-v', 'filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'videoconvert', '!', 'vp8enc', 'deadline=1', 'cpu-used=8', '!', 'fakesink', 'sync=true']
  ));
  
  // Test 6: With RTP
  results.push(await testPipeline(
    'RTP (VP8 + rtpvp8pay)',
    ['-v', 'filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'videoconvert', '!', 'vp8enc', 'deadline=1', '!', 'rtpvp8pay', '!', 'fakesink', 'sync=true']
  ));
  
  // Test 7: With -e flag
  results.push(await testPipeline(
    'With -e flag (force EOS)',
    ['-e', '-v', 'filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'fakesink', 'sync=true']
  ));
  
  // Test 8: Simple rtpbin test
  results.push(await testPipeline(
    'Simple rtpbin',
    ['-v', 
     'filesrc', `location=${testVideo}`,
     '!', 'decodebin',
     '!', 'videoconvert',
     '!', 'vp8enc', 'deadline=1',
     '!', 'rtpvp8pay',
     '!', 'application/x-rtp,payload=96',
     '!', 'fakesink', 'sync=true'
    ]
  ));
  
  // Test 9: With rtpbin (current approach)
  results.push(await testPipeline(
    'With rtpbin (full)',
    ['-v',
     'rtpbin', 'name=rtpbin', 'latency=0',
     'filesrc', `location=${testVideo}`,
     '!', 'decodebin', 'name=decoder',
     'decoder.',
     '!', 'queue', 'max-size-time=0', 'max-size-buffers=0',
     '!', 'videoconvert',
     '!', 'vp8enc', 'deadline=1',
     '!', 'rtpvp8pay', 'ssrc=11111111',
     '!', 'rtpbin.send_rtp_sink_0',
     'rtpbin.send_rtp_src_0',
     '!', 'fakesink', 'sync=true'
    ]
  ));
  
  // Test 10: UDP output (like our actual implementation)
  results.push(await testPipeline(
    'UDP output (actual implementation)',
    ['-v',
     'filesrc', `location=${testVideo}`,
     '!', 'decodebin',
     '!', 'videoconvert',
     '!', 'vp8enc', 'deadline=1',
     '!', 'rtpvp8pay',
     '!', 'udpsink', 'host=127.0.0.1', 'port=15004', 'sync=true'
    ],
    false // Don't expect completion since no receiver
  ));
  
  // Summary
  console.log('\n' + '=' .repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('=' .repeat(60));
  
  results.forEach(r => {
    const status = r.eosReceived ? '✅' : '❌';
    const duration = r.duration.toFixed(1);
    console.log(`${status} ${r.name}: ${duration}s`);
  });
  
  // Analysis
  console.log('\n🔍 ANALYSIS:');
  
  const successful = results.filter(r => r.eosReceived);
  const failed = results.filter(r => !r.eosReceived && r.name !== 'UDP output (actual implementation)');
  
  if (successful.length > 0) {
    console.log(`\n✅ Successful configurations (${successful.length}):`);
    successful.forEach(r => console.log(`   - ${r.name}`));
  }
  
  if (failed.length > 0) {
    console.log(`\n❌ Failed configurations (${failed.length}):`);
    failed.forEach(r => console.log(`   - ${r.name}`));
  }
  
  // Identify patterns
  const rtpTests = results.filter(r => r.name.includes('RTP') || r.name.includes('rtpbin'));
  const queueTests = results.filter(r => r.name.includes('queue'));
  
  console.log(`\n📈 Pattern Analysis:`);
  console.log(`   Basic playback: ${results[0].eosReceived ? '✅ Works' : '❌ Fails'}`);
  console.log(`   With encoding: ${results[4].eosReceived ? '✅ Works' : '❌ Fails'}`);
  console.log(`   RTP tests: ${rtpTests.filter(r => r.eosReceived).length}/${rtpTests.length} successful`);
  console.log(`   Queue tests: ${queueTests.filter(r => r.eosReceived).length}/${queueTests.length} successful`);
  
  // Recommendations
  console.log('\n💡 RECOMMENDATIONS:');
  
  if (results[0].eosReceived && !results[8].eosReceived) {
    console.log('   ❌ rtpbin is blocking EOS propagation');
    console.log('   💡 Solution: Remove rtpbin or handle EOS differently');
  }
  
  if (results[2].eosReceived && !results[3].eosReceived) {
    console.log('   ❌ max-size-time=0 causes issues');
    console.log('   💡 Solution: Use default queue settings or small non-zero values');
  }
  
  if (results[5].eosReceived && !results[8].eosReceived) {
    console.log('   ❌ rtpbin specifically is the problem');
    console.log('   💡 Solution: Use direct RTP without rtpbin');
  }
}

runTests().catch(console.error);