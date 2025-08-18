const { io } = require('socket.io-client');

console.log('🧪 FALLBACK TEST: Testing stream-ready fallback mechanism...');

async function testFallbackFlow() {
  const streamer = io('http://localhost:8080');
  const viewer = io('http://localhost:8080');
  
  streamer.on('connect', () => {
    console.log(`✅ Streamer connected: ${streamer.id}`);
  });
  
  viewer.on('connect', () => {
    console.log(`✅ Viewer connected: ${viewer.id}`);
  });
  
  // Viewer listens for takeover and stream-ready events
  viewer.on('takeover-started', (data) => {
    console.log(`📢 VIEWER: Received takeover-started from ${data.newStreamerId}`);
  });
  
  viewer.on('stream-ready', (data) => {
    console.log(`🎬 VIEWER: Received stream-ready:`, {
      streamerId: data.streamerId,
      isWebRTC: data.isWebRTC,
      hasVideo: data.hasVideo,
      hasAudio: data.hasAudio,
      fallback: data.fallback,
      producerVerified: data.producerVerified
    });
  });
  
  streamer.on('streaming-approved', () => {
    console.log(`🎯 STREAMER: Approved to stream - NOT creating MediaSoup producers (simulating non-WebRTC stream)`);
    console.log(`⏳ STREAMER: Waiting for 6-second fallback mechanism...`);
  });
  
  // Wait for connections
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Streamer requests to stream but doesn't create producers (simulates the issue)
  console.log('\n🎬 STREAMER: Requesting to stream...');
  streamer.emit('request-to-stream', { streamType: 'test' });
  
  // Wait 8 seconds to see fallback mechanism
  await new Promise(resolve => setTimeout(resolve, 8000));
  
  console.log('\n🧪 TEST COMPLETE');
  streamer.disconnect();
  viewer.disconnect();
}

testFallbackFlow().catch(console.error);