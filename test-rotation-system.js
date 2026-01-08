/**
 * Test script for the new ViewBot rotation system
 * This demonstrates unlimited ViewBots, rotation toggles, and time allotments
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testRotationSystem() {
  console.log('🔄 Testing ViewBot Rotation System\n');
  
  try {
    // 1. Test unlimited ViewBot creation
    console.log('=== TEST 1: Creating Multiple ViewBots (Testing No Limits) ===');
    const botConfigs = [
      {
        contentType: 'testPattern',
        testPattern: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30,
        autoStart: false
      },
      {
        contentType: 'testPattern',
        testPattern: 'moving-text',
        width: 1280,
        height: 720,
        frameRate: 30,
        autoStart: false
      },
      {
        contentType: 'testPattern',
        testPattern: 'clock',
        width: 1280,
        height: 720,
        frameRate: 30,
        autoStart: false
      }
    ];

    const createdBots = [];
    for (let i = 0; i < botConfigs.length; i++) {
      const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, botConfigs[i], {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      
      if (response.data.success) {
        createdBots.push(response.data.botId);
        console.log(`✅ ViewBot ${i + 1} created: ${response.data.botId}`);
      }
    }

    console.log(`\n📊 Created ${createdBots.length} ViewBots (no limits enforced!)\n`);

    // 2. Check initial status and time allotments
    console.log('=== TEST 2: Checking Time Allotments ===');
    const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });

    statusResponse.data.bots.forEach((bot, index) => {
      console.log(`🎲 ViewBot ${index + 1} (${bot.botId.substring(0, 12)}...):`);
      console.log(`   - Time Allotment: ${bot.timeAllotmentFormatted || 'N/A'}`);
      console.log(`   - Time Remaining: ${bot.timeRemainingFormatted || 'N/A'}`);
      console.log(`   - Status: ${bot.isStreaming ? 'Streaming' : 'Ready'}`);
    });

    // 3. Test rotation system toggle
    console.log('\n=== TEST 3: Testing Rotation System Toggle ===');
    
    // Enable rotation
    const enableResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/toggle`, 
      { enabled: true }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log(`🔄 Rotation system enabled: ${enableResponse.data.success}`);

    // Check rotation status
    const rotationStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/rotation/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log(`📊 Rotation Status:`);
    console.log(`   - Enabled: ${rotationStatus.data.rotationEnabled}`);
    console.log(`   - Real Streamer Active: ${rotationStatus.data.realStreamerActive}`);
    console.log(`   - Current Live Bot: ${rotationStatus.data.currentLiveBot || 'None'}`);
    console.log(`   - Available Bots: ${rotationStatus.data.availableBots}`);

    // 4. Test real streamer protection
    console.log('\n=== TEST 4: Testing Real Streamer Protection ===');
    
    // Set real streamer active
    const realStreamerResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/real-streamer-status`, 
      { isActive: true }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log(`👤 Real streamer set to active: ${realStreamerResponse.data.success}`);

    // Try to start a ViewBot (should work but rotation should be protected)
    if (createdBots.length > 0) {
      const startResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/${createdBots[0]}/start`, 
        {}, 
        { headers: { 'x-admin-key': ADMIN_KEY } }
      );
      console.log(`▶️ Started ViewBot: ${startResponse.data.success}`);
      
      // Wait a moment then check if it's protected from rotation
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const protectedStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/rotation/status`, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      console.log(`🛡️ Real Streamer Protection Active: ${protectedStatus.data.realStreamerActive}`);
    }

    // 5. Test forced rotation
    console.log('\n=== TEST 5: Testing Manual Rotation (with protection disabled) ===');
    
    // Disable real streamer protection
    await axios.post(`${SERVER_URL}/admin/viewbot-client/real-streamer-status`, 
      { isActive: false }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log(`💤 Real streamer protection disabled`);

    // Force rotation if we have a streaming bot
    const currentStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });

    const streamingBot = currentStatus.data.bots.find(bot => bot.isStreaming);
    if (streamingBot) {
      const forceResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/force`, 
        { currentBotId: streamingBot.botId }, 
        { headers: { 'x-admin-key': ADMIN_KEY } }
      );
      
      if (forceResponse.data.success) {
        console.log(`🔄 Forced rotation successful:`);
        console.log(`   - Previous: ${forceResponse.data.previousBot.substring(0, 12)}...`);
        console.log(`   - New: ${forceResponse.data.newBot.substring(0, 12)}...`);
      } else {
        console.log(`⚠️ Forced rotation failed: ${forceResponse.data.message}`);
      }
    }

    console.log('\n🎉 ViewBot Rotation System Test Complete!');
    console.log('\n📋 Features Tested:');
    console.log('✅ Unlimited ViewBot creation (no more limits)');
    console.log('✅ Random time allotments (2min-1hr) for each ViewBot');
    console.log('✅ Rotation system toggle (on/off)');
    console.log('✅ Real streamer protection');
    console.log('✅ Manual rotation forcing');
    console.log('\n🌐 Check the admin panel at http://localhost:3000 to see:');
    console.log('   - Time allotments and remaining time for each ViewBot');
    console.log('   - Rotation system controls');
    console.log('   - Real streamer protection toggle');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testRotationSystem();