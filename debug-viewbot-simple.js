/**
 * Simple script to create and start a ViewBot while monitoring server logs
 * This will help identify where the process is failing
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';

async function debugViewBotSimple() {
  console.log('🔍 Simple ViewBot Debug Test');
  console.log('============================\n');
  
  try {
    console.log('📊 Step 1: Check server status...');
    try {
      const pingResult = await axios.get(`${SERVER_URL}/ping`);
      console.log('✅ Server is responding');
    } catch (error) {
      console.log('❌ Server not responding:', error.message);
      console.log('💡 Make sure the server is running on port 8080');
      return;
    }
    
    console.log('\n📊 Step 2: Check if ViewBotClientService is initialized...');
    
    // Try to get health status to see if ViewBotClientService exists
    try {
      const healthResult = await axios.get(`${SERVER_URL}/admin/viewbot-client/health`, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      console.log('✅ ViewBotClientService is responding');
      console.log('📊 Service status:', healthResult.data.status);
      console.log('📊 Total bots:', healthResult.data.totalBots);
    } catch (error) {
      if (error.response?.status === 503) {
        console.log('❌ ViewBotClientService not initialized');
        console.log('💡 This means MediaSoup/ViewBot services failed to start');
        console.log('💡 Check server startup logs for MediaSoup errors');
        return;
      } else if (error.response?.status === 401) {
        console.log('❌ Authentication required');
        console.log('💡 Try running the server with proper authentication setup');
        return;
      } else {
        console.log('❌ Unknown error checking ViewBot health:', error.message);
        return;
      }
    }
    
    console.log('\n📊 Step 3: Try to create a simple test ViewBot...');
    
    let createResult;
    try {
      createResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, {
        contentType: 'testPattern',
        testPattern: 'color-bars',
        width: 640,
        height: 480,
        frameRate: 15,
        videoBitrate: '500k',
        audioBitrate: '64k',
        autoStart: false,
        streamDuration: 0,
        timeAllotment: 60000
      }, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      
      if (createResult.data.success) {
        console.log('✅ ViewBot created successfully');
        console.log('🤖 Bot ID:', createResult.data.botId.substring(0, 12) + '...');
      } else {
        console.log('❌ ViewBot creation failed:', createResult.data.message);
        return;
      }
    } catch (error) {
      console.log('❌ ViewBot creation request failed:', error.response?.data?.error || error.message);
      return;
    }
    
    const botId = createResult.data.botId;
    
    console.log('\n📊 Step 4: Check ViewBot status after creation...');
    
    // Wait a moment for bot to initialize
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
      const statusResult = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      
      const bot = statusResult.data.bots.find(b => b.botId === botId);
      if (bot) {
        console.log('📊 ViewBot found in status:');
        console.log('   ID:', bot.botId.substring(0, 12) + '...');
        console.log('   Connected:', bot.isConnected);
        console.log('   Streaming:', bot.isStreaming);
        console.log('   Content:', bot.config.contentType);
        console.log('   Last Error:', bot.lastError || 'None');
        
        if (!bot.isConnected) {
          console.log('❌ ViewBot is not connected to server');
          console.log('💡 This indicates socket connection issues');
          console.log('💡 Check server logs for socket errors');
        } else {
          console.log('✅ ViewBot is connected to server');
        }
      } else {
        console.log('❌ ViewBot not found in status list');
        return;
      }
    } catch (error) {
      console.log('❌ Could not check ViewBot status:', error.message);
      return;
    }
    
    console.log('\n📊 Step 5: Try to start ViewBot streaming...');
    console.log('💡 Watch server logs closely for detailed error information');
    
    try {
      const startResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/start`, {}, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      
      if (startResult.data.success) {
        console.log('✅ ViewBot start request accepted');
        console.log('💡 Check server logs to see if streaming actually begins');
      } else {
        console.log('❌ ViewBot start request rejected:', startResult.data.message);
        
        if (startResult.data.message.includes('real streamer')) {
          console.log('💡 Real streamer protection is active - try disabling it');
        } else if (startResult.data.message.includes('not connected')) {
          console.log('💡 ViewBot socket connection issue');
        } else if (startResult.data.message.includes('already streaming')) {
          console.log('💡 ViewBot thinks it is already streaming');
        }
      }
    } catch (error) {
      console.log('❌ ViewBot start request failed:', error.response?.data?.error || error.message);
    }
    
    console.log('\n📊 Step 6: Final status check (after 10 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    try {
      const finalResult = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      
      const finalBot = finalResult.data.bots.find(b => b.botId === botId);
      if (finalBot) {
        console.log('📊 Final ViewBot status:');
        console.log('   Connected:', finalBot.isConnected);
        console.log('   Streaming:', finalBot.isStreaming);
        console.log('   Uptime:', finalBot.uptime + 'ms');
        console.log('   Last Error:', finalBot.lastError || 'None');
        
        if (finalBot.isStreaming) {
          console.log('✅ SUCCESS: ViewBot is streaming!');
        } else {
          console.log('❌ ISSUE: ViewBot is not streaming');
          console.log('💡 Check server logs for FFmpeg, MediaSoup, or WebRTC errors');
        }
      }
    } catch (error) {
      console.log('❌ Could not get final status');
    }
    
    console.log('\n🧹 Cleaning up test ViewBot...');
    try {
      await axios.delete(`${SERVER_URL}/admin/viewbot-client/${botId}`, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      console.log('✅ Test ViewBot destroyed');
    } catch (error) {
      console.log('ℹ️ Could not destroy test ViewBot (may already be gone)');
    }
    
  } catch (error) {
    console.error('❌ Debug test failed:', error.message);
  }
}

console.log('🚀 Starting ViewBot Debug Test...');
console.log('📋 This test will:');
console.log('   1. Check server status');
console.log('   2. Verify ViewBotClientService is running');
console.log('   3. Create a test ViewBot');
console.log('   4. Try to start streaming');
console.log('   5. Monitor the results');
console.log('\n💡 Watch the server console for detailed logs during this test!\n');

debugViewBotSimple();