/**
 * Test script for ViewBot functionality
 * This tests the ViewBot's ability to:
 * 1. Create bot clients
 * 2. Start streaming with FFmpeg
 * 3. Interrupt current streams (takeover)
 * 4. Stream video content to viewers
 */

const axios = require('axios');
const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = 'your-secret-admin-key-123';

// Helper function to delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

async function testViewBotCreation() {
  console.log(`${colors.cyan}🤖 Testing ViewBot Creation...${colors.reset}`);
  
  try {
    const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create`, {
      config: {
        contentType: 'testPattern',
        testPattern: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30
      }
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (response.data.success) {
      console.log(`${colors.green}✅ ViewBot created successfully: ${response.data.botId}${colors.reset}`);
      return response.data.botId;
    } else {
      console.log(`${colors.red}❌ Failed to create ViewBot: ${response.data.message}${colors.reset}`);
      return null;
    }
  } catch (error) {
    console.error(`${colors.red}❌ Error creating ViewBot:`, error.response?.data || error.message, colors.reset);
    return null;
  }
}

async function testViewBotStreaming(botId) {
  console.log(`${colors.cyan}🎬 Testing ViewBot Streaming for bot ${botId}...${colors.reset}`);
  
  try {
    const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/${botId}/start`, {}, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (response.data.success) {
      console.log(`${colors.green}✅ ViewBot ${botId} started streaming${colors.reset}`);
      return true;
    } else {
      console.log(`${colors.red}❌ Failed to start streaming: ${response.data.message}${colors.reset}`);
      return false;
    }
  } catch (error) {
    console.error(`${colors.red}❌ Error starting stream:`, error.response?.data || error.message, colors.reset);
    return false;
  }
}

async function testStreamTakeover() {
  console.log(`${colors.cyan}🔄 Testing Stream Takeover...${colors.reset}`);
  
  // Create a regular viewer socket to observe the takeover
  const viewerSocket = io(SERVER_URL, {
    transports: ['websocket']
  });
  
  return new Promise((resolve) => {
    viewerSocket.on('connect', () => {
      console.log(`${colors.blue}👁️ Viewer connected to observe takeover${colors.reset}`);
      
      // Join as viewer
      viewerSocket.emit('join-as-viewer', { username: 'TestViewer' });
    });
    
    viewerSocket.on('stream-takeover', (data) => {
      console.log(`${colors.yellow}📢 Stream takeover detected! New streamer: ${data.newStreamerId}${colors.reset}`);
    });
    
    viewerSocket.on('stream-ready', (data) => {
      if (data.isViewBot) {
        console.log(`${colors.green}✅ ViewBot stream is ready for viewers!${colors.reset}`);
        console.log(`   Stream Type: ${data.streamType}`);
        console.log(`   Has Video: ${data.hasVideo}`);
        console.log(`   Has Audio: ${data.hasAudio}`);
        viewerSocket.disconnect();
        resolve(true);
      }
    });
    
    viewerSocket.on('stream-ended', (data) => {
      console.log(`${colors.yellow}📺 Previous stream ended: ${data.reason}${colors.reset}`);
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      console.log(`${colors.red}❌ Timeout waiting for stream events${colors.reset}`);
      viewerSocket.disconnect();
      resolve(false);
    }, 10000);
  });
}

async function getViewBotStatus(botId) {
  try {
    const response = await axios.get(`${SERVER_URL}/admin/viewbot-client/${botId}/status`, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (response.data.success) {
      return response.data;
    }
  } catch (error) {
    console.error(`${colors.red}❌ Error getting status:`, error.response?.data || error.message, colors.reset);
  }
  return null;
}

async function cleanupViewBot(botId) {
  console.log(`${colors.cyan}🧹 Cleaning up ViewBot ${botId}...${colors.reset}`);
  
  try {
    const response = await axios.delete(`${SERVER_URL}/admin/viewbot-client/${botId}`, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (response.data.success) {
      console.log(`${colors.green}✅ ViewBot ${botId} destroyed${colors.reset}`);
    }
  } catch (error) {
    console.error(`${colors.red}❌ Error destroying ViewBot:`, error.response?.data || error.message, colors.reset);
  }
}

async function runFullTest() {
  console.log(`${colors.magenta}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.magenta}🧪 VIEWBOT COMPREHENSIVE TEST SUITE${colors.reset}`);
  console.log(`${colors.magenta}${'='.repeat(60)}${colors.reset}\n`);
  
  let botId = null;
  
  try {
    // Test 1: Create ViewBot
    console.log(`${colors.yellow}Test 1: Create ViewBot${colors.reset}`);
    botId = await testViewBotCreation();
    if (!botId) {
      console.log(`${colors.red}❌ Test failed: Could not create ViewBot${colors.reset}`);
      return;
    }
    await delay(2000);
    
    // Test 2: Start ViewBot Streaming
    console.log(`\n${colors.yellow}Test 2: Start ViewBot Streaming${colors.reset}`);
    const streamStarted = await testViewBotStreaming(botId);
    if (!streamStarted) {
      console.log(`${colors.red}❌ Test failed: Could not start streaming${colors.reset}`);
      return;
    }
    await delay(2000);
    
    // Test 3: Verify Stream Takeover
    console.log(`\n${colors.yellow}Test 3: Verify Stream Takeover & Viewer Notification${colors.reset}`);
    const takeoverSuccess = await testStreamTakeover();
    if (!takeoverSuccess) {
      console.log(`${colors.red}❌ Test failed: Stream takeover not working properly${colors.reset}`);
    }
    
    // Test 4: Check ViewBot Status
    console.log(`\n${colors.yellow}Test 4: Check ViewBot Status${colors.reset}`);
    const status = await getViewBotStatus(botId);
    if (status) {
      console.log(`${colors.green}✅ ViewBot Status:${colors.reset}`);
      console.log(`   Connected: ${status.isConnected}`);
      console.log(`   Streaming: ${status.isStreaming}`);
      console.log(`   Uptime: ${status.uptime}ms`);
    }
    
    // Let it stream for a few seconds
    console.log(`\n${colors.cyan}⏳ Letting ViewBot stream for 5 seconds...${colors.reset}`);
    await delay(5000);
    
  } catch (error) {
    console.error(`${colors.red}❌ Test suite error:`, error, colors.reset);
  } finally {
    // Cleanup
    if (botId) {
      await cleanupViewBot(botId);
    }
    
    console.log(`\n${colors.magenta}${'='.repeat(60)}${colors.reset}`);
    console.log(`${colors.magenta}🏁 TEST SUITE COMPLETED${colors.reset}`);
    console.log(`${colors.magenta}${'='.repeat(60)}${colors.reset}`);
    
    process.exit(0);
  }
}

// Run the test suite
runFullTest().catch(console.error);