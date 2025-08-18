/**
 * Debug script to understand why sync=true breaks video display
 * We'll test different sync configurations
 */

const { spawn } = require('child_process');
const path = require('path');

const testConfigurations = [
  {
    name: 'No sync (working baseline)',
    videoSync: 'sync=false',
    audioSync: 'sync=false'
  },
  {
    name: 'Video sync only',
    videoSync: 'sync=true',
    audioSync: 'sync=false'
  },
  {
    name: 'Audio sync only',
    videoSync: 'sync=false',
    audioSync: 'sync=true'
  },
  {
    name: 'Both sync',
    videoSync: 'sync=true',
    audioSync: 'sync=true'
  },
  {
    name: 'Sync with async=true',
    videoSync: 'sync=true async=true',
    audioSync: 'sync=true async=true'
  },
  {
    name: 'Sync with do-timestamp',
    videoSync: 'sync=true do-timestamp=true',
    audioSync: 'sync=true do-timestamp=true'
  }
];

async function testSyncConfiguration(config, videoFile) {
  console.log(`\n🧪 Testing: ${config.name}`);
  console.log(`   Video: ${config.videoSync}`);
  console.log(`   Audio: ${config.audioSync}`);
  
  const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  
  // Simple test pipeline
  const pipeline = [
    // Video test
    'filesrc', `location=${videoFile}`,
    '!', 'decodebin',
    '!', 'videoconvert',
    '!', 'videoscale',
    '!', 'video/x-raw,width=640,height=480',
    '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
    '!', 'rtpvp8pay', 'ssrc=11111111', 'pt=96',
    '!', 'udpsink', 'host=127.0.0.1', 'port=5004', config.videoSync
  ];
  
  return new Promise((resolve) => {
    const process = spawn(gstreamerPath, pipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let output = '';
    let started = false;
    let hasError = false;
    
    process.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      
      if (text.includes('ERROR')) {
        hasError = true;
        console.log(`   ❌ Error detected`);
      } else if (text.includes('PLAYING')) {
        started = true;
        console.log(`   ✅ Pipeline playing`);
      } else if (text.includes('Buffering')) {
        console.log(`   ⏳ Buffering...`);
      } else if (text.includes('PREROLL')) {
        console.log(`   📺 Prerolled`);
      }
    });
    
    // Test for 5 seconds
    setTimeout(() => {
      if (process && !process.killed) {
        process.kill('SIGTERM');
      }
      
      console.log(`   Result: ${started ? '✅ Started' : '❌ Failed to start'}`);
      if (hasError) {
        console.log(`   Last error: ${output.slice(-500)}`);
      }
      
      resolve({ config: config.name, started, hasError });
    }, 5000);
  });
}

async function runTests() {
  console.log('🔍 GStreamer Sync Debug Test');
  console.log('==============================');
  
  const testFile = 'C:\\onestreamer\\content\\videos\\example-gameplay.mp4';
  const results = [];
  
  for (const config of testConfigurations) {
    const result = await testSyncConfiguration(config, testFile);
    results.push(result);
    
    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n📊 Summary:');
  console.log('============');
  for (const result of results) {
    console.log(`${result.started ? '✅' : '❌'} ${result.config}`);
  }
  
  // Now test with queue elements
  console.log('\n🧪 Testing with queue elements...');
  
  const queuePipeline = [
    'filesrc', `location=${testFile}`,
    '!', 'decodebin',
    '!', 'queue', 'max-size-time=1000000000', // 1 second buffer
    '!', 'videoconvert',
    '!', 'videoscale',
    '!', 'video/x-raw,width=640,height=480',
    '!', 'vp8enc', 'deadline=1', 'cpu-used=8',
    '!', 'rtpvp8pay', 'ssrc=11111111', 'pt=96',
    '!', 'udpsink', 'host=127.0.0.1', 'port=5004', 'sync=true'
  ];
  
  const queueProcess = spawn(gstreamerPath, queuePipeline, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  let queueStarted = false;
  queueProcess.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('PLAYING')) {
      queueStarted = true;
      console.log('   ✅ Queue pipeline playing');
    }
  });
  
  await new Promise(resolve => setTimeout(resolve, 5000));
  queueProcess.kill('SIGTERM');
  
  console.log(`   Queue test result: ${queueStarted ? '✅ Works with queue' : '❌ Failed with queue'}`);
  
  // Test with clock settings
  console.log('\n🧪 Testing clock configurations...');
  
  const clockTests = [
    { name: 'System clock', params: 'sync=true provide-clock=false' },
    { name: 'Provide clock', params: 'sync=true provide-clock=true' },
    { name: 'No sync clock', params: 'sync=false provide-clock=true' }
  ];
  
  for (const test of clockTests) {
    console.log(`   Testing: ${test.name}`);
    const clockPipeline = [
      'filesrc', `location=${testFile}`,
      '!', 'decodebin',
      '!', 'videoconvert',
      '!', 'vp8enc', 'deadline=1',
      '!', 'rtpvp8pay', 'ssrc=11111111',
      '!', 'udpsink', 'host=127.0.0.1', 'port=5004', ...test.params.split(' ')
    ];
    
    const proc = spawn(gstreamerPath, clockPipeline, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let started = false;
    proc.stderr.on('data', (data) => {
      if (data.toString().includes('PLAYING')) started = true;
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    proc.kill('SIGTERM');
    console.log(`   Result: ${started ? '✅' : '❌'}`);
  }
}

const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';

runTests().catch(console.error);