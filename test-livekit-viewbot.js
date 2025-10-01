#!/usr/bin/env node

/**
 * Test script to verify LiveKit ViewBot streaming with whipsink
 */

const ViewBotLiveKitService = require('./server/services/ViewBotLiveKitService');

async function testLiveKitViewBot() {
  console.log('🧪 Testing LiveKit ViewBot with whipsink...');
  
  // Create mock LiveKit service with necessary methods
  const mockLivekitService = {
    createToken: async (identity, isProducer) => {
      // Generate a real token using LiveKit SDK
      const { AccessToken } = require('livekit-server-sdk');
      const apiKey = process.env.LIVEKIT_API_KEY || 'REDACTED-LIVEKIT-API-KEY';
      const apiSecret = process.env.LIVEKIT_API_SECRET || 'REDACTED-LIVEKIT-API-SECRET';
      
      const token = new AccessToken(apiKey, apiSecret, {
        identity: identity,
        ttl: '24h',
      });
      
      token.addGrant({
        roomJoin: true,
        room: 'main',
        canPublish: isProducer,
        canSubscribe: true,
      });
      
      return await token.toJwt();
    },
    
    roomName: 'main',
    url: process.env.LIVEKIT_URL || 'wss://onestreamer.live:7880'
  };
  
  try {
    // Initialize the service
    const viewBotService = new ViewBotLiveKitService(mockLivekitService);
    
    // Find a test video file
    const testVideo = '/root/onestreamer/server/uploads/test_10sec.mp4';
    
    // Create and start a ViewBot
    const botConfig = {
      botId: `test-viewbot-${Date.now()}`,
      videoFile: testVideo
    };
    
    console.log(`📹 Starting ViewBot with video: ${testVideo}`);
    const result = await viewBotService.createViewBot(botConfig);
    
    if (result.success) {
      console.log(`✅ ViewBot created successfully: ${result.botId}`);
      
      console.log(`🎬 Starting ViewBot stream...`);
      const startResult = await viewBotService.startViewBot(result.botId);
      
      if (startResult.success) {
        console.log(`✅ ViewBot streaming started successfully!`);
        console.log(`📊 Stream details:`, startResult);
        
        // Let it stream for 30 seconds
        console.log(`⏰ Streaming for 30 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        // Stop the ViewBot
        console.log(`⏹️ Stopping ViewBot...`);
        const stopResult = await viewBotService.stopViewBot(result.botId);
        console.log(`✅ ViewBot stopped:`, stopResult);
      } else {
        console.error(`❌ Failed to start ViewBot:`, startResult.message);
      }
    } else {
      console.error(`❌ Failed to create ViewBot:`, result.message);
    }
    
  } catch (error) {
    console.error(`❌ Test failed:`, error);
  }
  
  process.exit(0);
}

// Run the test
testLiveKitViewBot();