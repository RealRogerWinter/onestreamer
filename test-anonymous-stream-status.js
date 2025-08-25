const StreamService = require('./server/services/StreamService');

// Create a mock anonymous streamer scenario
const streamService = new StreamService();

console.log('Testing anonymous streamer visual effects scenario:\n');

// Initial state - no stream
console.log('1. Initial state (no stream):');
console.log('   Stream status:', streamService.getStreamStatus());
console.log('   hasActiveStream:', streamService.getStreamStatus().hasActiveStream);
console.log('   Can use visual effects?', streamService.getStreamStatus().hasActiveStream ? 'YES' : 'NO (blocked)');

console.log('\n2. Anonymous user starts streaming:');
// Simulate anonymous user starting to stream (socket ID without auth)
const anonymousSocketId = 'anonymous-socket-' + Math.random().toString(36).substr(2, 9);
streamService.setStreamer(anonymousSocketId, 'webcam');
console.log('   Set streamer to:', anonymousSocketId);
console.log('   Stream status:', streamService.getStreamStatus());
console.log('   hasActiveStream:', streamService.getStreamStatus().hasActiveStream);
console.log('   Can use visual effects?', streamService.getStreamStatus().hasActiveStream ? 'YES' : 'NO (blocked)');

console.log('\n3. Result:');
if (streamService.getStreamStatus().hasActiveStream) {
  console.log('   ✅ Visual effects SHOULD work for anonymous streamers');
  console.log('   The issue must be elsewhere in the code flow');
} else {
  console.log('   ❌ Visual effects are blocked for anonymous streamers');
  console.log('   Need to fix the stream detection logic');
}

console.log('\n4. Checking what might go wrong:');
console.log('   - Are anonymous streamers calling streamService.setStreamer()? YES (line 5809 in index.js)');
console.log('   - Is hasActiveStream properly checking currentStreamer? YES (line 51 in StreamService.js)');
console.log('   - Are anonymous streamers being cleared prematurely? Need to check...');

// Test clearing
console.log('\n5. Testing if streamer gets cleared:');
const wasStreaming = streamService.getCurrentStreamer();
streamService.clearStreamer();
console.log('   Cleared streamer:', wasStreaming);
console.log('   Stream status after clear:', streamService.getStreamStatus());
console.log('   hasActiveStream:', streamService.getStreamStatus().hasActiveStream);
console.log('   Can use visual effects?', streamService.getStreamStatus().hasActiveStream ? 'YES' : 'NO (blocked)');