/**
 * Test script to verify file upload endpoint functionality
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testFileUpload() {
  console.log('🔧 Testing File Upload Endpoint\n');
  
  try {
    // Create a simple test video file
    const testVideoPath = await createTestVideo();
    console.log(`📹 Test video created: ${testVideoPath}`);
    
    // Test the upload endpoint
    console.log('\n=== Testing Upload Endpoint ===');
    const formData = new FormData();
    formData.append('video', fs.createReadStream(testVideoPath));
    
    const response = await axios.post(`${SERVER_URL}/admin/upload-video`, formData, {
      headers: {
        'x-admin-key': ADMIN_KEY,
        ...formData.getHeaders()
      }
    });
    
    console.log('📡 Upload response:', response.status, response.statusText);
    console.log('📋 Response data:');
    console.log(JSON.stringify(response.data, null, 2));
    
    if (response.data.success) {
      console.log('\n✅ Upload successful!');
      console.log(`📁 File path returned: ${response.data.filePath}`);
      
      // Verify the file was actually saved
      if (fs.existsSync(response.data.filePath)) {
        console.log('✅ File exists on server');
        const stats = fs.statSync(response.data.filePath);
        console.log(`📊 File size: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
      } else {
        console.log('❌ File not found on server!');
      }
    } else {
      console.log('❌ Upload failed:', response.data.error);
    }
    
    // Cleanup
    if (fs.existsSync(testVideoPath)) {
      fs.unlinkSync(testVideoPath);
      console.log('\n🧹 Cleaned up test video');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

async function createTestVideo() {
  const { spawn } = require('child_process');
  const outputPath = path.join(__dirname, 'upload_test_video.mp4');
  
  // Delete existing file if it exists
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }
  
  return new Promise((resolve, reject) => {
    console.log('🎬 Creating small test video...');
    
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=3',
      '-f', 'lavfi', 
      '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-t', '3',
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

testFileUpload();