/**
 * Test script to manually verify video file path handling
 * This bypasses the upload UI and tests direct file path input
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testManualVideoPath() {
  console.log('🔍 Testing Manual Video File Path Handling\n');
  
  try {
    // Create a simple test video file first
    const testVideoPath = await createTestVideo();
    console.log(`📹 Test video created: ${testVideoPath}`);
    
    // Test 1: Create ViewBot with the test video path manually
    console.log('\n=== TEST 1: ViewBot with Manual Video File Path ===');
    const config = {
      contentType: 'videoFile',
      videoFile: testVideoPath,
      width: 640,
      height: 480,
      frameRate: 30,
      autoStart: true
    };
    
    console.log('📋 Creating ViewBot with config:');
    console.log(JSON.stringify(config, null, 2));
    
    const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, config, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (!response.data.success) {
      console.error('❌ ViewBot creation failed:', response.data.message);
      return;
    }
    
    const botId = response.data.botId;
    console.log(`✅ ViewBot created: ${botId}`);
    console.log('📋 Server processed config:');
    console.log(JSON.stringify(response.data.config, null, 2));
    
    // Wait for initialization and check multiple times
    console.log('\n⏳ Monitoring ViewBot for 15 seconds...');
    
    for (let i = 0; i < 6; i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      const bot = statusResponse.data.activeBots?.find(b => b.botId === botId);
      if (bot) {
        const secondsElapsed = (i + 1) * 2.5;
        console.log(`\n📊 Status at ${secondsElapsed}s:`);
        console.log(`  - Connected: ${bot.isConnected}`);
        console.log(`  - Streaming: ${bot.isStreaming}`);
        console.log(`  - Error: ${bot.lastError || 'none'}`);
        console.log(`  - Config Type: ${bot.config.contentType}`);
        console.log(`  - Video File: ${bot.config.videoFile}`);
        
        // Check if file still exists
        if (bot.config.videoFile && fs.existsSync(bot.config.videoFile)) {
          console.log(`  - File exists: ✅`);
        } else {
          console.log(`  - File exists: ❌ (${bot.config.videoFile})`);
        }
        
        if (bot.isStreaming) {
          console.log(`\n🎯 SUCCESS! ViewBot is streaming the video file`);
          console.log('\n🌐 Manual verification:');
          console.log('1. Open http://localhost:3000 in browser');
          console.log('2. You should see video content (not stuck on "Switching Stream")');
          console.log('3. Content should be the test pattern video, not static test pattern');
          break;
        } else if (bot.lastError) {
          console.log(`\n❌ ViewBot failed with error: ${bot.lastError}`);
          break;
        }
      } else {
        console.log(`❌ ViewBot not found in status response`);
      }
    }
    
    // Test 2: Try with a non-video file to see difference
    console.log('\n=== TEST 2: ViewBot with Non-Video File (Error Case) ===');
    const invalidConfig = {
      contentType: 'videoFile',
      videoFile: 'C:\\Windows\\System32\\notepad.exe', // Not a video
      width: 640,
      height: 480,
      frameRate: 30,
      autoStart: true
    };
    
    const invalidResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, invalidConfig, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (invalidResponse.data.success) {
      const invalidBotId = invalidResponse.data.botId;
      console.log(`📋 Invalid file ViewBot created: ${invalidBotId}`);
      
      // Wait a moment and check status
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const invalidStatusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      const invalidBot = invalidStatusResponse.data.activeBots?.find(b => b.botId === invalidBotId);
      if (invalidBot) {
        console.log(`📊 Invalid file ViewBot status:`);
        console.log(`  - Streaming: ${invalidBot.isStreaming}`);
        console.log(`  - Error: ${invalidBot.lastError || 'none'}`);
        
        if (invalidBot.lastError) {
          console.log(`✅ Expected error occurred: ${invalidBot.lastError}`);
        } else {
          console.log(`⚠️ No error detected - this might be unexpected`);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

async function createTestVideo() {
  const { spawn } = require('child_process');
  const outputPath = path.join(__dirname, 'manual_test_video.mp4');
  
  // Delete existing file if it exists
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }
  
  return new Promise((resolve, reject) => {
    console.log('🎬 Creating test video with FFmpeg...');
    
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=10',
      '-f', 'lavfi', 
      '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-t', '10',
      '-y',
      outputPath
    ]);
    
    ffmpeg.stderr.on('data', (data) => {
      // Suppress most output
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg failed with code ${code}`));
      }
    });
    
    ffmpeg.on('error', (error) => {
      reject(error);
    });
  });
}

testManualVideoPath();