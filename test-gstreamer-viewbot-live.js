/**
 * Live test for GStreamer ViewBot with video file
 */

const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:8080';

// Find a test video file
function findTestVideo() {
  const possibleVideos = [
    'C:\\onestreamer\\server\\uploads\\scarface_1754871639821.mp4',
    'C:\\onestreamer\\server\\uploads\\old_1754969968120.mp4',
    'C:\\onestreamer\\server\\uploads\\friend_1754877820693.mp4'
  ];
  
  for (const video of possibleVideos) {
    if (fs.existsSync(video)) {
      return video;
    }
  }
  
  // List available videos
  const uploadsDir = 'C:\\onestreamer\\server\\uploads';
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    const mp4Files = files.filter(f => f.endsWith('.mp4'));
    if (mp4Files.length > 0) {
      return path.join(uploadsDir, mp4Files[0]);
    }
  }
  
  return null;
}

async function testGStreamerViewBot() {
  console.log('🧪 Testing GStreamer ViewBot with Video File');
  console.log('============================================\n');
  
  const testVideo = findTestVideo();
  if (!testVideo) {
    console.error('❌ No test video found in uploads directory');
    console.log('Please upload a video file first');
    return;
  }
  
  console.log(`✅ Using test video: ${testVideo}`);
  console.log(`   File size: ${(fs.statSync(testVideo).size / 1024 / 1024).toFixed(2)} MB\n`);
  
  // Connect to server
  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: false
  });
  
  await new Promise((resolve, reject) => {
    socket.on('connect', () => {
      console.log('✅ Connected to server\n');
      resolve();
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ Connection failed:', error.message);
      reject(error);
    });
  });
  
  // Set up event listeners
  socket.on('viewbot-created', (data) => {
    console.log('🤖 ViewBot created:', data);
  });
  
  socket.on('viewbot-started', (data) => {
    console.log('▶️ ViewBot started:', data);
  });
  
  socket.on('viewbot-error', (data) => {
    console.error('❌ ViewBot error:', data);
  });
  
  socket.on('viewbot-producer-created', (data) => {
    console.log('📺 Producer created:', data);
  });
  
  // Test 1: Create ViewBot with GStreamer explicitly enabled
  console.log('=== TEST 1: Creating GStreamer ViewBot ===');
  
  const botConfig = {
    name: 'GStreamer Test Bot',
    contentType: 'videoFile',
    videoFile: testVideo,
    useGStreamer: true,  // Explicitly enable GStreamer
    width: 1280,
    height: 720,
    frameRate: 30,
    autoStart: true
  };
  
  console.log('📤 Sending config:', JSON.stringify(botConfig, null, 2));
  
  const response = await fetch(`${SERVER_URL}/api/viewbot/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(botConfig)
  });
  
  const result = await response.json();
  
  if (result.success) {
    console.log(`\n✅ ViewBot created successfully!`);
    console.log(`   Bot ID: ${result.botId}`);
    console.log(`   Method: ${result.method || 'unknown'}`);
    
    // Wait for streaming to start
    console.log('\n⏳ Waiting for streaming to initialize...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check status
    const statusResponse = await fetch(`${SERVER_URL}/api/viewbot/${result.botId}/status`);
    const status = await statusResponse.json();
    
    console.log('\n📊 ViewBot Status:');
    console.log(JSON.stringify(status, null, 2));
    
    // Let it run for a bit
    console.log('\n▶️ Streaming for 10 seconds...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Stop the bot
    console.log('\n⏹️ Stopping ViewBot...');
    await fetch(`${SERVER_URL}/api/viewbot/${result.botId}/stop`, {
      method: 'POST'
    });
    
    console.log('✅ ViewBot stopped');
    
  } else {
    console.error(`\n❌ Failed to create ViewBot: ${result.message}`);
  }
  
  // Test 2: Check global streaming method
  console.log('\n=== TEST 2: Checking Global Streaming Method ===');
  
  const methodResponse = await fetch(`${SERVER_URL}/api/viewbot/streaming-method`);
  if (methodResponse.ok) {
    const methodData = await methodResponse.json();
    console.log('Current streaming method:', methodData.method);
    console.log('Supported methods:', methodData.supported);
    
    // Try to set to GStreamer
    console.log('\nSetting global method to GStreamer...');
    const setMethodResponse = await fetch(`${SERVER_URL}/api/viewbot/streaming-method`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'gstreamer' })
    });
    
    if (setMethodResponse.ok) {
      console.log('✅ Global method set to GStreamer');
    } else {
      console.log('❌ Failed to set global method');
    }
  }
  
  socket.disconnect();
  console.log('\n✅ Test completed');
}

// Run test
testGStreamerViewBot().catch(console.error).finally(() => process.exit(0));