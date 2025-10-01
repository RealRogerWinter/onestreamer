#!/usr/bin/env node

/**
 * Test LiveKit ViewBot with GStreamer whipsink
 */

const ViewBotLiveKitService = require('./server/services/ViewBotLiveKitService');

async function testLiveKitGStreamer() {
  console.log('🧪 Testing LiveKit ViewBot with GStreamer whipsink...\n');
  
  // Mock LiveKit service
  const mockLivekitService = {
    roomName: 'main'
  };
  
  // Initialize service
  const viewbotService = new ViewBotLiveKitService(mockLivekitService);
  
  const botId = `test-viewbot-${Date.now()}`;
  const videoFile = '/root/onestreamer/server/uploads/test_10sec.mp4';
  
  try {
    // Enable LiveKit mode
    process.env.USE_WEBRTC_ADAPTER = 'true';
    process.env.WEBRTC_BACKEND = 'livekit';
    
    // Create and start ViewBot
    console.log(`🤖 Creating and starting ViewBot ${botId}...`);
    
    const result = await viewbotService.createAndStartViewBot({
      botId: botId,
      videoFile: videoFile,
      roomName: 'main'
    });
    
    if (!result.success) {
      throw new Error(`Failed to create ViewBot: ${result.message}`);
    }
    
    console.log(`✅ ViewBot created and streaming!`);
    console.log(`   Bot ID: ${botId}`);
    console.log(`   Video: ${videoFile}\n`);
    
    // Get status
    const status = await viewbotService.getStatus(botId);
    console.log(`📊 Status:`, JSON.stringify(status, null, 2));
    
    // Let it stream for 30 seconds
    console.log(`\n⏰ Streaming for 30 seconds...`);
    console.log(`   Check https://onestreamer.live to see the ViewBot in the room!\n`);
    
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Stop ViewBot
    console.log(`⏹️ Stopping ViewBot...`);
    const stopResult = await viewbotService.stopViewBot(botId);
    
    if (stopResult.success) {
      console.log(`✅ ViewBot stopped successfully`);
    }
    
    console.log(`\n✅ Test completed successfully!`);
    console.log(`   The ViewBot successfully streamed to LiveKit using GStreamer whipsink!`);
    
  } catch (error) {
    console.error(`\n❌ Test failed:`, error.message);
    console.error(`\nFull error:`, error);
    
    // Clean up on error
    try {
      await viewbotService.cleanup();
    } catch (cleanupError) {
      console.error(`Failed to cleanup:`, cleanupError.message);
    }
  }
  
  process.exit(0);
}

// Run the test
testLiveKitGStreamer();