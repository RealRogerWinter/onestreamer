/**
 * Diagnostic script for rotation system
 */

const axios = require('axios');

const SERVER_URL = 'https://127.0.0.1:8443';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***'; // Update if different

// Allow self-signed certificates
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

async function diagnoseRotation() {
  console.log('🔍 Diagnosing Rotation System\n');
  
  try {
    // 1. Check rotation status with debug info
    console.log('1️⃣ Fetching rotation status...');
    const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/rotation/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    const status = statusResponse.data;
    console.log('\n📊 Rotation Status:');
    console.log(`   Enabled: ${status.rotationEnabled}`);
    console.log(`   Current Live Bot: ${status.currentLiveBot || 'None'}`);
    console.log(`   Time to Next Rotation: ${status.timeToNextRotationFormatted || 'Not calculated'}`);
    console.log(`   Time (ms): ${status.timeToNextRotation || 'null'}`);
    
    if (status.debug) {
      console.log('\n🐛 Debug Info:');
      console.log(`   Bot Exists: ${status.debug.botExists}`);
      console.log(`   Streaming: ${status.debug.streaming}`);
      console.log(`   Time Allotment: ${status.debug.timeAllotment}`);
      console.log(`   Time Remaining: ${status.debug.timeRemaining}`);
      console.log(`   Has Timer: ${status.debug.hasTimer}`);
    }
    
    // 2. Get list of all bots
    console.log('\n2️⃣ Fetching all ViewBots...');
    const botsResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    const bots = botsResponse.data.bots || [];
    console.log(`\n📦 Total ViewBots: ${bots.length}`);
    
    bots.forEach((bot, index) => {
      console.log(`\n   Bot ${index + 1}: ${bot.botId}`);
      console.log(`      Connected: ${bot.isConnected}`);
      console.log(`      Streaming: ${bot.streaming || bot.isStreaming}`);
      console.log(`      Time Allotment: ${bot.timeAllotment || 'N/A'}`);
      console.log(`      Time Remaining: ${bot.timeRemaining || 'N/A'}`);
      if (bot.streaming || bot.isStreaming) {
        console.log(`      ⭐ THIS BOT IS STREAMING`);
      }
    });
    
    // 3. Check if we need to create bots
    if (bots.length === 0) {
      console.log('\n3️⃣ No bots found. Creating test bots...');
      
      for (let i = 0; i < 2; i++) {
        const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, {
          config: {
            contentType: 'testPattern',
            streamDuration: 2, // 2 minutes for testing
            videoBitrate: '1000k',
            audioBitrate: '128k'
          }
        }, {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
        
        console.log(`   Created bot: ${createResponse.data.botId}`);
      }
    }
    
    // 4. Test enabling rotation
    if (!status.rotationEnabled) {
      console.log('\n4️⃣ Enabling rotation...');
      const toggleResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/toggle`, {
        enabled: true
      }, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      
      console.log(`   Success: ${toggleResponse.data.success}`);
      
      // Wait a bit for rotation to start
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 5. Check status again
    console.log('\n5️⃣ Re-checking rotation status...');
    const finalStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/rotation/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    console.log('\n📊 Final Status:');
    console.log(`   Enabled: ${finalStatus.data.rotationEnabled}`);
    console.log(`   Current Live Bot: ${finalStatus.data.currentLiveBot || 'None'}`);
    console.log(`   Time to Next Rotation: ${finalStatus.data.timeToNextRotationFormatted || 'Not calculated'}`);
    
    if (finalStatus.data.debug) {
      console.log('\n🐛 Final Debug Info:');
      console.log(`   Bot Exists: ${finalStatus.data.debug.botExists}`);
      console.log(`   Streaming: ${finalStatus.data.debug.streaming}`);
      console.log(`   Time Remaining: ${finalStatus.data.debug.timeRemaining}`);
    }
    
    console.log('\n✅ Diagnosis complete!');
    console.log('\n💡 Common issues:');
    console.log('   - If timeRemaining is undefined, the bot may not have been initialized properly');
    console.log('   - If streaming is false, the bot failed to start');
    console.log('   - If hasTimer is false, the rotation timer is not running');
    
  } catch (error) {
    console.error('\n❌ Diagnosis failed:', error.response?.data || error.message);
  }
}

diagnoseRotation();