// Comprehensive WebRTC flow test
const io = require('socket.io-client');

console.log('🔍 WebRTC Debug Test - Tracing Complete Flow...\n');

let streamerSocket, viewerSocket;
let step = 1;

function logStep(message) {
  console.log(`${step++}. ${message}`);
}

// Create streamer connection
streamerSocket = io('http://localhost:8080');
viewerSocket = io('http://localhost:8080');

streamerSocket.on('connect', () => {
  logStep(`✅ Streamer connected: ${streamerSocket.id}`);
  
  setTimeout(() => {
    streamerSocket.emit('request-to-stream', { streamType: 'webcam' });
    logStep('🎥 Streamer requested to stream');
  }, 500);
});

viewerSocket.on('connect', () => {
  logStep(`✅ Viewer connected: ${viewerSocket.id}`);
  viewerSocket.emit('join-as-viewer');
  logStep('👁️ Viewer joined as viewer');
});

// Track the complete flow
streamerSocket.on('streaming-approved', () => {
  logStep('✅ STREAMER: Got streaming-approved');
});

viewerSocket.on('stream-status', (status) => {
  logStep(`📊 VIEWER: Got stream-status - hasActiveStream: ${status.hasActiveStream}, streamerId: ${status.streamerId}`);
});

viewerSocket.on('new-streamer', (data) => {
  logStep(`📡 VIEWER: Got new-streamer event - streamerId: ${data.streamerId}`);
  logStep(`🎯 VIEWER: Should now request stream from streamer`);
});

// Server should route this message
viewerSocket.on('viewer-requesting-stream', (data) => {
  logStep(`❌ ERROR: Viewer received viewer-requesting-stream (should go to streamer)`);
});

streamerSocket.on('viewer-requesting-stream', (data) => {
  logStep(`👁️ STREAMER: Got viewer-requesting-stream from ${data.viewerId}`);
  logStep(`🔧 STREAMER: Should create peer connection and send offer`);
});

// Track WebRTC signaling
streamerSocket.on('request-stream', (data) => {
  logStep(`❌ ERROR: Streamer got request-stream (should go to server)`);
});

viewerSocket.on('stream-offer', (data) => {
  logStep(`📨 VIEWER: Got stream-offer from ${data.fromStreamerId}`);
  logStep(`🔧 VIEWER: Should create answer and send back`);
});

streamerSocket.on('stream-answer', (data) => {
  logStep(`📨 STREAMER: Got stream-answer from ${data.fromViewerId}`);
  logStep(`🔧 STREAMER: Should set remote description`);
});

// Track ICE candidates
let iceCount = 0;
streamerSocket.on('ice-candidate', (data) => {
  iceCount++;
  logStep(`🧊 STREAMER: Got ICE candidate #${iceCount} from ${data.fromSocketId}`);
});

viewerSocket.on('ice-candidate', (data) => {
  iceCount++;
  logStep(`🧊 VIEWER: Got ICE candidate #${iceCount} from ${data.fromSocketId}`);
});

// Error tracking
streamerSocket.on('error', (error) => {
  logStep(`❌ STREAMER ERROR: ${error}`);
});

viewerSocket.on('error', (error) => {
  logStep(`❌ VIEWER ERROR: ${error}`);
});

// Cleanup and analysis
setTimeout(() => {
  console.log('\n📋 ANALYSIS:');
  console.log('Expected flow:');
  console.log('1. Streamer connects ✅');
  console.log('2. Viewer connects ✅'); 
  console.log('3. Streamer requests to stream ✅');
  console.log('4. Streamer gets streaming-approved ✅');
  console.log('5. Viewer gets new-streamer event ✅');
  console.log('6. Viewer automatically requests stream (client-side)');
  console.log('7. Server routes request to streamer');
  console.log('8. Streamer gets viewer-requesting-stream ❓');
  console.log('9. Streamer sends offer to viewer ❓');
  console.log('10. Viewer gets stream-offer ❓');
  console.log('11. Viewer sends answer to streamer ❓');
  console.log('12. Streamer gets stream-answer ❓');
  console.log('13. ICE candidates exchanged ❓');
  
  console.log(`\n🧊 ICE candidates exchanged: ${iceCount}`);
  
  if (iceCount === 0) {
    console.log('❌ No ICE candidates = WebRTC handshake never started');
  } else if (iceCount < 4) {
    console.log('⚠️ Few ICE candidates = Handshake may have failed');  
  } else {
    console.log('✅ Good ICE candidate exchange');
  }
  
  streamerSocket.disconnect();
  viewerSocket.disconnect();
  process.exit(0);
}, 5000);