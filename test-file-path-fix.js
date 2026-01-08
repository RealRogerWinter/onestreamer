/**
 * Test script to verify the file path fix for ViewBot video streaming
 * This tests both proper file paths and edge cases
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testFilePathFix() {
  console.log('🔧 Testing File Path Fix for ViewBot Video Streaming\n');
  
  try {
    // Test 1: Create a test video file with spaces in the name
    const testVideoPath = await createTestVideoWithSpaces();
    console.log(`📹 Test video with spaces created: ${testVideoPath}`);
    
    // Test 2: Try creating ViewBot with the spaced filename
    console.log('\n=== TEST 1: ViewBot with Spaced Filename ===');
    const result1 = await testViewBotWithFile(testVideoPath, 'Spaced Filename');
    
    // Test 3: Test with a directory path (should fail gracefully)
    console.log('\n=== TEST 2: ViewBot with Directory Path (Should Fail) ===');
    const dirPath = path.dirname(testVideoPath);
    const result2 = await testViewBotWithFile(dirPath, 'Directory Path');
    
    // Test 4: Test with non-existent file (should fail gracefully) 
    console.log('\n=== TEST 3: ViewBot with Non-existent File (Should Fail) ===');
    const nonExistentPath = 'C:\\NonExistent\\File.mp4';
    const result3 = await testViewBotWithFile(nonExistentPath, 'Non-existent File');
    
    console.log('\n📋 Test Results Summary:');
    console.log(`✅ Spaced filename: ${result1 ? 'PASSED' : 'FAILED'}`);
    console.log(`✅ Directory detection: ${!result2 ? 'PASSED (correctly rejected)' : 'FAILED'}`);
    console.log(`✅ Missing file detection: ${!result3 ? 'PASSED (correctly rejected)' : 'FAILED'}`);
    
    // Cleanup
    if (fs.existsSync(testVideoPath)) {
      fs.unlinkSync(testVideoPath);
      console.log('\n🧹 Cleaned up test video file');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

async function createTestVideoWithSpaces() {
  const { spawn } = require('child_process');
  const outputPath = path.join(__dirname, 'Test Video With Spaces & Special-Chars.mp4');
  
  // Delete existing file if it exists
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }
  
  return new Promise((resolve, reject) => {
    console.log('🎬 Creating test video with spaces and special characters...');
    
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=5',
      '-f', 'lavfi', 
      '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-t', '5',
      '-y',
      outputPath
    ]);
    
    ffmpeg.stderr.on('data', (data) => {
      // Suppress most FFmpeg output
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

async function testViewBotWithFile(filePath, testName) {
  try {
    console.log(`📋 Testing ${testName}: ${filePath}`);
    
    const config = {
      contentType: 'videoFile',
      videoFile: filePath,
      width: 640,
      height: 480,
      frameRate: 30,
      autoStart: true
    };
    
    const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, config, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (response.data.success) {
      const botId = response.data.botId;
      console.log(`✅ ViewBot created: ${botId}`);
      
      // Wait a moment and check status
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      const bot = statusResponse.data.activeBots?.find(b => b.botId === botId);
      if (bot) {
        console.log(`📊 ViewBot status:`);
        console.log(`  - Streaming: ${bot.isStreaming}`);
        console.log(`  - Error: ${bot.lastError || 'none'}`);
        
        if (bot.isStreaming) {
          console.log(`🎯 SUCCESS: ViewBot is streaming the video file!`);
          return true;
        } else if (bot.lastError) {
          console.log(`❌ FAILED: ${bot.lastError}`);
          return false;
        }
      }
      
      // Clean up the test bot
      await axios.delete(`${SERVER_URL}/admin/viewbot-client/${botId}`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      return false;
    } else {
      console.log(`❌ ViewBot creation failed: ${response.data.message}`);
      return false;
    }
    
  } catch (error) {
    console.log(`❌ Test failed: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

testFilePathFix();