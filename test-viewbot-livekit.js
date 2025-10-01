#!/usr/bin/env node

/**
 * Test ViewBot with LiveKit via rotation services
 */

const io = require('socket.io-client');

async function testViewBotLiveKit() {
  console.log('🧪 Testing ViewBot with LiveKit mode...\n');
  
  // Connect to the server
  const socket = io('https://onestreamer.live', {
    transports: ['websocket'],
    reconnection: false
  });
  
  return new Promise((resolve, reject) => {
    socket.on('connect', () => {
      console.log('✅ Connected to server');
      
      // Request to create a ViewBot
      const botId = `test-viewbot-${Date.now()}`;
      const videoFile = '/root/onestreamer/server/uploads/test_10sec.mp4';
      
      console.log(`🤖 Creating ViewBot ${botId}...`);
      console.log(`📹 Video file: ${videoFile}\n`);
      
      socket.emit('admin-create-viewbot', {
        botId: botId,
        videoFile: videoFile
      });
      
      // Listen for ViewBot creation response
      socket.on('viewbot-created', (data) => {
        console.log('✅ ViewBot created:', data);
        
        // Let it run for 30 seconds
        console.log('\n⏰ Letting ViewBot stream for 30 seconds...');
        console.log('   Check https://onestreamer.live to see the ViewBot in the room!\n');
        
        setTimeout(() => {
          console.log('⏹️ Stopping ViewBot...');
          
          socket.emit('admin-stop-viewbot', { botId: botId });
          
          socket.on('viewbot-stopped', (data) => {
            console.log('✅ ViewBot stopped:', data);
            socket.disconnect();
            resolve();
          });
        }, 30000);
      });
      
      socket.on('error', (error) => {
        console.error('❌ Socket error:', error);
        socket.disconnect();
        reject(error);
      });
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error.message);
      reject(error);
    });
  });
}

// Run the test
testViewBotLiveKit()
  .then(() => {
    console.log('\n✅ Test completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });