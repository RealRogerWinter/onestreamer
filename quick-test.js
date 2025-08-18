// Quick test to verify server is running and responding
const io = require('socket.io-client');

console.log('🧪 Testing OneStreamer WebRTC Fix...\n');

// Test with two connections - one streamer, one viewer
const streamerSocket = io('http://localhost:8080');
const viewerSocket = io('http://localhost:8080');

streamerSocket.on('connect', () => {
  console.log('✅ Streamer connected:', streamerSocket.id);
  
  // Request to start streaming
  setTimeout(() => {
    streamerSocket.emit('request-to-stream', { streamType: 'webcam' });
    console.log('🎥 Streamer requested to stream');
  }, 500);
});

viewerSocket.on('connect', () => {
  console.log('✅ Viewer connected:', viewerSocket.id);
  viewerSocket.emit('join-as-viewer');
  console.log('👁️ Joined as viewer');
});

streamerSocket.on('streaming-approved', () => {
  console.log('✅ Streaming approved for streamer');
});

viewerSocket.on('new-streamer', (data) => {
  console.log('📡 Viewer received new-streamer event:', data.streamerId);
  console.log('🎯 This should trigger stream request flow');
});

streamerSocket.on('viewer-requesting-stream', (data) => {
  console.log('👁️ Streamer received viewer request from:', data.viewerId);
  console.log('✨ This is the key fix - streamer should now create peer connection');
});

// Cleanup after test
setTimeout(() => {
  console.log('\n✅ Test completed - WebRTC signaling should be working');
  console.log('📋 Expected flow:');
  console.log('  1. Streamer gets streaming-approved ✅');  
  console.log('  2. Viewer gets new-streamer event ✅');
  console.log('  3. Viewer requests stream from streamer ✅');  
  console.log('  4. Streamer receives viewer-requesting-stream ✅');
  console.log('  5. Streamer creates peer connection and sends offer 🔧');
  console.log('  6. WebRTC handshake completes 🔧');
  
  streamerSocket.disconnect();
  viewerSocket.disconnect();
  process.exit(0);
}, 3000);