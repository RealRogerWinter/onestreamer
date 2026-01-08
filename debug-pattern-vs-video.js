/**
 * Debug script to compare working test patterns vs failing video files
 * This will help identify exactly where video file ViewBots fail
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function debugPatternVsVideo() {
  console.log('🔍 Debug: Test Pattern vs Video File ViewBots\n');
  
  try {
    // Step 1: Create a test pattern ViewBot (should work)
    console.log('=== STEP 1: Test Pattern ViewBot (Control) ===');
    const patternBot = await createViewBot('testPattern', {
      contentType: 'testPattern',
      testPattern: 'color-bars',
      width: 640,
      height: 480,
      frameRate: 30
    });
    
    if (!patternBot.success) {
      console.error('❌ Test pattern ViewBot creation failed:', patternBot.message);
      return;
    }
    
    console.log(`✅ Test pattern ViewBot created: ${patternBot.botId}`);
    
    // Wait and check status
    await new Promise(resolve => setTimeout(resolve, 5000));
    await checkViewBotStatus(patternBot.botId, 'TEST PATTERN');
    
    // Step 2: Create a video file ViewBot (should fail?)
    console.log('\n=== STEP 2: Video File ViewBot (Problem Case) ===');
    
    // Use any existing file for testing (doesn't matter if it's not a real video)
    const testFilePath = 'C:\\Windows\\System32\\notepad.exe';
    if (!fs.existsSync(testFilePath)) {
      console.error('❌ Test file not found, skipping video test');
      return;
    }
    
    const videoBot = await createViewBot('videoFile', {
      contentType: 'videoFile',
      videoFile: testFilePath,
      width: 640,
      height: 480,
      frameRate: 30
    });
    
    if (!videoBot.success) {
      console.error('❌ Video file ViewBot creation failed:', videoBot.message);
      return;
    }
    
    console.log(`✅ Video file ViewBot created: ${videoBot.botId}`);
    
    // Wait and check status
    await new Promise(resolve => setTimeout(resolve, 5000));
    await checkViewBotStatus(videoBot.botId, 'VIDEO FILE');
    
    // Step 3: Compare producer status
    console.log('\n=== STEP 3: Producer Comparison ===');
    await compareProducers();
    
    // Step 4: Check server-side producer tracking
    console.log('\n=== STEP 4: Server State Analysis ===');
    const serverState = await getServerState();
    
    if (serverState) {
      console.log('📊 Server producer tracking:');
      
      for (const [socketId, producerInfo] of Object.entries(serverState.producers)) {
        console.log(`  Socket ${socketId}: ${producerInfo.count} producers (${producerInfo.kinds?.join(', ') || 'unknown'})`);
      }
      
      console.log(`📺 Current streamer: ${serverState.currentStreamer || 'none'}`);
      console.log(`📋 Notified streamers: [${serverState.notifiedStreamers.join(', ')}]`);
    }
    
    console.log('\n=== ANALYSIS ===');
    console.log('🔍 Key things to check in server logs:');
    console.log('1. Both ViewBots should create producers successfully');
    console.log('2. FFmpeg should start for both (different input sources)');
    console.log('3. RTP ports should be allocated for both');
    console.log('4. "stream-ready" should be emitted for both');
    console.log('5. Video file ViewBot may fail at FFmpeg level due to invalid input');
    
    console.log('\n🎯 Expected differences:');
    console.log('- Test pattern: Uses lavfi input (testsrc2)');
    console.log('- Video file: Uses file input (-i /path/to/file)');
    console.log('- If video file ViewBot fails, likely FFmpeg cannot read the input file');
    
  } catch (error) {
    console.error('❌ Debug failed:', error.message);
  }
}

async function createViewBot(type, config) {
  try {
    const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, {
      ...config,
      autoStart: true
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    return response.data;
  } catch (error) {
    return { success: false, message: error.response?.data?.message || error.message };
  }
}

async function checkViewBotStatus(botId, label) {
  try {
    const response = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    const bot = response.data.activeBots?.find(b => b.botId === botId);
    if (bot) {
      console.log(`📊 ${label} ViewBot Status:`);
      console.log(`  - Connected: ${bot.isConnected}`);
      console.log(`  - Streaming: ${bot.isStreaming}`);
      console.log(`  - Content Type: ${bot.config.contentType}`);
      console.log(`  - Content Source: ${bot.config.testPattern || bot.config.videoFile || 'unknown'}`);
      console.log(`  - Error: ${bot.lastError || 'none'}`);
      console.log(`  - Uptime: ${bot.uptime}ms`);
      
      if (!bot.isStreaming) {
        console.log(`⚠️ ${label} ViewBot is not streaming!`);
      } else {
        console.log(`✅ ${label} ViewBot is streaming successfully`);
      }
    } else {
      console.log(`❌ ${label} ViewBot not found in status`);
    }
  } catch (error) {
    console.error(`❌ Failed to get status for ${label}:`, error.message);
  }
}

async function compareProducers() {
  // This would require a server endpoint to get producer info
  // For now, we'll rely on server logs
  console.log('🔍 Check server console for producer creation messages');
  console.log('   Look for: "ViewBot xxx video producer created" messages');
  console.log('   Compare: Test pattern vs video file producer creation success');
}

async function getServerState() {
  try {
    const response = await axios.get(`${SERVER_URL}/debug/server-state`);
    return response.data;
  } catch (error) {
    console.log('ℹ️ Server state endpoint not available');
    return null;
  }
}

// Run the debug
debugPatternVsVideo();