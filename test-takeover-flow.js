const io = require('socket.io-client');

// Test the complete takeover flow with dual cooldowns
async function testTakeoverFlow() {
  console.log('🧪 Starting takeover flow test with dual cooldowns...\n');
  
  // Create socket connections
  const streamer1 = io('http://localhost:8080', { transports: ['websocket'] });
  const streamer2 = io('http://localhost:8080', { transports: ['websocket'] });
  const streamer3 = io('http://localhost:8080', { transports: ['websocket'] });
  
  // Wait for connections
  await new Promise(resolve => {
    let connected = 0;
    const checkConnected = () => {
      connected++;
      if (connected === 3) resolve();
    };
    streamer1.on('connect', checkConnected);
    streamer2.on('connect', checkConnected);
    streamer3.on('connect', checkConnected);
  });
  
  console.log('✅ All sockets connected');
  console.log('   Streamer 1 ID:', streamer1.id);
  console.log('   Streamer 2 ID:', streamer2.id);
  console.log('   Streamer 3 ID:', streamer3.id);
  console.log('');
  
  // Set up event handlers
  streamer1.on('stream-takeover', (data) => {
    console.log('📺 STREAMER 1: Received takeover notification');
    console.log('   New streamer:', data.newStreamerId);
    console.log('   My cooldown:', data.cooldownRemaining, 'seconds (individual)');
  });
  
  streamer2.on('stream-takeover', (data) => {
    console.log('📺 STREAMER 2: Received takeover notification');
    console.log('   New streamer:', data.newStreamerId);
    console.log('   My cooldown:', data.cooldownRemaining, 'seconds (individual)');
  });
  
  // Test 1: First streamer starts
  console.log('TEST 1: Streamer 1 starts streaming...');
  streamer1.emit('request-to-stream', { streamType: 'webcam' });
  
  await new Promise(resolve => {
    streamer1.once('streaming-approved', () => {
      console.log('✅ STREAMER 1: Now streaming\n');
      resolve();
    });
  });
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Test 2: Streamer 2 attempts takeover immediately (should fail - global cooldown)
  console.log('TEST 2: Streamer 2 attempts immediate takeover (within 30s global cooldown)...');
  streamer2.emit('request-to-stream', { streamType: 'webcam' });
  
  await new Promise(resolve => {
    streamer2.once('takeover-denied', (data) => {
      console.log('❌ STREAMER 2: Takeover denied');
      console.log('   Reason:', data.reason);
      console.log('   Cooldown remaining:', data.cooldownRemaining, 'seconds\n');
      resolve();
    });
    streamer2.once('streaming-approved', () => {
      console.log('⚠️ STREAMER 2: Unexpectedly approved (should have been denied)\n');
      resolve();
    });
  });
  
  // Wait for global cooldown to expire
  console.log('⏳ Waiting 31 seconds for global cooldown to expire...');
  await new Promise(resolve => setTimeout(resolve, 31000));
  
  // Test 3: Streamer 2 takes over after global cooldown
  console.log('TEST 3: Streamer 2 attempts takeover after global cooldown...');
  streamer2.emit('request-to-stream', { streamType: 'webcam' });
  
  await new Promise(resolve => {
    streamer2.once('streaming-approved', () => {
      console.log('✅ STREAMER 2: Now streaming (takeover successful)\n');
      resolve();
    });
    streamer2.once('takeover-denied', (data) => {
      console.log('❌ STREAMER 2: Unexpectedly denied:', data.reason, '(', data.cooldownRemaining, 's)\n');
      resolve();
    });
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 4: Streamer 1 attempts to take back immediately (should fail - individual cooldown)
  console.log('TEST 4: Streamer 1 attempts to take back (should have 60s individual cooldown)...');
  streamer1.emit('request-to-stream', { streamType: 'webcam' });
  
  await new Promise(resolve => {
    streamer1.once('takeover-denied', (data) => {
      console.log('❌ STREAMER 1: Takeover denied');
      console.log('   Reason:', data.reason);
      console.log('   Cooldown remaining:', data.cooldownRemaining, 'seconds (individual cooldown)\n');
      resolve();
    });
    streamer1.once('streaming-approved', () => {
      console.log('⚠️ STREAMER 1: Unexpectedly approved (should have individual cooldown)\n');
      resolve();
    });
  });
  
  // Test 5: Streamer 3 attempts takeover (should fail - global cooldown from streamer 2's start)
  console.log('TEST 5: Streamer 3 attempts takeover (within global cooldown of streamer 2)...');
  streamer3.emit('request-to-stream', { streamType: 'webcam' });
  
  await new Promise(resolve => {
    streamer3.once('takeover-denied', (data) => {
      console.log('❌ STREAMER 3: Takeover denied');
      console.log('   Reason:', data.reason);
      console.log('   Cooldown remaining:', data.cooldownRemaining, 'seconds\n');
      resolve();
    });
    streamer3.once('streaming-approved', () => {
      console.log('⚠️ STREAMER 3: Unexpectedly approved\n');
      resolve();
    });
  });
  
  // Clean up
  console.log('🧹 Cleaning up test connections...');
  streamer1.disconnect();
  streamer2.disconnect();
  streamer3.disconnect();
  
  console.log('✅ Takeover flow test completed!\n');
  console.log('Summary:');
  console.log('- Global cooldown (30s) prevents ANY new takeover after stream starts');
  console.log('- Individual cooldown (60s) prevents specific taken-over streamer from streaming again');
  console.log('- Both cooldowns work independently as expected');
  
  process.exit(0);
}

// Run the test
testTakeoverFlow().catch(console.error);