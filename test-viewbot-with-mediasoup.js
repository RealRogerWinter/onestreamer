const ViewbotService = require('./server/services/ViewbotService');
const MediasoupService = require('./server/services/MediasoupService');

async function testViewBotWithMediaSoup() {
  console.log('🧪 Testing ViewBot with MediaSoup Integration...\n');
  
  try {
    // Initialize MediaSoup service first
    console.log('1. Initializing MediaSoup service...');
    const mediasoupService = new MediasoupService();
    await mediasoupService.initialize();
    
    if (!mediasoupService.router) {
      console.log('⚠️ MediaSoup not available, testing with null service');
    } else {
      console.log('✅ MediaSoup initialized successfully');
    }
    
    // Create ViewBot service with MediaSoup
    console.log('\n2. Creating ViewBot service with MediaSoup integration...');
    const viewbotService = new ViewbotService(mediasoupService);
    
    console.log(`📊 ViewBot mode: ${viewbotService.useWebRTC ? 'WebRTC' : 'HLS'}`);
    
    // Test ViewBot startup
    console.log('\n3. Starting ViewBot with MediaSoup integration...');
    const startResult = await viewbotService.startViewbot({
      config: {
        content: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30
      }
    });
    
    if (!startResult.success) {
      throw new Error(`ViewBot failed to start: ${startResult.message}`);
    }
    
    console.log('✅ ViewBot started with MediaSoup integration');
    console.log(`📊 Stream ID: ${startResult.streamId}`);
    console.log(`🎭 Mode: ${startResult.mode}`);
    
    if (startResult.producerInfo) {
      console.log('🎬 Producer info:', startResult.producerInfo);
    }
    
    // Monitor for 5 seconds
    console.log('\n4. Monitoring ViewBot with MediaSoup for 5 seconds...');
    
    const monitorInterval = setInterval(() => {
      const status = viewbotService.getViewbotStatus();
      const uptimeSeconds = Math.floor(status.duration / 1000);
      console.log(`📊 ViewBot: ${status.isActive ? 'Active' : 'Inactive'} | Uptime: ${uptimeSeconds}s | MediaSoup: ${status.hasMediaSoupProducer ? 'Connected' : 'Disconnected'}`);
      
      if (status.webrtcStatus) {
        console.log(`🤖 WebRTC Bots: ${status.webrtcStatus.runningBots}/${status.webrtcStatus.totalBots} running`);
      }
    }, 1000);
    
    // Stop after 5 seconds
    setTimeout(async () => {
      clearInterval(monitorInterval);
      
      console.log('\n5. Stopping ViewBot with MediaSoup integration...');
      const stopResult = await viewbotService.stopViewbot();
      
      if (stopResult.success) {
        console.log(`✅ ViewBot stopped: ${stopResult.streamId}`);
      } else {
        console.log(`❌ ViewBot stop failed: ${stopResult.message}`);
      }
      
      console.log('\n🎉 ViewBot + MediaSoup integration test completed!');
      console.log('\n📊 Test Results:');
      console.log(`  ✅ ViewBot creation: ${startResult.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(`  ✅ MediaSoup integration: ${startResult.producerInfo ? 'SUCCESS' : 'N/A'}`);
      console.log(`  ✅ Stream mode: ${startResult.mode || 'unknown'}`);
      console.log(`  ✅ ViewBot stopping: ${stopResult.success ? 'SUCCESS' : 'FAILED'}`);
      
      process.exit(0);
    }, 5000);
    
  } catch (error) {
    console.error('❌ ViewBot + MediaSoup test failed:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run the test
testViewBotWithMediaSoup();