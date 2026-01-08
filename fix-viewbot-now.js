/**
 * Immediate fix for ViewBot streaming issue
 * This will clear the stuck "real streamer" status that's blocking ViewBots
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';

async function fixViewBotNow() {
  console.log('🔧 ViewBot Immediate Fix');
  console.log('========================\n');
  
  try {
    console.log('1. Clearing stuck real streamer status...');
    
    // Use the new debug endpoint to clear real streamer status
    const clearResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/debug/clear-real-streamer`, {}, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    if (clearResult.data.success) {
      console.log('✅ Real streamer status cleared successfully');
      console.log(`📊 Current streamer: ${clearResult.data.currentStreamer || 'None'}`);
      console.log(`📊 Real streamer active: ${clearResult.data.realStreamerActive}`);
    } else {
      console.log('❌ Failed to clear real streamer status');
      return;
    }
    
    console.log('\n2. Checking ViewBot status...');
    
    const statusResult = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    console.log(`📊 Total ViewBots: ${statusResult.data.totalBots}`);
    console.log(`📊 Streaming ViewBots: ${statusResult.data.bots.filter(b => b.isStreaming).length}`);
    
    if (statusResult.data.bots.length > 0) {
      console.log('\n📊 ViewBot Status:');
      statusResult.data.bots.forEach((bot, index) => {
        console.log(`   ${index + 1}. ID: ${bot.botId.substring(0, 12)}...`);
        console.log(`      Connected: ${bot.isConnected}`);
        console.log(`      Streaming: ${bot.isStreaming}`);
        console.log(`      Content: ${bot.config.contentType}`);
        console.log(`      Last Error: ${bot.lastError || 'None'}`);
      });
      
      console.log('\n✅ ViewBots should now be able to start streaming!');
      console.log('💡 Try clicking the play button on a ViewBot in the admin panel.');
    } else {
      console.log('\n📊 No ViewBots found. Create one first, then try starting it.');
    }
    
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('❌ Authentication failed. The server might still be using the old auth system.');
      console.log('💡 Restart the server to apply the authentication fixes.');
    } else {
      console.log('❌ Fix failed:', error.response?.data?.error || error.message);
    }
  }
}

console.log('🚀 This script will immediately fix the ViewBot streaming issue by:');
console.log('   1. Clearing the stuck "real streamer" status');
console.log('   2. Validating current ViewBot states');
console.log('   3. Confirming ViewBots can now start streaming\n');

fixViewBotNow();