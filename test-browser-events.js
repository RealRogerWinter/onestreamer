const { io } = require('socket.io-client');

console.log('🌐 BROWSER EVENT TEST: Testing if events reach browser clients...');

async function testBrowserEvents() {
  const client = io('http://localhost:8080');
  
  await new Promise(resolve => {
    client.on('connect', () => {
      console.log(`✅ Browser client connected: ${client.id}`);
      resolve();
    });
  });

  // Listen for all the key events
  client.on('takeover-started', (data) => {
    console.log('📢 BROWSER: Received takeover-started:', data);
  });

  client.on('stream-ready', (data) => {
    console.log('🎬 BROWSER: Received stream-ready:', data);
  });

  client.on('global-cooldown', (data) => {
    console.log('⏰ BROWSER: Received global-cooldown:', data);
  });

  console.log('🎯 Starting takeover test...');
  client.emit('request-to-stream', { streamType: 'browser-test' });
  
  // Wait for full cycle
  console.log('⏳ Waiting 8 seconds for complete cycle...');
  await new Promise(resolve => setTimeout(resolve, 8000));

  console.log('✅ Browser event test complete');
  client.disconnect();
}

testBrowserEvents().catch(console.error);