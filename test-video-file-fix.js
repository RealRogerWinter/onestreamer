/**
 * Test script to verify the video file ViewBot fix
 * This tests the corrected config handling
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testVideoFileFix() {
  console.log('🔧 Testing ViewBot Video File Fix\n');
  
  try {
    // Test with a simple config that mimics what the UI sends
    const uiConfig = {
      contentType: 'videoFile',
      videoFile: 'C:\\Windows\\System32\\winlogon.exe', // Just a file that exists for testing
      testPattern: 'color-bars', // This should be ignored when contentType is videoFile
      width: 640,
      height: 480,
      frameRate: 30,
      videoBitrate: '1000k',
      audioBitrate: '128k',
      autoStart: true,
      streamDuration: 0
    };
    
    console.log('📋 Creating ViewBot with UI-style config:');
    console.log(JSON.stringify(uiConfig, null, 2));
    
    const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, uiConfig, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (!createResponse.data.success) {
      console.error('❌ ViewBot creation failed:', createResponse.data.message);
      return;
    }
    
    const botId = createResponse.data.botId;
    console.log(`\n✅ ViewBot created successfully: ${botId}`);
    console.log('📋 Server processed config:', JSON.stringify(createResponse.data.config, null, 2));
    
    // Wait a moment for initialization
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check the ViewBot status
    console.log('\n📊 Checking ViewBot status...');
    const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (statusResponse.data.activeBots && statusResponse.data.activeBots.length > 0) {
      const bot = statusResponse.data.activeBots.find(b => b.botId === botId);
      if (bot) {
        console.log(`\n🤖 ViewBot ${botId} status:`);
        console.log(`- Content Type: "${bot.config.contentType}"`);
        console.log(`- Video File: "${bot.config.videoFile}"`);
        console.log(`- Connected: ${bot.isConnected}`);
        console.log(`- Streaming: ${bot.isStreaming}`);
        console.log(`- Error: ${bot.lastError || 'None'}`);
        
        // Verify the config is correct
        if (bot.config.contentType === 'videoFile' && bot.config.videoFile) {
          console.log('\n✅ SUCCESS: ViewBot correctly configured for video file!');
          
          if (bot.isStreaming) {
            console.log('✅ SUCCESS: ViewBot is streaming!');
            console.log('\n🎯 Fix verified - ViewBot should now display video file content instead of test pattern');
          } else {
            console.log('⚠️ ViewBot created but not streaming - check server logs for FFmpeg issues');
          }
        } else {
          console.log('\n❌ ISSUE: ViewBot config incorrect');
          console.log('Expected: contentType="videoFile"');
          console.log(`Actual: contentType="${bot.config.contentType}"`);
        }
      }
    }
    
    console.log('\n📋 Manual verification steps:');
    console.log('1. Open http://localhost:3000 in browser');
    console.log('2. ViewBot should show video file content (not test pattern)');
    console.log('3. Check server console for "Using video file input" message');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n📋 Server not running. Please start the server first:');
      console.log('   npm start');
    }
  }
}

testVideoFileFix();