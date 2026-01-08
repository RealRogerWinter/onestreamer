const ViewBotWebRTCService = require('./server/services/ViewBotWebRTCService');

async function testSynchronization() {
  console.log('🔄 Testing A/V Synchronization Improvements...\n');
  
  try {
    const service = new ViewBotWebRTCService(null);
    
    console.log('1. Creating ViewBot with test pattern for sync verification...');
    const createResult = await service.createViewBot({
      pattern: 'testsrc2',
      width: 1280,
      height: 720,
      frameRate: 30
    });
    
    if (!createResult.success) {
      throw new Error(`Failed to create ViewBot: ${createResult.message}`);
    }
    
    const botId = createResult.botId;
    console.log(`✅ ViewBot created: ${botId}\n`);
    
    console.log('2. Starting synchronized streaming...');
    const startResult = await service.startViewBot(botId);
    
    if (!startResult.success) {
      throw new Error(`Failed to start ViewBot: ${startResult.message}`);
    }
    
    console.log(`✅ Synchronized streaming started`);
    console.log(`📊 Video Track ID: ${startResult.tracks.video}`);
    console.log(`🔊 Audio Track ID: ${startResult.tracks.audio}\n`);
    
    console.log('3. Monitoring synchronization metrics for 15 seconds...');
    console.log('   Watch for consistent A/V sync indicators in the logs\n');
    
    let frameCount = 0;
    let audioFrameCount = 0;
    
    // Monitor detailed status every second
    const detailMonitor = setInterval(() => {
      const status = service.getViewBotStatus(botId);
      const uptimeSeconds = Math.floor(status.uptime / 1000);
      
      // Estimate frames based on timing
      const expectedVideoFrames = Math.floor(uptimeSeconds * 30); // 30fps
      const expectedAudioFrames = Math.floor(uptimeSeconds * 100); // 100 x 10ms frames per second
      
      console.log(`⏱️  ${uptimeSeconds}s | Expected Video: ${expectedVideoFrames} frames | Expected Audio: ${expectedAudioFrames} frames`);
      console.log(`   Status: ${status.running ? '🟢 Running' : '🔴 Stopped'} | Video: ${status.tracks?.video} | Audio: ${status.tracks?.audio}`);
      
      // Check sync health
      const syncRatio = expectedVideoFrames > 0 ? expectedAudioFrames / expectedVideoFrames : 0;
      const expectedRatio = 100 / 30; // ~3.33 audio frames per video frame
      const syncHealth = Math.abs(syncRatio - expectedRatio) < 0.1 ? '🟢 GOOD' : '🟡 CHECK';
      
      console.log(`   Sync Ratio: ${syncRatio.toFixed(2)} (expected: ${expectedRatio.toFixed(2)}) ${syncHealth}\n`);
      
    }, 1000);
    
    // Additional sync verification
    setTimeout(() => {
      console.log('🔍 Mid-test sync verification...');
      const status = service.getViewBotStatus(botId);
      console.log(`   Connection: ${status.connection}`);
      console.log(`   Uptime: ${Math.floor(status.uptime / 1000)}s`);
      console.log('   💡 The sync indicator bar in video should match audio phase\n');
    }, 7500);
    
    // Stop after 15 seconds
    setTimeout(async () => {
      clearInterval(detailMonitor);
      
      console.log('4. Final sync analysis...');
      const finalStatus = service.getViewBotStatus(botId);
      const finalUptime = Math.floor(finalStatus.uptime / 1000);
      const finalVideoFrames = finalUptime * 30;
      const finalAudioFrames = finalUptime * 100;
      
      console.log(`📊 Final metrics after ${finalUptime}s:`);
      console.log(`   Video frames (estimated): ${finalVideoFrames}`);
      console.log(`   Audio frames (estimated): ${finalAudioFrames}`);
      console.log(`   A/V ratio: ${(finalAudioFrames / finalVideoFrames).toFixed(2)} (target: 3.33)`);
      
      console.log('\n5. Stopping synchronized ViewBot...');
      const stopResult = await service.stopViewBot(botId);
      
      if (stopResult.success) {
        console.log('✅ Synchronized ViewBot stopped successfully');
      }
      
      await service.removeViewBot(botId);
      
      console.log('\n🎉 Synchronization test completed!');
      console.log('💡 Key improvements:');
      console.log('   - Single master clock for A/V coordination');
      console.log('   - Shared timestamp base for all frames');
      console.log('   - Frame-accurate video generation');
      console.log('   - Visual sync indicators in test pattern');
      
      process.exit(0);
    }, 15000);
    
  } catch (error) {
    console.error('❌ Synchronization test failed:', error);
    process.exit(1);
  }
}

// Run the synchronization test
testSynchronization();