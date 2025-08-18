/**
 * Debug script to check ViewBot configuration and video file handling
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function debugViewBotConfig() {
  console.log('🔍 Debugging ViewBot Configuration\n');
  
  try {
    // Step 1: Create a simple test video file path (for testing)
    const testVideoPath = 'C:\\Windows\\System32\\svchost.exe'; // Any file that exists for testing
    console.log(`Using test path: ${testVideoPath}`);
    
    // Step 2: Create ViewBot with video file config
    const config = {
      contentType: 'videoFile',
      videoFile: testVideoPath,
      width: 640,
      height: 480,
      frameRate: 30,
      autoStart: false // Don't start yet
    };
    
    console.log('\n📋 Creating ViewBot with config:', JSON.stringify(config, null, 2));
    
    const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, {
      config: config
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (!createResponse.data.success) {
      console.error('❌ ViewBot creation failed:', createResponse.data.message);
      return;
    }
    
    const botId = createResponse.data.botId;
    console.log(`✅ ViewBot created: ${botId}`);
    console.log('📋 Returned config:', JSON.stringify(createResponse.data.config, null, 2));
    
    // Step 3: Get ViewBot status to see what config it actually has
    console.log('\n🔍 Checking ViewBot status...');
    const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (statusResponse.data.activeBots && statusResponse.data.activeBots.length > 0) {
      const bot = statusResponse.data.activeBots.find(b => b.botId === botId);
      if (bot) {
        console.log(`\n📊 ViewBot ${botId} actual config:`);
        console.log(JSON.stringify(bot.config, null, 2));
        
        console.log(`\n🔍 Key config values:`);
        console.log(`- contentType: "${bot.config.contentType}"`);
        console.log(`- videoFile: "${bot.config.videoFile}"`);
        console.log(`- testPattern: "${bot.config.testPattern}"`);
      }
    }
    
    // Step 4: Try to start streaming and see what happens
    console.log('\n🎬 Starting ViewBot streaming...');
    const startResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/start`, {}, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    console.log('Start response:', startResponse.data);
    
    // Wait a moment for streaming to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check status again
    const finalStatusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (finalStatusResponse.data.activeBots && finalStatusResponse.data.activeBots.length > 0) {
      const bot = finalStatusResponse.data.activeBots.find(b => b.botId === botId);
      if (bot) {
        console.log(`\n📺 Final ViewBot status:`);
        console.log(`- Connected: ${bot.isConnected}`);
        console.log(`- Streaming: ${bot.isStreaming}`);
        console.log(`- Error: ${bot.lastError || 'None'}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Debug failed:', error.response?.data || error.message);
  }
}

debugViewBotConfig();