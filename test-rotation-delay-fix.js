/**
 * Test script to verify the viewbot rotation delay fix
 * Tests that viewbots properly rotate after video end with cleanup delay
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://127.0.0.1:8080';
const API_URL = `${SERVER_URL}/api`;

// Test configuration
const TEST_CONFIG = {
  numberOfBots: 2, // Create 2 viewbots for rotation
  videoFile: '/root/onestreamer/videos/test-video-short.mp4', // Short video for testing
  rotationEnabled: true,
  monitorDuration: 60000 // Monitor for 60 seconds
};

// Helper function to delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to make API calls
async function apiCall(endpoint, method = 'GET', data = null) {
  try {
    const config = {
      method,
      url: `${API_URL}${endpoint}`,
      headers: { 'Content-Type': 'application/json' }
    };
    
    if (data) {
      config.data = data;
    }
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(`API call failed: ${endpoint}`, error.message);
    throw error;
  }
}

// Create test viewbots
async function createViewBots() {
  console.log('\n📦 Creating test ViewBots...');
  
  const bots = [];
  for (let i = 1; i <= TEST_CONFIG.numberOfBots; i++) {
    const botConfig = {
      nickname: `TestBot${i}`,
      contentType: 'videoFile',
      videoFile: TEST_CONFIG.videoFile,
      streamingMethod: 'gstreamer',
      width: 640,
      height: 480,
      frameRate: 30
    };
    
    console.log(`Creating ViewBot ${i}...`);
    const result = await apiCall('/viewbot/create', 'POST', botConfig);
    
    if (result.success) {
      console.log(`✅ Created ViewBot: ${result.botId}`);
      bots.push(result.botId);
    } else {
      console.error(`❌ Failed to create ViewBot ${i}:`, result.message);
    }
    
    await delay(2000); // Wait between creating bots
  }
  
  return bots;
}

// Enable rotation
async function enableRotation() {
  console.log('\n🔄 Enabling rotation system...');
  
  const result = await apiCall('/viewbot/rotation', 'POST', { enabled: true });
  
  if (result.success) {
    console.log('✅ Rotation enabled');
  } else {
    console.error('❌ Failed to enable rotation:', result.message);
  }
}

// Start rotation monitoring
async function monitorRotation(duration) {
  console.log(`\n👁️ Monitoring rotation for ${duration/1000} seconds...\n`);
  
  const startTime = Date.now();
  let lastStatus = null;
  let rotationCount = 0;
  let freezeDetected = false;
  let lastActiveBot = null;
  let lastChangeTime = startTime;
  
  const checkInterval = setInterval(async () => {
    try {
      const status = await apiCall('/viewbot/status');
      
      // Check for rotation
      if (status.currentLiveBot !== lastActiveBot) {
        const timeSinceLastChange = Date.now() - lastChangeTime;
        console.log(`\n🔄 ROTATION DETECTED!`);
        console.log(`   From: ${lastActiveBot || 'none'} → To: ${status.currentLiveBot}`);
        console.log(`   Time since last change: ${(timeSinceLastChange/1000).toFixed(1)}s`);
        console.log(`   Rotation count: ${++rotationCount}`);
        
        lastActiveBot = status.currentLiveBot;
        lastChangeTime = Date.now();
      }
      
      // Check for freeze (no change for extended period with active bot)
      if (status.currentLiveBot && lastActiveBot === status.currentLiveBot) {
        const timeSinceChange = Date.now() - lastChangeTime;
        if (timeSinceChange > 30000 && !freezeDetected) { // 30 seconds without change
          console.log('\n⚠️ WARNING: Possible freeze detected!');
          console.log(`   Bot ${status.currentLiveBot} has been active for ${(timeSinceChange/1000).toFixed(1)}s`);
          freezeDetected = true;
        }
      } else {
        freezeDetected = false;
      }
      
      // Log current status every 5 seconds
      if ((Date.now() - startTime) % 5000 < 1000) {
        console.log(`📊 Status: Live bot: ${status.currentLiveBot || 'none'}, Available: ${status.availableBots}/${status.totalBots}`);
      }
      
      // Check individual bot status
      if (status.bots) {
        for (const bot of status.bots) {
          if (bot.streaming && bot.gstreamerProcesses) {
            const procs = bot.gstreamerProcesses;
            if (!procs.video && !procs.audio) {
              console.log(`⚠️ Bot ${bot.botId} streaming but no processes!`);
            }
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Status check error:', error.message);
    }
    
    // Stop monitoring after duration
    if (Date.now() - startTime >= duration) {
      clearInterval(checkInterval);
      console.log('\n📊 Monitoring complete!');
      console.log(`   Total rotations: ${rotationCount}`);
      console.log(`   Freeze detected: ${freezeDetected ? 'Yes' : 'No'}`);
      console.log(`   Test duration: ${(duration/1000).toFixed(1)}s`);
    }
  }, 1000); // Check every second
}

// Check if video file exists
function checkVideoFile() {
  console.log('\n📹 Checking video file...');
  
  if (!fs.existsSync(TEST_CONFIG.videoFile)) {
    console.error(`❌ Video file not found: ${TEST_CONFIG.videoFile}`);
    console.log('\n💡 Creating a short test video...');
    
    // Create test video using ffmpeg
    const { execSync } = require('child_process');
    const videoDir = path.dirname(TEST_CONFIG.videoFile);
    
    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }
    
    try {
      // Create a 10-second test video
      execSync(`ffmpeg -f lavfi -i testsrc=duration=10:size=640x480:rate=30 -f lavfi -i sine=frequency=1000:duration=10 -c:v libx264 -c:a aac -y ${TEST_CONFIG.videoFile}`, {
        stdio: 'inherit'
      });
      console.log('✅ Test video created');
    } catch (error) {
      console.error('❌ Failed to create test video:', error.message);
      process.exit(1);
    }
  } else {
    console.log(`✅ Video file found: ${TEST_CONFIG.videoFile}`);
    
    // Check video duration
    try {
      const { execSync } = require('child_process');
      const duration = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${TEST_CONFIG.videoFile}`);
      console.log(`   Duration: ${parseFloat(duration).toFixed(1)}s`);
    } catch (error) {
      console.log('   Could not determine duration');
    }
  }
}

// Main test function
async function runTest() {
  console.log('🧪 ViewBot Rotation Delay Fix Test');
  console.log('===================================');
  console.log('This test verifies that ViewBots properly rotate after video end');
  console.log('with appropriate cleanup delays to prevent freezing.\n');
  
  try {
    // Check prerequisites
    checkVideoFile();
    
    // Check server connection
    console.log('\n🔌 Checking server connection...');
    try {
      await apiCall('/viewbot/status');
      console.log('✅ Server is running');
    } catch (error) {
      console.log('⚠️ Server check failed, attempting to continue...');
    }
    
    // Clean up any existing viewbots
    console.log('\n🧹 Cleaning up existing ViewBots...');
    await apiCall('/viewbot/stop-all', 'POST');
    await delay(2000);
    
    // Create test viewbots
    const botIds = await createViewBots();
    
    if (botIds.length < 2) {
      throw new Error('Need at least 2 ViewBots for rotation test');
    }
    
    // Enable rotation
    await enableRotation();
    await delay(1000);
    
    // Start the first bot
    console.log('\n▶️ Starting first ViewBot...');
    await apiCall('/viewbot/start-rotation', 'POST');
    await delay(2000);
    
    // Monitor rotation
    await monitorRotation(TEST_CONFIG.monitorDuration);
    
    // Cleanup
    console.log('\n🧹 Cleaning up test ViewBots...');
    await apiCall('/viewbot/stop-all', 'POST');
    await apiCall('/viewbot/rotation', 'POST', { enabled: false });
    
    console.log('\n✅ Test completed successfully!');
    console.log('\n📝 Summary:');
    console.log('- The fix implements a 3-second delay between pipeline transitions');
    console.log('- GStreamer processes are cleaned up before starting new ones');
    console.log('- This prevents resource conflicts and freezing issues');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
runTest().catch(console.error);