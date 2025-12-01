#!/usr/bin/env node
/**
 * Test script for LiveKit RTMP ViewBot
 */

const ViewBotLiveKitRTMP = require('./server/services/ViewBotLiveKitRTMP');

// Mock LiveKit service
const mockLivekitService = {
  url: process.env.LIVEKIT_URL || 'https://onestreamer.live:7880',
  apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
  apiSecret: process.env.LIVEKIT_API_SECRET || 'secret'
};

async function main() {
  console.log('🧪 Testing LiveKit RTMP ViewBot');
  console.log('================================');

  const viewbotService = new ViewBotLiveKitRTMP(mockLivekitService);

  console.log('\n📹 Creating ViewBot...');
  const result = await viewbotService.createAndStartViewBot({
    botId: 'test-bot-' + Date.now(),
    roomName: 'test-room',
    videoFile: '/root/onestreamer/server/uploads/test_10sec.mp4'
  });

  console.log('\n✅ Result:', result);

  if (result.success) {
    console.log('\n⏰ Streaming for 30 seconds...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log('\n⏹️ Stopping ViewBot...');
    const stopResult = await viewbotService.stopViewBot(result.botId);
    console.log('✅ Stop result:', stopResult);
  }

  console.log('\n✅ Test complete');
  process.exit(0);
}

main().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
