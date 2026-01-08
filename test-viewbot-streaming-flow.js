/**
 * Comprehensive test to diagnose ViewBot streaming issues
 * This test will trace the entire flow from button click to viewer consumption
 */

const axios = require('axios');
const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

let testSocket = null;
let streamReadyReceived = false;
let viewBotStreamingApproved = false;

async function testViewBotStreamingFlow() {
  console.log('🔍 Testing Complete ViewBot Streaming Flow\n');
  
  try {
    // Step 1: Connect a test socket to monitor server events
    console.log('1. Setting up test socket to monitor server events...');
    testSocket = io(SERVER_URL);
    
    testSocket.on('connect', () => {
      console.log(`✅ Test socket connected: ${testSocket.id}`);
    });
    
    testSocket.on('stream-ready', (data) => {
      console.log(`📺 STREAM-READY received:`, data);
      streamReadyReceived = true;
      
      if (data.isViewBot) {
        console.log(`✅ ViewBot stream ready detected for bot: ${data.botId}`);
      }
    });
    
    testSocket.on('stream-status', (data) => {
      console.log(`📊 STREAM-STATUS update:`, {
        isStreaming: data.isStreaming,
        streamer: data.streamer,
        viewerCount: data.viewerCount
      });
    });
    
    testSocket.on('stream-started', (data) => {
      console.log(`🎬 STREAM-STARTED event:`, data);
    });
    
    testSocket.on('stream-ended', (data) => {
      console.log(`🛑 STREAM-ENDED event:`, data);
    });
    
    // Wait for socket connection
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 2: Clean up any existing ViewBots
    console.log('\n2. Cleaning up existing ViewBots...');
    try {
      await axios.delete(`${SERVER_URL}/admin/viewbot-client/all`, {
        headers: { 'Authorization': `Bearer ${ADMIN_KEY}` }
      });
      console.log('🧹 Existing ViewBots cleaned up');
    } catch (error) {
      console.log('ℹ️ No existing ViewBots to clean up (or auth issue)');
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 3: Create a test ViewBot
    console.log('\n3. Creating test ViewBot...');
    let createResult;
    try {
      createResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, {
        contentType: 'testPattern',
        testPattern: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30,
        videoBitrate: '1000k',
        audioBitrate: '128k',
        autoStart: false,
        streamDuration: 0,
        timeAllotment: 120000 // 2 minutes
      }, {
        headers: { 'Authorization': `Bearer ${ADMIN_KEY}` }
      });
      
      if (createResult.data.success) {
        console.log(`✅ ViewBot created: ${createResult.data.botId.substring(0, 12)}...`);
      } else {
        console.log(`❌ ViewBot creation failed: ${createResult.data.message}`);
        return;
      }
    } catch (error) {
      console.log(`❌ ViewBot creation request failed: ${error.response?.data?.error || error.message}`);
      console.log('🔧 This might be an authentication issue - checking alternative approach...');
      
      // Try without auth to see if that's the issue
      try {
        createResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, {
          contentType: 'testPattern',
          testPattern: 'color-bars',
          width: 1280,
          height: 720,
          frameRate: 30,
          videoBitrate: '1000k',
          audioBitrate: '128k',
          autoStart: false,
          streamDuration: 0,
          timeAllotment: 120000 // 2 minutes
        }, {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
        
        if (createResult.data.success) {
          console.log(`✅ ViewBot created with legacy auth: ${createResult.data.botId.substring(0, 12)}...`);
        } else {
          console.log(`❌ ViewBot creation failed even with legacy auth: ${createResult.data.message}`);
          return;
        }
      } catch (error2) {
        console.log(`❌ Both auth methods failed. Server might not be running or auth is required.`);
        console.log(`Error: ${error2.response?.data?.error || error2.message}`);
        return;
      }
    }
    
    const botId = createResult.data.botId;
    console.log(`🤖 Test ViewBot ID: ${botId}`);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 4: Check ViewBot status
    console.log('\n4. Checking ViewBot status...');
    try {
      const statusResult = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: { 'Authorization': `Bearer ${ADMIN_KEY}` }
      });
      
      const bot = statusResult.data.bots.find(b => b.botId === botId);
      if (bot) {
        console.log(`📊 ViewBot Status:`);
        console.log(`   Connected: ${bot.isConnected}`);
        console.log(`   Streaming: ${bot.isStreaming}`);
        console.log(`   Content Type: ${bot.config.contentType}`);
        console.log(`   Resolution: ${bot.config.width}x${bot.config.height}`);
      } else {
        console.log(`❌ ViewBot not found in status list`);
        return;
      }
    } catch (error) {
      // Try legacy auth
      try {
        const statusResult = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
        
        const bot = statusResult.data.bots.find(b => b.botId === botId);
        if (bot) {
          console.log(`📊 ViewBot Status (legacy auth):`);
          console.log(`   Connected: ${bot.isConnected}`);
          console.log(`   Streaming: ${bot.isStreaming}`);
        }
      } catch (error2) {
        console.log(`❌ Could not check ViewBot status: ${error2.message}`);
      }
    }
    
    // Step 5: Start ViewBot streaming
    console.log('\n5. Starting ViewBot streaming...');
    let startResult;
    try {
      startResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/start`, {}, {
        headers: { 'Authorization': `Bearer ${ADMIN_KEY}` }
      });
    } catch (error) {
      // Try legacy auth
      try {
        startResult = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/start`, {}, {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
      } catch (error2) {
        console.log(`❌ Could not start ViewBot: ${error2.message}`);
        return;
      }
    }
    
    if (startResult.data.success) {
      console.log(`✅ ViewBot start request successful`);
    } else {
      console.log(`❌ ViewBot start failed: ${startResult.data.message}`);
      return;
    }
    
    // Step 6: Monitor for stream events
    console.log('\n6. Monitoring for stream events (30 seconds)...');
    console.log('   Listening for:');
    console.log('   - stream-ready (ViewBot stream becomes available)');
    console.log('   - stream-status updates');
    console.log('   - stream-started events');
    
    const monitoringStartTime = Date.now();
    const monitoringDuration = 30000; // 30 seconds
    
    const monitoringInterval = setInterval(() => {
      const elapsed = Date.now() - monitoringStartTime;
      const remaining = Math.max(0, monitoringDuration - elapsed);
      const seconds = Math.floor(remaining / 1000);
      
      if (seconds > 0) {
        process.stdout.write(`\r⏱️  Monitoring... ${seconds}s remaining`);
      } else {
        console.log(`\n⏰ Monitoring period complete`);
        clearInterval(monitoringInterval);
      }
    }, 1000);
    
    await new Promise(resolve => setTimeout(resolve, monitoringDuration));
    clearInterval(monitoringInterval);
    
    // Step 7: Final status check
    console.log('\n7. Final status check...');
    try {
      const finalStatusResult = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      
      const bot = finalStatusResult.data.bots.find(b => b.botId === botId);
      if (bot) {
        console.log(`📊 Final ViewBot Status:`);
        console.log(`   Connected: ${bot.isConnected}`);
        console.log(`   Streaming: ${bot.isStreaming}`);
        console.log(`   Uptime: ${bot.uptime}ms`);
        console.log(`   Last Error: ${bot.lastError || 'None'}`);
      }
    } catch (error) {
      console.log(`❌ Could not get final status: ${error.message}`);
    }
    
    // Step 8: Results summary
    console.log('\n8. Test Results Summary:');
    console.log(`📊 Stream Ready Event Received: ${streamReadyReceived ? '✅ YES' : '❌ NO'}`);
    console.log(`🎯 ViewBot Streaming Approved: ${viewBotStreamingApproved ? '✅ YES' : '❌ NO'}`);
    
    if (!streamReadyReceived) {
      console.log('\n🔍 POTENTIAL ISSUES:');
      console.log('❌ ViewBot stream-ready event was not received by viewers');
      console.log('   This means viewers cannot consume the ViewBot stream');
      console.log('   Possible causes:');
      console.log('   1. ViewBot socket connection issues');
      console.log('   2. FFmpeg process not starting properly');
      console.log('   3. MediaSoup producer creation failing');
      console.log('   4. WebRTC transport setup issues');
      console.log('   5. Event listener registration problems');
    } else {
      console.log('\n✅ STREAM FLOW WORKING:');
      console.log('✅ ViewBot successfully emitted stream-ready event');
      console.log('✅ Viewers should be able to consume the stream');
    }
    
    // Cleanup
    console.log('\n9. Cleaning up test ViewBot...');
    try {
      await axios.delete(`${SERVER_URL}/admin/viewbot-client/${botId}`, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      console.log('🧹 Test ViewBot destroyed');
    } catch (error) {
      console.log('ℹ️ Could not clean up test ViewBot (may have already been destroyed)');
    }
    
  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
  } finally {
    if (testSocket) {
      testSocket.disconnect();
      console.log('🔌 Test socket disconnected');
    }
  }
}

// Run the test
testViewBotStreamingFlow();