const ViewBotWebRTCService = require('./server/services/ViewBotWebRTCService');

async function testWebRTCViewBot() {
  console.log('🧪 Testing WebRTC ViewBot Service...\n');
  
  try {
    // Create service instance (no MediaSoup for testing)
    const service = new ViewBotWebRTCService(null);
    
    console.log('1. Creating WebRTC ViewBot...');
    const createResult = await service.createViewBot({
      pattern: 'testsrc2',
      width: 1280,
      height: 720,
      frameRate: 30,
      customText: 'Test ViewBot Stream'
    });
    
    if (!createResult.success) {
      throw new Error(`Failed to create ViewBot: ${createResult.message}`);
    }
    
    const botId = createResult.botId;
    console.log(`✅ ViewBot created: ${botId}\n`);
    
    console.log('2. Starting ViewBot...');
    const startResult = await service.startViewBot(botId);
    
    if (!startResult.success) {
      throw new Error(`Failed to start ViewBot: ${startResult.message}`);
    }
    
    console.log(`✅ ViewBot started successfully`);
    console.log(`📊 Video track: ${startResult.tracks.video}`);
    console.log(`🔊 Audio track: ${startResult.tracks.audio}\n`);
    
    console.log('3. Monitoring ViewBot for 10 seconds...');
    
    // Monitor status every 2 seconds
    const monitorInterval = setInterval(() => {
      const status = service.getViewBotStatus(botId);
      const uptimeSeconds = Math.floor(status.uptime / 1000);
      console.log(`📊 Status: ${status.running ? 'Running' : 'Stopped'} | Uptime: ${uptimeSeconds}s | Video: ${status.tracks.video} | Audio: ${status.tracks.audio}`);
    }, 2000);
    
    // Stop after 10 seconds
    setTimeout(async () => {
      clearInterval(monitorInterval);
      
      console.log('\n4. Stopping ViewBot...');
      const stopResult = await service.stopViewBot(botId);
      
      if (stopResult.success) {
        console.log('✅ ViewBot stopped successfully');
      } else {
        console.log(`❌ Failed to stop ViewBot: ${stopResult.message}`);
      }
      
      console.log('\n5. Removing ViewBot...');
      const removeResult = await service.removeViewBot(botId);
      
      if (removeResult.success) {
        console.log('✅ ViewBot removed successfully');
      } else {
        console.log(`❌ Failed to remove ViewBot: ${removeResult.message}`);
      }
      
      console.log('\n🎉 Test completed successfully!');
      process.exit(0);
    }, 10000);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testWebRTCViewBot();