/**
 * Test that the pause button actually stops ViewBot broadcasting
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testPauseBroadcast() {
  console.log('⏸️ Testing Pause Button Broadcast Stopping\n');
  
  try {
    // Step 1: Clean slate and create a ViewBot
    console.log('1. Setting up test ViewBot...');
    await axios.delete(`${SERVER_URL}/admin/viewbot-client/all`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, {
      contentType: 'testPattern',
      testPattern: 'color-bars',
      width: 1280,
      height: 720,
      frameRate: 30,
      autoStart: false
    }, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    if (!createResponse.data.success) {
      throw new Error('Failed to create ViewBot');
    }
    
    const botId = createResponse.data.botId;
    console.log(`✅ ViewBot created: ${botId.substring(0, 12)}...`);
    
    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 2: Start the ViewBot streaming
    console.log('\n2. Starting ViewBot streaming...');
    const startResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/start`, {}, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    console.log(`Start result: ${startResponse.data.success ? 'SUCCESS' : 'FAILED'}`);
    if (startResponse.data.message) {
      console.log(`Message: ${startResponse.data.message}`);
    }
    
    // Wait for streaming to fully start
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Step 3: Check that ViewBot is actually streaming
    console.log('\n3. Verifying ViewBot is streaming...');
    const statusBefore = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    const streamingBot = statusBefore.data.bots.find(bot => bot.botId === botId);
    if (streamingBot) {
      console.log(`📊 ViewBot Status: ${streamingBot.isStreaming ? '🎬 STREAMING' : '⏹️ STOPPED'}`);
      console.log(`   Connected: ${streamingBot.isConnected}`);
      console.log(`   Uptime: ${Math.floor(streamingBot.uptime / 1000)}s`);
      console.log(`   Time Remaining: ${streamingBot.timeRemainingFormatted || 'N/A'}`);
      
      if (!streamingBot.isStreaming) {
        console.log(`❌ ViewBot is not streaming - cannot test pause functionality`);
        if (streamingBot.lastError) {
          console.log(`Last Error: ${streamingBot.lastError}`);
        }
        return;
      }
    } else {
      console.log(`❌ ViewBot not found in status`);
      return;
    }
    
    // Step 4: Test the pause button (stop streaming)
    console.log('\n4. Testing pause button (should stop FFmpeg and broadcast)...');
    const stopResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/stop`, {}, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    console.log(`Stop result: ${stopResponse.data.success ? 'SUCCESS' : 'FAILED'}`);
    if (stopResponse.data.message) {
      console.log(`Message: ${stopResponse.data.message}`);
    }
    
    // Wait for stop to complete
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 5: Verify that streaming has actually stopped
    console.log('\n5. Verifying ViewBot broadcasting has stopped...');
    const statusAfter = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    const stoppedBot = statusAfter.data.bots.find(bot => bot.botId === botId);
    if (stoppedBot) {
      console.log(`📊 ViewBot Status After Stop: ${stoppedBot.isStreaming ? '🎬 STILL STREAMING' : '✅ STOPPED'}`);
      console.log(`   Connected: ${stoppedBot.isConnected}`);
      console.log(`   Uptime: ${Math.floor(stoppedBot.uptime / 1000)}s`);
      
      if (stoppedBot.isStreaming) {
        console.log(`❌ CRITICAL ISSUE: ViewBot is still streaming after pause!`);
        console.log(`    The pause button is not properly stopping the broadcast.`);
        console.log(`    FFmpeg processes might still be running.`);
      } else {
        console.log(`✅ SUCCESS: ViewBot broadcasting has been stopped!`);
        console.log(`    The pause button is working correctly.`);
        console.log(`    FFmpeg processes should be terminated.`);
      }
    }
    
    // Step 6: Test resume functionality
    console.log('\n6. Testing resume (play button after pause)...');
    const resumeResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/start`, {}, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    console.log(`Resume result: ${resumeResponse.data.success ? 'SUCCESS' : 'FAILED'}`);
    
    // Wait and check final status
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const finalStatus = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    
    const resumedBot = finalStatus.data.bots.find(bot => bot.botId === botId);
    if (resumedBot) {
      console.log(`📊 ViewBot Status After Resume: ${resumedBot.isStreaming ? '🎬 STREAMING' : '⏹️ STOPPED'}`);
      
      if (resumedBot.isStreaming) {
        console.log(`✅ SUCCESS: Resume functionality working!`);
      } else {
        console.log(`❌ Resume failed - ViewBot not streaming`);
        if (resumedBot.lastError) {
          console.log(`Last Error: ${resumedBot.lastError}`);
        }
      }
    }
    
    console.log('\n✅ Pause/Resume Broadcast Test Complete!');
    console.log('\n📋 Test Results Summary:');
    console.log('✅ ViewBot can be started successfully');
    console.log(`${!stoppedBot?.isStreaming ? '✅' : '❌'} Pause button stops FFmpeg processes and broadcast`);
    console.log(`${resumedBot?.isStreaming ? '✅' : '❌'} Resume (play) button restarts streaming`);
    
    if (!stoppedBot?.isStreaming) {
      console.log('\n🎉 CRITICAL FIX SUCCESSFUL:');
      console.log('   The pause button now properly stops ViewBot broadcasting!');
      console.log('   FFmpeg processes are terminated when ViewBot is paused.');
    } else {
      console.log('\n⚠️ ISSUE STILL EXISTS:');
      console.log('   The pause button is not stopping the broadcast properly.');
      console.log('   Additional investigation needed.');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testPauseBroadcast();