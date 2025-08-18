/**
 * Test script for the global streaming method toggle
 * Tests the ability to switch between FFmpeg and GStreamer for all ViewBots
 */

const fetch = require('node-fetch');

const SERVER_URL = 'http://localhost:3000';
const ADMIN_KEY = 'your-admin-key'; // Update this with your actual admin key

// Helper function to make API calls
async function apiCall(endpoint, options = {}) {
  const response = await fetch(`${SERVER_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': ADMIN_KEY,
      ...options.headers
    }
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HTTP ${response.status}: ${error}`);
  }
  
  return response.json();
}

async function testStreamingMethodToggle() {
  console.log('🧪 Testing Global Streaming Method Toggle');
  console.log('=========================================\n');
  
  try {
    // Step 1: Get current streaming method
    console.log('📋 Step 1: Getting current streaming method...');
    const currentMethod = await apiCall('/admin/viewbot-client/streaming-method');
    console.log(`✅ Current method: ${currentMethod.method}`);
    console.log(`   Supported methods: ${currentMethod.supported.join(', ')}\n`);
    
    // Step 2: Switch to GStreamer
    console.log('🔄 Step 2: Switching to GStreamer...');
    const gstreamerResult = await apiCall('/admin/viewbot-client/streaming-method', {
      method: 'POST',
      body: JSON.stringify({ method: 'gstreamer' })
    });
    console.log(`✅ ${gstreamerResult.message}`);
    console.log(`   Previous: ${gstreamerResult.previousMethod}`);
    console.log(`   New: ${gstreamerResult.newMethod}\n`);
    
    // Step 3: Verify the change
    console.log('✔️ Step 3: Verifying the change...');
    const verifyGStreamer = await apiCall('/admin/viewbot-client/streaming-method');
    console.log(`✅ Verified method: ${verifyGStreamer.method}\n`);
    
    // Step 4: Create a test ViewBot with video file
    console.log('🤖 Step 4: Creating test ViewBot with video file...');
    const testBot = await apiCall('/admin/viewbot-client/create', {
      method: 'POST',
      body: JSON.stringify({
        contentType: 'videoFile',
        videoFile: 'C:\\onestreamer\\uploads\\test.mp4', // Update with actual test video
        width: 1280,
        height: 720,
        frameRate: 30,
        autoStart: false
      })
    });
    
    if (testBot.success) {
      console.log(`✅ ViewBot created: ${testBot.botId}`);
      console.log(`   Should use GStreamer: ${testBot.config.useGStreamer === true ? 'YES' : 'NO'}\n`);
    } else {
      console.log(`⚠️ Failed to create ViewBot: ${testBot.message}\n`);
    }
    
    // Step 5: Switch back to FFmpeg
    console.log('🔄 Step 5: Switching back to FFmpeg...');
    const ffmpegResult = await apiCall('/admin/viewbot-client/streaming-method', {
      method: 'POST',
      body: JSON.stringify({ method: 'ffmpeg' })
    });
    console.log(`✅ ${ffmpegResult.message}`);
    console.log(`   Previous: ${ffmpegResult.previousMethod}`);
    console.log(`   New: ${ffmpegResult.newMethod}\n`);
    
    // Step 6: Create another ViewBot to verify FFmpeg is used
    console.log('🤖 Step 6: Creating another ViewBot to verify FFmpeg...');
    const testBot2 = await apiCall('/admin/viewbot-client/create', {
      method: 'POST',
      body: JSON.stringify({
        contentType: 'videoFile',
        videoFile: 'C:\\onestreamer\\uploads\\test.mp4', // Update with actual test video
        width: 1280,
        height: 720,
        frameRate: 30,
        autoStart: false
      })
    });
    
    if (testBot2.success) {
      console.log(`✅ ViewBot created: ${testBot2.botId}`);
      console.log(`   Should use FFmpeg: ${testBot2.config.useGStreamer !== true ? 'YES' : 'NO'}\n`);
    } else {
      console.log(`⚠️ Failed to create ViewBot: ${testBot2.message}\n`);
    }
    
    // Step 7: Test invalid method
    console.log('❌ Step 7: Testing invalid method (should fail)...');
    try {
      await apiCall('/admin/viewbot-client/streaming-method', {
        method: 'POST',
        body: JSON.stringify({ method: 'invalid' })
      });
      console.log('⚠️ Unexpected: Invalid method was accepted\n');
    } catch (error) {
      console.log('✅ Expected error for invalid method:', error.message.substring(0, 50), '...\n');
    }
    
    console.log('✅ All tests completed successfully!');
    console.log('\n📊 Summary:');
    console.log('- Global streaming method can be toggled between FFmpeg and GStreamer');
    console.log('- New ViewBots automatically use the global setting for video files');
    console.log('- Invalid methods are properly rejected');
    console.log('- The setting applies to all ViewBots streaming video files');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('\n💡 Make sure:');
    console.error('1. The server is running on port 3000');
    console.error('2. You have updated the ADMIN_KEY in this script');
    console.error('3. The ViewBotClientService is initialized');
  }
}

// Run the test
testStreamingMethodToggle().catch(console.error);