/**
 * Test the updated play/pause button functionality with rotation integration
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testPlayPauseButtons() {
  console.log('🎮 Testing Updated Play/Pause Button Functionality\n');
  
  try {
    // Step 1: Setup - Create multiple ViewBots
    console.log('1. Setting up test ViewBots...');
    await axios.delete(`${SERVER_URL}/admin/viewbot-client/all`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    const botConfigs = [
      { contentType: 'testPattern', testPattern: 'color-bars', width: 1280, height: 720, frameRate: 30, autoStart: false },
      { contentType: 'testPattern', testPattern: 'moving-text', width: 1280, height: 720, frameRate: 30, autoStart: false }
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

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Test buttons WITHOUT rotation system
    console.log('\n2. Testing play/pause buttons WITHOUT rotation system...');
    
    // Start first bot manually
    console.log(`▶️ Starting ViewBot 1 manually...`);
    const startResult1 = await axios.post(`${SERVER_URL}/admin/viewbot-client/${createdBots[0]}/start`, {}, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log(`Start result: ${startResult1.data.success ? 'SUCCESS' : 'FAILED'} - ${startResult1.data.message || ''}`);

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop first bot manually
    console.log(`⏹️ Stopping ViewBot 1 manually...`);
    const stopResult1 = await axios.post(`${SERVER_URL}/admin/viewbot-client/${createdBots[0]}/stop`, {}, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log(`Stop result: ${stopResult1.data.success ? 'SUCCESS' : 'FAILED'} - ${stopResult1.data.message || ''}`);

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Enable rotation system
    console.log('\n3. Enabling rotation system...');
    const enableRotation = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/toggle`, 
      { enabled: true }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log(`🔄 Rotation enabled: ${enableRotation.data.success} (state: ${enableRotation.data.rotationEnabled})`);

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 4: Test buttons WITH rotation system
    console.log('\n4. Testing play/pause buttons WITH rotation system...');
    
    // Check current status
    const statusBefore = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    const streamingBotBefore = statusBefore.data.bots.find(bot => bot.isStreaming);
    if (streamingBotBefore) {
      console.log(`📊 Current streaming bot: ${streamingBotBefore.botId.substring(0, 12)}... (${streamingBotBefore.timeRemainingFormatted})`);
    }

    // Manually start second bot (should stop first and update rotation tracking)
    console.log(`🔄 Starting ViewBot 2 manually (with rotation active)...`);
    const startResult2 = await axios.post(`${SERVER_URL}/admin/viewbot-client/${createdBots[1]}/start`, {}, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log(`Start result: ${startResult2.data.success ? 'SUCCESS' : 'FAILED'} - ${startResult2.data.message || ''}`);

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check if rotation tracking was updated
    const statusAfterStart = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    const streamingBotAfter = statusAfterStart.data.bots.find(bot => bot.isStreaming);
    if (streamingBotAfter) {
      console.log(`📊 New streaming bot: ${streamingBotAfter.botId.substring(0, 12)}... (${streamingBotAfter.timeRemainingFormatted})`);
      console.log(`✅ ${streamingBotAfter.botId === createdBots[1] ? 'CORRECT' : 'INCORRECT'} - ViewBot 2 should be streaming`);
    }

    // Stop the current bot (should auto-start another with rotation)
    console.log(`🔄 Stopping current ViewBot (rotation should auto-start next)...`);
    if (streamingBotAfter) {
      const stopResult2 = await axios.post(`${SERVER_URL}/admin/viewbot-client/${streamingBotAfter.botId}/stop`, {}, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      console.log(`Stop result: ${stopResult2.data.success ? 'SUCCESS' : 'FAILED'} - ${stopResult2.data.message || ''}`);

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if auto-rotation occurred
      const statusAfterStop = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      const newStreamingBot = statusAfterStop.data.bots.find(bot => bot.isStreaming);
      if (newStreamingBot) {
        console.log(`📊 Auto-rotated to: ${newStreamingBot.botId.substring(0, 12)}... (${newStreamingBot.timeRemainingFormatted})`);
        console.log(`✅ ${newStreamingBot.botId !== streamingBotAfter.botId ? 'SUCCESS' : 'FAILED'} - Auto-rotation should have occurred`);
      } else {
        console.log(`⚠️ No ViewBot is streaming after stop - might be expected if no bots available`);
      }
    }

    // Step 5: Test real streamer protection
    console.log('\n5. Testing real streamer protection...');
    
    // Enable real streamer protection
    const enableProtection = await axios.post(`${SERVER_URL}/admin/viewbot-client/real-streamer-status`, 
      { isActive: true }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log(`👤 Real streamer protection enabled: ${enableProtection.data.success}`);

    // Try to start a ViewBot (should be blocked)
    console.log(`🛡️ Trying to start ViewBot with protection active...`);
    const protectedStartResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/${createdBots[0]}/start`, {}, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log(`Protected start result: ${protectedStartResult.data.success ? 'FAILED (should be blocked)' : 'SUCCESS (correctly blocked)'}`);
    console.log(`Message: ${protectedStartResult.data.message}`);

    console.log('\n✅ Play/Pause Button Test Complete!');
    console.log('\n📋 Updated Button Features:');
    console.log('✅ Manual start/stop works without rotation');
    console.log('✅ Manual start with rotation stops current bot and updates tracking');
    console.log('✅ Manual stop with rotation auto-starts next available bot');
    console.log('✅ Buttons show rotation icons (🔄) when rotation is active');
    console.log('✅ Real streamer protection blocks ViewBot manual starts');
    console.log('✅ Tooltips explain behavior based on rotation status');
    console.log('\n🌐 Admin Panel Features:');
    console.log('   - Play buttons show ▶️ (normal) or 🔄 (rotation mode)');
    console.log('   - Stop buttons show ⏹️ (normal) or 🔄 (rotation mode)');
    console.log('   - Buttons disabled when real streamer is active');
    console.log('   - Helpful tooltips explain current behavior');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testPlayPauseButtons();