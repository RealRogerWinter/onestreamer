/**
 * Test the fix for FFmpeg file paths with special characters
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testSpecialCharsFix() {
  console.log('🔧 Testing Special Characters Fix for ViewBot Video Files\n');
  
  try {
    const config = {
      contentType: 'videoFile',
      videoFile: 'C:\\Users\\18084\\Desktop\\shows\\The Apprentice (2024) [1080p] [WEBRip] [5.1] [YTS.MX]\\apprentice.mp4',
      width: 1280,
      height: 720,
      frameRate: 30,
      autoStart: true
    };
    
    console.log('📋 Creating ViewBot with problematic file path:');
    console.log(`   ${config.videoFile}`);
    
    const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, config, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (!response.data.success) {
      console.error('❌ ViewBot creation failed:', response.data.message);
      return;
    }
    
    const botId = response.data.botId;
    console.log(`✅ ViewBot created: ${botId}`);
    
    // Monitor for 20 seconds to see if FFmpeg starts properly
    console.log('\n⏳ Monitoring ViewBot for 20 seconds...');
    
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      const bot = statusResponse.data.bots?.find(b => b.botId === botId);
      if (bot) {
        const secondsElapsed = (i + 1) * 2.5;
        console.log(`\\n📊 Status at ${secondsElapsed}s:`);
        console.log(`  - Connected: ${bot.isConnected}`);
        console.log(`  - Streaming: ${bot.isStreaming}`);
        console.log(`  - Error: ${bot.lastError || 'none'}`);
        
        if (bot.isStreaming) {
          console.log('\\n🎯 SUCCESS! ViewBot is streaming the video file with special characters');
          console.log('\\n📺 Test verification:');
          console.log('1. Open http://localhost:3000 in browser');
          console.log('2. Video should be playing (not stuck on "Switching Stream")');
          console.log('3. Content should be from the video file, not test pattern');
          break;
        } else if (bot.lastError && bot.lastError.includes('Invalid argument')) {
          console.log('\\n❌ FFmpeg still failing with "Invalid argument" - fix needs more work');
          break;
        }
      } else {
        console.log(`❌ ViewBot ${botId} not found in status`);
        break;
      }
    }
    
    console.log('\\n🧪 Test completed');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testSpecialCharsFix();