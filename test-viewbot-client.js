/**
 * Test ViewBot Socket.IO Client Connection
 */

const ViewBotSocketClient = require('./server/services/ViewBotSocketClient');

async function testViewBot() {
  console.log('🧪 Testing ViewBot Socket.IO Client Connection\n');
  
  // Create a test ViewBot with a video file
  const bot = new ViewBotSocketClient('test-bot-1', 'https://127.0.0.1:8443', '/root/onestreamer/videos/test-video-short.mp4');
  
  try {
    console.log('1️⃣ Connecting to server...');
    await bot.connect();
    console.log('✅ Connected successfully!\n');
    
    console.log('2️⃣ Starting streaming...');
    await bot.startStreaming();
    console.log('✅ Streaming started!\n');
    
    // Let it stream for 10 seconds
    console.log('3️⃣ Streaming for 10 seconds...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    console.log('4️⃣ Stopping stream...');
    await bot.stopStreaming();
    console.log('✅ Stream stopped!\n');
    
    console.log('🎉 Test completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    bot.cleanup();
    process.exit(1);
  }
}

// Run the test
testViewBot();