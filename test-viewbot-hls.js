const ViewBotFFmpegService = require('./server/services/ViewBotFFmpegService');

async function testViewBotHLS() {
  console.log('🧪 Testing ViewBot HLS Streaming...\n');
  
  const ffmpegService = new ViewBotFFmpegService();
  const botId = 'test-bot-' + Date.now();
  
  console.log(`📺 Starting ViewBot stream with ID: ${botId}`);
  
  const result = ffmpegService.startStreaming(botId, {
    pattern: 'testsrc2',
    width: 1280,
    height: 720,
    frameRate: 30
  });
  
  if (result.success) {
    console.log(`✅ Stream started successfully!`);
    console.log(`📍 HLS URL: ${result.hlsUrl}`);
    console.log(`🌐 Access the stream at: http://localhost:8080${result.hlsUrl}`);
    console.log(`\n⏱️  Stream will run for 30 seconds...\n`);
    
    // Check status every 5 seconds
    const statusInterval = setInterval(() => {
      const status = ffmpegService.getStatus(botId);
      if (status.active) {
        const uptimeSeconds = Math.floor(status.uptime / 1000);
        console.log(`📊 Stream status: Active for ${uptimeSeconds} seconds`);
      }
    }, 5000);
    
    // Stop after 30 seconds
    setTimeout(() => {
      clearInterval(statusInterval);
      console.log('\n🛑 Stopping stream...');
      const stopResult = ffmpegService.stopStreaming(botId);
      if (stopResult.success) {
        console.log('✅ Stream stopped successfully');
      } else {
        console.log('❌ Failed to stop stream:', stopResult.message);
      }
      process.exit(0);
    }, 30000);
    
  } else {
    console.log('❌ Failed to start stream:', result.message);
    process.exit(1);
  }
}

// Run the test
testViewBotHLS().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});