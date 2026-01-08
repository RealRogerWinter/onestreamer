const io = require('socket.io-client');

// Test stream switching functionality
async function testStreamSwitch() {
  console.log('🧪 Starting stream switch test...\n');
  
  // Create two socket connections (simulating two users)
  const streamer1 = io('http://localhost:8080', { transports: ['websocket'] });
  const streamer2 = io('http://localhost:8080', { transports: ['websocket'] });
  const viewer = io('http://localhost:8080', { transports: ['websocket'] });
  
  // Wait for connections
  await new Promise(resolve => {
    let connected = 0;
    const checkConnected = () => {
      connected++;
      if (connected === 3) resolve();
    };
    streamer1.on('connect', checkConnected);
    streamer2.on('connect', checkConnected);
    viewer.on('connect', checkConnected);
  });
  
  console.log('✅ All sockets connected\n');
  
  // Set up viewer
  viewer.emit('join-as-viewer');
  viewer.on('new-streamer', (data) => {
    console.log('👀 VIEWER: New streamer detected:', data.streamerId);
  });
  viewer.on('stream-ended', () => {
    console.log('👀 VIEWER: Stream ended');
  });
  
  // Test 1: First streamer starts
  console.log('📹 TEST 1: First streamer requests to stream...');
  streamer1.emit('request-to-stream', { streamType: 'webcam' });
  
  streamer1.on('streaming-approved', () => {
    console.log('✅ STREAMER 1: Approved to stream');
  });
  
  streamer1.on('stream-takeover', (data) => {
    console.log('⚠️ STREAMER 1: Stream taken over by:', data.newStreamerId);
    console.log('   Cooldown:', data.cooldownRemaining, 'seconds');
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 2: Second streamer attempts takeover
  console.log('\n📹 TEST 2: Second streamer attempts takeover...');
  streamer2.emit('request-to-stream', { streamType: 'webcam' });
  
  streamer2.on('streaming-approved', () => {
    console.log('✅ STREAMER 2: Approved to stream (takeover successful)');
  });
  
  streamer2.on('takeover-denied', (data) => {
    console.log('❌ STREAMER 2: Takeover denied -', data.reason);
    console.log('   Cooldown remaining:', data.cooldownRemaining, 'seconds');
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 3: First streamer attempts to take back (should be in cooldown)
  console.log('\n📹 TEST 3: First streamer attempts to take back (should fail due to cooldown)...');
  streamer1.emit('request-to-stream', { streamType: 'webcam' });
  
  streamer1.on('takeover-denied', (data) => {
    console.log('❌ STREAMER 1: Takeover denied -', data.reason);
    console.log('   Cooldown remaining:', data.cooldownRemaining, 'seconds');
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 4: Second streamer stops
  console.log('\n📹 TEST 4: Second streamer stops streaming...');
  streamer2.emit('stop-streaming');
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Clean up
  console.log('\n🧹 Cleaning up test connections...');
  streamer1.disconnect();
  streamer2.disconnect();
  viewer.disconnect();
  
  console.log('✅ Stream switch test completed!\n');
  process.exit(0);
}

// Run the test
testStreamSwitch().catch(console.error);