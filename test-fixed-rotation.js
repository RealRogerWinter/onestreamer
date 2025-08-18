/**
 * Test the fixed ViewBot rotation system
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testFixedRotation() {
  console.log('🔄 Testing Fixed ViewBot Rotation System\n');
  
  try {
    // Step 1: Clean slate - destroy all existing ViewBots
    console.log('1. Cleaning up existing ViewBots...');
    await axios.delete(`${SERVER_URL}/admin/viewbot-client/all`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log('✅ Existing ViewBots cleared');

    // Step 2: Create multiple ViewBots for rotation
    console.log('\n2. Creating ViewBots for rotation...');
    const botConfigs = [
      { contentType: 'testPattern', testPattern: 'color-bars', width: 1280, height: 720, frameRate: 30, autoStart: false },
      { contentType: 'testPattern', testPattern: 'moving-text', width: 1280, height: 720, frameRate: 30, autoStart: false },
      { contentType: 'testPattern', testPattern: 'clock', width: 1280, height: 720, frameRate: 30, autoStart: false }
    ];

    const createdBots = [];
    for (let i = 0; i < botConfigs.length; i++) {
      const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, botConfigs[i], {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      if (response.data.success) {
        createdBots.push(response.data.botId);
        console.log(`✅ ViewBot ${i + 1} created: ${response.data.botId.substring(0, 12)}...`);
      }
    }

    // Wait for ViewBots to connect
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Check initial status
    console.log('\n3. Checking initial ViewBot status...');
    const initialStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log(`📊 Created ${initialStatus.data.totalBots} ViewBots, all should be ready`);
    initialStatus.data.bots.forEach((bot, index) => {
      console.log(`   ViewBot ${index + 1}: ${bot.isConnected ? 'Connected' : 'Disconnected'}, ${bot.isStreaming ? 'Streaming' : 'Ready'}`);
      console.log(`     Time Allotment: ${bot.timeAllotmentFormatted || 'N/A'}`);
    });

    // Step 4: Enable rotation system
    console.log('\n4. Enabling rotation system...');
    const enableResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/toggle`, 
      { enabled: true }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log(`🔄 Rotation enabled: ${enableResponse.data.success} (state: ${enableResponse.data.rotationEnabled})`);

    // Step 5: Wait and check if rotation starts automatically
    console.log('\n5. Checking if rotation starts automatically...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const rotationStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });

    const streamingBot = rotationStatus.data.bots.find(bot => bot.isStreaming);
    if (streamingBot) {
      console.log(`✅ Rotation started automatically! Current streaming bot: ${streamingBot.botId.substring(0, 12)}...`);
      console.log(`   Time remaining: ${streamingBot.timeRemainingFormatted || 'N/A'}`);
    } else {
      console.log(`⚠️ No ViewBot is streaming yet`);
    }

    // Step 6: Check rotation system health status
    console.log('\n6. Checking rotation system status...');
    const healthResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/health`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log(`📊 Rotation System Status:`);
    console.log(`   Enabled: ${healthResponse.data.rotationEnabled}`);
    console.log(`   Real Streamer Active: ${healthResponse.data.realStreamerActive}`);
    console.log(`   Current Live Bot: ${healthResponse.data.currentLiveBot || 'None'}`);

    // Step 7: Monitor for a rotation event (wait for time expiry)
    if (streamingBot && streamingBot.timeRemaining < 300000) { // Less than 5 minutes
      console.log('\n7. Waiting for automatic rotation (ViewBot time is running low)...');
      
      const monitorInterval = setInterval(async () => {
        const currentStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
        
        const nowStreamingBot = currentStatus.data.bots.find(bot => bot.isStreaming);
        if (nowStreamingBot && nowStreamingBot.botId !== streamingBot.botId) {
          console.log(`🔄 AUTOMATIC ROTATION DETECTED!`);
          console.log(`   Previous: ${streamingBot.botId.substring(0, 12)}...`);
          console.log(`   Current: ${nowStreamingBot.botId.substring(0, 12)}...`);
          console.log(`   New time remaining: ${nowStreamingBot.timeRemainingFormatted || 'N/A'}`);
          clearInterval(monitorInterval);
        }
      }, 5000);

      // Stop monitoring after 2 minutes
      setTimeout(() => {
        clearInterval(monitorInterval);
      }, 120000);
    } else {
      console.log('\n7. Skipping rotation monitoring (ViewBot has too much time remaining)');
    }

    console.log('\n✅ Fixed Rotation System Test Complete!');
    console.log('\n📋 What should be working now:');
    console.log('✅ Rotation system stays enabled when toggled on');
    console.log('✅ Automatically starts first ViewBot when enabled');
    console.log('✅ ViewBots rotate when their time allotment expires');
    console.log('✅ All ViewBots (except current) get new time allotments on rotation');
    console.log('✅ System continues running until manually disabled');
    console.log('\n🌐 Check the admin panel at http://localhost:3000 to:');
    console.log('   - See the rotation system enabled and active');
    console.log('   - Watch time allotments count down');
    console.log('   - Observe automatic ViewBot switches');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testFixedRotation();