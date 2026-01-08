/**
 * Simple GStreamer test to verify sync issues
 */

const { spawn } = require('child_process');

const testFile = 'C:\\onestreamer\\manual_test_video.mp4';
const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';

console.log('🧪 Testing GStreamer with actual file:', testFile);

// Test 1: Simple pipeline without sync
console.log('\n1️⃣ Test without sync (should work):');
const pipeline1 = [
  'filesrc', `location=${testFile}`,
  '!', 'decodebin',
  '!', 'videoconvert',
  '!', 'autovideosink'
];

const proc1 = spawn(gstreamerPath, pipeline1, {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

proc1.stderr.on('data', (data) => {
  const text = data.toString();
  if (text.includes('ERROR')) {
    console.log('❌ Error:', text.slice(0, 200));
  } else if (text.includes('PLAYING')) {
    console.log('✅ Pipeline playing');
  }
});

setTimeout(() => {
  proc1.kill('SIGTERM');
  
  // Test 2: RTP pipeline without sync
  console.log('\n2️⃣ Test RTP without sync:');
  const pipeline2 = [
    'filesrc', `location=${testFile}`,
    '!', 'decodebin',
    '!', 'videoconvert',
    '!', 'videoscale',
    '!', 'video/x-raw,width=640,height=480',
    '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
    '!', 'rtpvp8pay', 'ssrc=11111111', 'pt=96',
    '!', 'udpsink', 'host=127.0.0.1', 'port=5004', 'sync=false', 'async=false'
  ];
  
  const proc2 = spawn(gstreamerPath, pipeline2, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  proc2.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('ERROR')) {
      console.log('❌ Error:', text.slice(0, 200));
    } else if (text.includes('PLAYING')) {
      console.log('✅ RTP pipeline playing');
    }
  });
  
  setTimeout(() => {
    proc2.kill('SIGTERM');
    
    // Test 3: RTP pipeline WITH sync
    console.log('\n3️⃣ Test RTP with sync=true:');
    const pipeline3 = [
      'filesrc', `location=${testFile}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'videoscale',
      '!', 'video/x-raw,width=640,height=480',
      '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
      '!', 'rtpvp8pay', 'ssrc=11111111', 'pt=96',
      '!', 'udpsink', 'host=127.0.0.1', 'port=5004', 'sync=true', 'async=false'
    ];
    
    const proc3 = spawn(gstreamerPath, pipeline3, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let started3 = false;
    proc3.stderr.on('data', (data) => {
      const text = data.toString();
      if (text.includes('ERROR')) {
        console.log('❌ Error:', text.slice(0, 200));
      } else if (text.includes('PLAYING')) {
        started3 = true;
        console.log('✅ RTP with sync=true playing');
      } else if (text.includes('PREROLL')) {
        console.log('📺 Pipeline prerolling...');
      }
    });
    
    setTimeout(() => {
      if (!started3) {
        console.log('⚠️ Pipeline with sync=true did not reach PLAYING state');
      }
      proc3.kill('SIGTERM');
      
      // Test 4: With queue for buffering
      console.log('\n4️⃣ Test with queue and sync:');
      const pipeline4 = [
        'filesrc', `location=${testFile}`,
        '!', 'decodebin',
        '!', 'queue', 'max-size-time=2000000000', // 2 second buffer
        '!', 'videoconvert',
        '!', 'videoscale',
        '!', 'video/x-raw,width=640,height=480',
        '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
        '!', 'rtpvp8pay', 'ssrc=11111111', 'pt=96',
        '!', 'udpsink', 'host=127.0.0.1', 'port=5004', 'sync=true', 'async=false'
      ];
      
      const proc4 = spawn(gstreamerPath, pipeline4, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let started4 = false;
      proc4.stderr.on('data', (data) => {
        const text = data.toString();
        if (text.includes('ERROR')) {
          console.log('❌ Error:', text.slice(0, 200));
        } else if (text.includes('PLAYING')) {
          started4 = true;
          console.log('✅ Queue + sync pipeline playing');
        }
      });
      
      setTimeout(() => {
        if (!started4) {
          console.log('⚠️ Queue + sync pipeline did not reach PLAYING state');
        }
        proc4.kill('SIGTERM');
        console.log('\n✅ Tests complete');
      }, 5000);
    }, 5000);
  }, 5000);
}, 5000);