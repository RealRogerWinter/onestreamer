const { io } = require('socket.io-client');

async function checkServerDebug() {
  console.log('🔍 Checking server debug output...');
  
  const client = io('http://localhost:8080');
  
  // Wait for connection
  await new Promise(resolve => {
    client.on('connect', () => {
      console.log(`✅ Connected: ${client.id}`);
      resolve();
    });
  });
  
  console.log('🎬 Requesting to stream...');
  client.emit('request-to-stream', { streamType: 'debug' });
  
  client.on('streaming-approved', () => {
    console.log(`✅ Approved to stream: ${client.id}`);
    
    // Set up a timer to check the fallback behavior
    console.log('⏰ Starting 7-second countdown to check fallback...');
    let countdown = 7;
    const timer = setInterval(() => {
      console.log(`⏰ ${countdown}...`);
      countdown--;
      if (countdown <= 0) {
        clearInterval(timer);
        console.log('⏰ Time up! Checking if stream-ready was sent...');
        client.disconnect();
      }
    }, 1000);
  });
  
  client.on('stream-ready', (data) => {
    console.log('🎬 RECEIVED stream-ready:', data);
  });
  
  client.on('takeover-started', (data) => {
    console.log('📢 RECEIVED takeover-started:', data);
  });
  
  // Keep alive for 8 seconds
  setTimeout(() => {
    client.disconnect();
    console.log('🔍 Test completed');
  }, 8000);
}

checkServerDebug().catch(console.error);