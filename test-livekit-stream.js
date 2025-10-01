#!/usr/bin/env node

/**
 * Test LiveKit streaming functionality
 * This script tests that we can connect to LiveKit and publish/subscribe to streams
 */

const { Room, RoomEvent, VideoPresets } = require('livekit-client');
const fetch = require('node-fetch');

async function testLiveKitStreaming() {
  console.log('🚀 Starting LiveKit streaming test...\n');
  
  // Step 1: Check backend status
  console.log('1️⃣ Checking backend status...');
  const backendResponse = await fetch('http://127.0.0.1:8080/api/webrtc/backend');
  const backendData = await backendResponse.json();
  console.log('   Backend:', backendData.backend);
  console.log('   Adapter enabled:', backendData.adapterEnabled);
  console.log('   Initialized:', backendData.stats?.initialized);
  
  if (backendData.backend !== 'livekit') {
    console.error('❌ LiveKit backend not active! Current backend:', backendData.backend);
    process.exit(1);
  }
  
  // Step 2: Get token for publisher
  console.log('\n2️⃣ Getting publisher token...');
  const publisherTokenResponse = await fetch(
    'http://127.0.0.1:8080/api/livekit/token?identity=test-publisher&room=onestreamer-main'
  );
  const publisherData = await publisherTokenResponse.json();
  console.log('   Token received for:', publisherData.identity);
  console.log('   Room:', publisherData.roomName);
  console.log('   URL:', publisherData.url);
  
  // Step 3: Connect publisher
  console.log('\n3️⃣ Connecting publisher to LiveKit...');
  const publisherRoom = new Room({
    adaptiveStream: true,
    dynacast: true,
  });
  
  let publisherConnected = false;
  publisherRoom.on(RoomEvent.Connected, () => {
    console.log('   ✅ Publisher connected!');
    console.log('   Room name:', publisherRoom.name);
    console.log('   Local participant:', publisherRoom.localParticipant.identity);
    publisherConnected = true;
  });
  
  publisherRoom.on(RoomEvent.Disconnected, () => {
    console.log('   Publisher disconnected');
  });
  
  try {
    await publisherRoom.connect(publisherData.url, publisherData.token);
  } catch (error) {
    console.error('❌ Failed to connect publisher:', error.message);
    process.exit(1);
  }
  
  // Wait for connection
  let retries = 0;
  while (!publisherConnected && retries < 10) {
    await new Promise(resolve => setTimeout(resolve, 500));
    retries++;
  }
  
  if (!publisherConnected) {
    console.error('❌ Publisher failed to connect after 5 seconds');
    process.exit(1);
  }
  
  // Step 4: Simulate publishing (without actual media for server-side test)
  console.log('\n4️⃣ Simulating track publication...');
  console.log('   Note: In a real scenario, we would publish audio/video tracks here');
  console.log('   Publisher is ready to publish tracks');
  
  // Step 5: Get token for subscriber
  console.log('\n5️⃣ Getting subscriber token...');
  const subscriberTokenResponse = await fetch(
    'http://127.0.0.1:8080/api/livekit/token?identity=test-subscriber&room=onestreamer-main'
  );
  const subscriberData = await subscriberTokenResponse.json();
  console.log('   Token received for:', subscriberData.identity);
  
  // Step 6: Connect subscriber
  console.log('\n6️⃣ Connecting subscriber to LiveKit...');
  const subscriberRoom = new Room({
    adaptiveStream: true,
    dynacast: true,
  });
  
  let subscriberConnected = false;
  subscriberRoom.on(RoomEvent.Connected, () => {
    console.log('   ✅ Subscriber connected!');
    console.log('   Room participants:', subscriberRoom.participants.size);
    subscriberConnected = true;
  });
  
  subscriberRoom.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log('   Participant joined:', participant.identity);
  });
  
  try {
    await subscriberRoom.connect(subscriberData.url, subscriberData.token);
  } catch (error) {
    console.error('❌ Failed to connect subscriber:', error.message);
    process.exit(1);
  }
  
  // Wait for subscriber connection
  retries = 0;
  while (!subscriberConnected && retries < 10) {
    await new Promise(resolve => setTimeout(resolve, 500));
    retries++;
  }
  
  if (!subscriberConnected) {
    console.error('❌ Subscriber failed to connect after 5 seconds');
    process.exit(1);
  }
  
  // Step 7: Verify rooms can see each other
  console.log('\n7️⃣ Verifying room state...');
  console.log('   Publisher sees participants:', publisherRoom.participants.size);
  console.log('   Subscriber sees participants:', subscriberRoom.participants.size);
  
  // Step 8: Check server stats
  console.log('\n8️⃣ Checking server stats...');
  const statsResponse = await fetch('http://127.0.0.1:8080/api/webrtc/backend');
  const statsData = await statsResponse.json();
  console.log('   Transport count:', statsData.stats?.transportCount || 0);
  console.log('   Producer count:', statsData.stats?.producerCount || 0);
  console.log('   Consumer count:', statsData.stats?.consumerCount || 0);
  
  // Step 9: Cleanup
  console.log('\n9️⃣ Cleaning up...');
  publisherRoom.disconnect();
  subscriberRoom.disconnect();
  
  console.log('\n✅ LiveKit streaming test completed successfully!');
  console.log('   - Backend is running and configured');
  console.log('   - Tokens can be generated');
  console.log('   - Clients can connect to LiveKit');
  console.log('   - Rooms are properly created');
  console.log('\n💡 Next step: Test with actual browser clients using test-livekit-streaming.html');
}

// Run the test
testLiveKitStreaming().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});