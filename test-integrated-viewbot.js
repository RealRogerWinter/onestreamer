const ViewbotService = require('./server/services/ViewbotService');

async function testIntegratedViewBot() {
  console.log('🧪 Testing Integrated ViewBot Service...\n');
  
  try {
    // Create service instance (no MediaSoup for testing)
    const service = new ViewbotService(null);
    
    console.log(`📊 Using mode: ${service.useWebRTC ? 'WebRTC' : 'HLS'}`);
    
    console.log('\n1. Starting ViewBot with color-bars pattern...');
    const startResult = await service.startViewbot({
      config: {
        content: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30
      }
    });
    
    if (!startResult.success) {
      throw new Error(`Failed to start ViewBot: ${startResult.message}`);
    }
    
    console.log(`✅ ViewBot started successfully`);
    console.log(`📊 Stream ID: ${startResult.streamId}`);
    console.log(`🎭 Mode: ${startResult.mode}`);
    console.log(`📺 Config:`, JSON.stringify(startResult.config, null, 2));
    
    if (startResult.producerInfo?.webrtc) {
      console.log(`🤖 WebRTC Bot ID: ${startResult.producerInfo.botId}`);
      console.log(`📊 Video Track: ${startResult.producerInfo.tracks.video}`);
      console.log(`🔊 Audio Track: ${startResult.producerInfo.tracks.audio}`);
    }
    
    console.log('\n2. Monitoring ViewBot for 10 seconds...');
    
    // Monitor status every 2 seconds
    const monitorInterval = setInterval(() => {
      const status = service.getViewbotStatus();
      const uptimeSeconds = Math.floor(status.duration / 1000);
      console.log(`📊 Active: ${status.isActive} | Uptime: ${uptimeSeconds}s | Process: ${status.processStatus}`);
      
      // Check WebRTC status if applicable
      if (service.useWebRTC) {
        const webrtcBots = service.webrtcService.listViewBots();
        webrtcBots.forEach(bot => {
          console.log(`🤖 Bot ${bot.botId.substring(0, 8)}...: ${bot.running ? 'Running' : 'Stopped'} | Video: ${bot.tracks?.video} | Audio: ${bot.tracks?.audio}`);
        });
      }
    }, 2000);
    
    // Test updating configuration
    setTimeout(async () => {
      console.log('\n3. Updating ViewBot configuration...');
      service.updateViewbotConfig({
        content: 'custom-text',
        customText: 'Updated ViewBot!',
        textColor: '#ff0000',
        backgroundColor: '#000080'
      });
      console.log('✅ Configuration updated');
    }, 5000);
    
    // Stop after 10 seconds
    setTimeout(async () => {
      clearInterval(monitorInterval);
      
      console.log('\n4. Stopping ViewBot...');
      const stopResult = await service.stopViewbot();
      
      if (stopResult.success) {
        console.log(`✅ ViewBot stopped: ${stopResult.streamId}`);
      } else {
        console.log(`❌ Failed to stop ViewBot: ${stopResult.message}`);
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
testIntegratedViewBot();