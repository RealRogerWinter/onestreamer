#!/usr/bin/env node

/**
 * Test LiveKit RTMP Ingress for ViewBots
 */

const LiveKitIngressService = require('./server/services/LiveKitIngressService');

async function testLiveKitIngress() {
  console.log('🧪 Testing LiveKit RTMP Ingress for ViewBots...\n');
  
  // Mock LiveKit service
  const mockLivekitService = {
    roomName: 'main'
  };
  
  // Initialize ingress service
  const ingressService = new LiveKitIngressService(mockLivekitService);
  
  const botId = `test-viewbot-${Date.now()}`;
  const videoFile = '/root/onestreamer/server/uploads/test_10sec.mp4';
  
  try {
    // Step 1: Create RTMP ingress
    console.log(`📡 Creating RTMP ingress for ${botId}...`);
    const createResult = await ingressService.createIngress(botId, 'main');
    
    if (!createResult.success) {
      throw new Error(`Failed to create ingress: ${createResult.error}`);
    }
    
    console.log(`✅ Ingress created successfully!`);
    console.log(`   Ingress ID: ${createResult.ingressId}`);
    console.log(`   RTMP URL: ${createResult.rtmpUrl}`);
    console.log(`   Stream Key: ${createResult.streamKey}\n`);
    
    // Step 2: Start streaming
    console.log(`🎬 Starting FFmpeg stream to RTMP ingress...`);
    const streamResult = await ingressService.startStreaming(botId, videoFile);
    
    if (!streamResult.success) {
      throw new Error(`Failed to start streaming: ${streamResult.error}`);
    }
    
    console.log(`✅ Streaming started successfully!`);
    console.log(`   Full RTMP URL: ${streamResult.rtmpUrl}\n`);
    
    // Step 3: Let it stream for 30 seconds
    console.log(`⏰ Streaming for 30 seconds...`);
    console.log(`   Check the LiveKit room to see the ViewBot stream\n`);
    
    // Show status
    const status = ingressService.getStatus();
    console.log(`📊 Current Status:`, JSON.stringify(status, null, 2));
    
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Step 4: Stop streaming
    console.log(`\n⏹️ Stopping stream...`);
    const stopResult = await ingressService.stopStreaming(botId);
    
    if (stopResult.success) {
      console.log(`✅ Stream stopped successfully`);
    }
    
    // Step 5: Clean up ingress
    console.log(`\n🗑️ Deleting ingress...`);
    const deleteResult = await ingressService.deleteIngress(botId);
    
    if (deleteResult.success) {
      console.log(`✅ Ingress deleted successfully`);
    }
    
    console.log(`\n✅ Test completed successfully!`);
    
  } catch (error) {
    console.error(`\n❌ Test failed:`, error.message);
    console.error(`\nFull error:`, error);
    
    // Clean up on error
    try {
      await ingressService.cleanup();
    } catch (cleanupError) {
      console.error(`Failed to cleanup:`, cleanupError.message);
    }
  }
  
  process.exit(0);
}

// Run the test
testLiveKitIngress();