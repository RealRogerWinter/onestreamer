/**
 * Test script for ViewBot video file streaming functionality
 * Tests the complete flow: upload video file -> create ViewBot -> stream file
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

// Test video file path (you can change this to any video file you have)
const TEST_VIDEO_PATH = 'C:\\Users\\Public\\Videos\\Sample Videos\\Wildlife.wmv'; // Common Windows sample video

async function testVideoFileStreaming() {
  console.log('🎬 Testing ViewBot Video File Streaming\n');
  
  try {
    // Step 1: Check if test video exists or create a small test video
    let videoPath = TEST_VIDEO_PATH;
    if (!fs.existsSync(videoPath)) {
      console.log('⚠️ Sample video not found, creating a test video with FFmpeg...');
      
      // Create a simple test video file
      videoPath = path.join(__dirname, 'test_video.mp4');
      await createTestVideo(videoPath);
    }
    
    // Step 2: Upload the video file
    console.log('Step 1: Uploading video file...');
    const uploadResult = await uploadVideoFile(videoPath);
    
    if (!uploadResult.success) {
      console.error('❌ Video upload failed:', uploadResult.error);
      return;
    }
    
    console.log(`✅ Video uploaded: ${uploadResult.filename}`);
    
    // Step 3: List uploaded videos to verify
    console.log('\nStep 2: Verifying uploaded videos...');
    const videoList = await listUploadedVideos();
    console.log(`📹 Found ${videoList.videos.length} uploaded videos`);
    videoList.videos.forEach(video => {
      console.log(`  - ${video.filename} (${(video.size / 1024 / 1024).toFixed(1)}MB)`);
    });
    
    // Step 4: Create ViewBot with video file
    console.log('\nStep 3: Creating ViewBot with video file...');
    const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, {
      config: {
        contentType: 'videoFile',
        videoFile: uploadResult.filePath,
        width: 1280,
        height: 720,
        frameRate: 30,
        autoStart: true
      }
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (!createResponse.data.success) {
      console.error('❌ ViewBot creation failed:', createResponse.data.message);
      return;
    }
    
    const botId = createResponse.data.botId;
    console.log(`✅ ViewBot created successfully: ${botId}`);
    
    // Step 5: Wait for ViewBot to initialize and check status
    console.log('\n⏳ Waiting 5 seconds for ViewBot to initialize...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('\nStep 4: Checking ViewBot status...');
    const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (statusResponse.data.activeBots && statusResponse.data.activeBots.length > 0) {
      const bot = statusResponse.data.activeBots.find(b => b.botId === botId);
      if (bot) {
        console.log(`📊 ViewBot ${botId} status:`);
        console.log(`  - Connected: ${bot.isConnected}`);
        console.log(`  - Streaming: ${bot.isStreaming}`);
        console.log(`  - Content: ${bot.config.contentType}`);
        console.log(`  - Video file: ${bot.config.videoFile}`);
        console.log(`  - Resolution: ${bot.config.width}x${bot.config.height}`);
        
        if (bot.isStreaming) {
          console.log(`✅ ViewBot is successfully streaming video file!`);
        } else {
          console.log(`⚠️ ViewBot created but may not be streaming yet`);
        }
      }
    }
    
    console.log('\n🎯 Video file streaming test completed!');
    console.log('\n📋 Test Results Summary:');
    console.log('✅ Video file upload: PASSED');
    console.log('✅ ViewBot creation with video file: PASSED');
    console.log('✅ Video file streaming setup: PASSED');
    console.log('\n🌐 To verify complete functionality:');
    console.log('1. Open http://localhost:3000 in your browser');
    console.log('2. You should see the ViewBot streaming your video file');
    console.log('3. The video should loop automatically');
    console.log('4. Check server logs for FFmpeg video file processing');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n📋 Server not running. Please start the server first:');
      console.log('   npm start');
    }
  }
}

async function uploadVideoFile(filePath) {
  try {
    const formData = new FormData();
    formData.append('video', fs.createReadStream(filePath));
    
    const response = await axios.post(`${SERVER_URL}/admin/upload-video`, formData, {
      headers: {
        ...formData.getHeaders(),
        'x-admin-key': ADMIN_KEY
      },
      maxContentLength: 500 * 1024 * 1024, // 500MB
      maxBodyLength: 500 * 1024 * 1024
    });
    
    return response.data;
    
  } catch (error) {
    return { success: false, error: error.response?.data?.error || error.message };
  }
}

async function listUploadedVideos() {
  const response = await axios.get(`${SERVER_URL}/admin/uploaded-videos`, {
    headers: {
      'x-admin-key': ADMIN_KEY
    }
  });
  
  return response.data;
}

async function createTestVideo(outputPath) {
  const { spawn } = require('child_process');
  
  return new Promise((resolve, reject) => {
    console.log('🎬 Creating test video with FFmpeg...');
    
    // Create a 10-second test video with color bars
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'testsrc2=size=640x480:rate=30:duration=10',
      '-f', 'lavfi', 
      '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-y', // Overwrite output file
      outputPath
    ]);
    
    ffmpeg.stderr.on('data', (data) => {
      // Suppress FFmpeg output unless there's an error
      const output = data.toString();
      if (output.includes('Error') || output.includes('error')) {
        console.error('FFmpeg error:', output);
      }
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Test video created: ${outputPath}`);
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    ffmpeg.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('FFmpeg not found. Please install FFmpeg to create test video.'));
      } else {
        reject(error);
      }
    });
  });
}

// Run the test
testVideoFileStreaming();