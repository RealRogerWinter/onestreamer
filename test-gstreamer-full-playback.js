/**
 * Comprehensive test to diagnose why GStreamer doesn't play full video files
 * Tests various pipeline configurations and monitors output
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Find a test video file
function findTestVideo() {
  const possibleVideos = [
    'C:\\onestreamer\\server\\uploads\\scarface_1754871639821.mp4',
    'C:\\onestreamer\\server\\uploads\\friend_1754877820693.mp4',
    'C:\\onestreamer\\server\\uploads\\old_1754969913655.mp4',
    'C:\\onestreamer\\uploads\\sync_test.mp4'
  ];
  
  for (const video of possibleVideos) {
    if (fs.existsSync(video)) {
      return video;
    }
  }
  return null;
}

// Get video duration using GStreamer discoverer
async function getVideoDuration(videoFile) {
  return new Promise((resolve) => {
    const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-discoverer-1.0.exe';
    
    const proc = spawn(gstreamerPath, ['-v', videoFile], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', () => {
      const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        console.log(`📏 Video duration: ${totalSeconds.toFixed(2)} seconds`);
        resolve(totalSeconds);
      } else {
        console.log('⚠️ Could not determine video duration');
        resolve(0);
      }
    });
  });
}

// Test a pipeline configuration
async function testPipeline(name, pipeline, videoFile, expectedDuration) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 Testing: ${name}`);
  console.log(`${'='.repeat(60)}`);
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let pipelineStarted = false;
    let eosReceived = false;
    let errorOccurred = false;
    let lastProgress = 0;
    let progressUpdates = [];
    let errorBuffer = '';
    let bufferingEvents = [];
    
    const proc = spawn(gstreamerPath, pipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Monitor stderr for GStreamer messages
    proc.stderr.on('data', (data) => {
      const output = data.toString();
      errorBuffer += output;
      
      // Check for various states
      if (output.includes('ERROR')) {
        errorOccurred = true;
        console.error(`❌ Error: ${output.substring(0, 200)}`);
      } else if (output.includes('WARNING')) {
        if (!output.includes('latency')) { // Ignore latency warnings
          console.warn(`⚠️ Warning: ${output.substring(0, 150)}`);
        }
      } else if (output.includes('PLAYING')) {
        pipelineStarted = true;
        console.log(`▶️ Pipeline started playing`);
      } else if (output.includes('Buffering')) {
        const match = output.match(/Buffering, (\d+)%/);
        if (match) {
          bufferingEvents.push(parseInt(match[1]));
          console.log(`⏳ Buffering: ${match[1]}%`);
        }
      } else if (output.includes('Position')) {
        const match = output.match(/Position: (\d+):(\d+):(\d+\.\d+)/);
        if (match) {
          const pos = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
          lastProgress = pos;
          progressUpdates.push(pos);
        }
      } else if (output.includes('EOS')) {
        eosReceived = true;
        console.log(`🏁 EOS received`);
      } else if (output.includes('Freeing pipeline')) {
        console.log(`🧹 Pipeline freed`);
      }
    });
    
    proc.on('exit', (code, signal) => {
      const duration = (Date.now() - startTime) / 1000;
      const playbackPercentage = expectedDuration > 0 ? (duration / expectedDuration * 100).toFixed(1) : 0;
      
      console.log(`\n📊 Results for ${name}:`);
      console.log(`   Exit code: ${code}`);
      console.log(`   Signal: ${signal}`);
      console.log(`   Pipeline started: ${pipelineStarted ? '✅' : '❌'}`);
      console.log(`   EOS received: ${eosReceived ? '✅' : '❌'}`);
      console.log(`   Errors: ${errorOccurred ? '❌ Yes' : '✅ No'}`);
      console.log(`   Playback duration: ${duration.toFixed(2)}s`);
      console.log(`   Expected duration: ${expectedDuration.toFixed(2)}s`);
      console.log(`   Playback percentage: ${playbackPercentage}%`);
      console.log(`   Last progress: ${lastProgress.toFixed(2)}s`);
      console.log(`   Progress updates: ${progressUpdates.length}`);
      console.log(`   Buffering events: ${bufferingEvents.length}`);
      
      if (Math.abs(duration - expectedDuration) < 2) {
        console.log(`   ✅ Full playback achieved!`);
      } else if (duration < expectedDuration - 2) {
        console.log(`   ❌ Stopped ${(expectedDuration - duration).toFixed(2)}s early`);
      }
      
      if (errorBuffer.includes('not-linked')) {
        console.log(`   ⚠️ Detected not-linked error (pad connection issue)`);
      }
      if (errorBuffer.includes('not-negotiated')) {
        console.log(`   ⚠️ Detected not-negotiated error (caps mismatch)`);
      }
      
      resolve({
        name,
        duration,
        expectedDuration,
        playbackPercentage,
        pipelineStarted,
        eosReceived,
        errorOccurred,
        lastProgress
      });
    });
    
    // Kill after timeout
    setTimeout(() => {
      if (!proc.killed) {
        console.log(`⏱️ Timeout reached, stopping test`);
        proc.kill('SIGTERM');
      }
    }, expectedDuration * 1000 + 5000); // Give 5 extra seconds
  });
}

async function runTests() {
  console.log('🔍 GStreamer Full Playback Diagnostic Test');
  console.log('=' .repeat(60));
  
  const testVideo = findTestVideo();
  if (!testVideo) {
    console.error('❌ No test video found!');
    return;
  }
  
  console.log(`📹 Using test video: ${testVideo}`);
  const videoDuration = await getVideoDuration(testVideo);
  
  if (videoDuration === 0) {
    console.error('❌ Could not determine video duration');
    return;
  }
  
  const results = [];
  
  // Test 1: Simple filesrc to fakesink
  results.push(await testPipeline(
    'Simple filesrc → fakesink',
    ['filesrc', `location=${testVideo}`, '!', 'decodebin', '!', 'fakesink'],
    testVideo,
    videoDuration
  ));
  
  // Test 2: With video conversion
  results.push(await testPipeline(
    'With video conversion',
    [
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', 'video/x-raw,width=640,height=480',
      '!', 'fakesink'
    ],
    testVideo,
    videoDuration
  ));
  
  // Test 3: With VP8 encoding
  results.push(await testPipeline(
    'With VP8 encoding',
    [
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', 'video/x-raw,width=640,height=480',
      '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
      '!', 'fakesink'
    ],
    testVideo,
    videoDuration
  ));
  
  // Test 4: With RTP but no rtpbin
  results.push(await testPipeline(
    'With RTP payload (no rtpbin)',
    [
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', 'video/x-raw,width=640,height=480',
      '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
      '!', 'rtpvp8pay',
      '!', 'fakesink'
    ],
    testVideo,
    videoDuration
  ));
  
  // Test 5: With queue
  results.push(await testPipeline(
    'With queue (default settings)',
    [
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'queue',
      '!', 'videoconvert',
      '!', 'fakesink'
    ],
    testVideo,
    videoDuration
  ));
  
  // Test 6: With queue2
  results.push(await testPipeline(
    'With queue2 (use-buffering)',
    [
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'queue2', 'use-buffering=true',
      '!', 'videoconvert',
      '!', 'fakesink'
    ],
    testVideo,
    videoDuration
  ));
  
  // Test 7: With -e flag
  results.push(await testPipeline(
    'With -e flag for EOS',
    [
      '-e',
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'fakesink'
    ],
    testVideo,
    videoDuration
  ));
  
  // Test 8: With rtpbin (simplified)
  results.push(await testPipeline(
    'With rtpbin (video only)',
    [
      'rtpbin', 'name=rtpbin',
      'filesrc', `location=${testVideo}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'vp8enc', 'deadline=1',
      '!', 'rtpvp8pay',
      '!', 'rtpbin.send_rtp_sink_0',
      'rtpbin.send_rtp_src_0',
      '!', 'fakesink'
    ],
    testVideo,
    videoDuration
  ));
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  
  for (const result of results) {
    const status = result.eosReceived ? '✅' : '❌';
    const percentage = result.playbackPercentage;
    console.log(`${status} ${result.name}: ${percentage}% played`);
  }
  
  // Analyze patterns
  console.log('\n🔍 ANALYSIS:');
  
  const fullPlayback = results.filter(r => parseFloat(r.playbackPercentage) > 95);
  const partialPlayback = results.filter(r => parseFloat(r.playbackPercentage) < 95);
  
  if (fullPlayback.length > 0) {
    console.log(`\n✅ Configurations that played fully:`);
    fullPlayback.forEach(r => console.log(`   - ${r.name}`));
  }
  
  if (partialPlayback.length > 0) {
    console.log(`\n❌ Configurations that stopped early:`);
    partialPlayback.forEach(r => console.log(`   - ${r.name} (${r.playbackPercentage}%)`));
  }
  
  // Common patterns
  const rtpbinResults = results.filter(r => r.name.includes('rtpbin'));
  const queueResults = results.filter(r => r.name.includes('queue'));
  const encodingResults = results.filter(r => r.name.includes('VP8') || r.name.includes('RTP'));
  
  console.log(`\n📈 Pattern Analysis:`);
  console.log(`   rtpbin tests: ${rtpbinResults.filter(r => r.eosReceived).length}/${rtpbinResults.length} completed`);
  console.log(`   queue tests: ${queueResults.filter(r => r.eosReceived).length}/${queueResults.length} completed`);
  console.log(`   encoding tests: ${encodingResults.filter(r => r.eosReceived).length}/${encodingResults.length} completed`);
}

runTests().catch(console.error);