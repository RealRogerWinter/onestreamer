const { io } = require('socket.io-client');
const fetch = require('http').get;

console.log('🔍 DEBUG: Checking server state and fallback behavior...');

async function debugServerState() {
  const streamer = io('http://localhost:8080');
  
  await new Promise((resolve) => {
    streamer.on('connect', () => {
      console.log(`✅ Connected as: ${streamer.id}`);
      resolve();
    });
  });
  
  streamer.on('streaming-approved', () => {
    console.log(`🎯 Streaming approved for: ${streamer.id}`);
    console.log(`⏳ Monitoring server state for 8 seconds...`);
  });
  
  // Monitor for events
  streamer.on('takeover-started', (data) => {
    console.log(`📢 takeover-started: ${JSON.stringify(data)}`);
  });
  
  streamer.on('stream-ready', (data) => {
    console.log(`🎬 stream-ready: ${JSON.stringify(data)}`);
  });
  
  console.log('\n🎬 Requesting to stream (no MediaSoup setup)...');
  streamer.emit('request-to-stream', { streamType: 'debug-test' });
  
  // Wait and observe
  await new Promise(resolve => setTimeout(resolve, 8000));
  
  console.log('\n🔍 Final state check complete');
  streamer.disconnect();
}

debugServerState().catch(console.error);