/**
 * Test script for GStreamer-based ViewBot video file streaming
 * This tests the new GStreamer method alongside the existing FFmpeg method
 */

const io = require('socket.io-client');
const path = require('path');
const fs = require('fs');

const SERVER_URL = 'http://localhost:3000';

// Test configuration
const TEST_CONFIG = {
  testVideo: 'C:\\onestreamer\\uploads\\test.mp4', // Update this path to your test video
  testDuration: 30000, // Test for 30 seconds
  gstreamerBot: {
    name: 'GStreamer Test Bot',
    contentType: 'videoFile',
    videoFile: null, // Will be set to testVideo
    useGStreamer: true, // Enable GStreamer method
    width: 1280,
    height: 720,
    frameRate: 30,
    autoStart: true
  },
  ffmpegBot: {
    name: 'FFmpeg Test Bot',
    contentType: 'videoFile',
    videoFile: null, // Will be set to testVideo
    useGStreamer: false, // Use default FFmpeg method
    width: 1280,
    height: 720,
    frameRate: 30,
    autoStart: false
  }
};

class GStreamerViewBotTester {
  constructor() {
    this.socket = null;
    this.gstreamerBotId = null;
    this.ffmpegBotId = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      console.log('🔌 Connecting to server...');
      this.socket = io(SERVER_URL, {
        transports: ['websocket'],
        reconnection: false
      });

      this.socket.on('connect', () => {
        console.log('✅ Connected to server');
        resolve();
      });

      this.socket.on('connect_error', (error) => {
        console.error('❌ Connection failed:', error.message);
        reject(error);
      });

      this.setupEventHandlers();
    });
  }

  setupEventHandlers() {
    this.socket.on('viewbot-created', (data) => {
      console.log('🤖 ViewBot created:', data);
    });

    this.socket.on('viewbot-started', (data) => {
      console.log('▶️ ViewBot started streaming:', data);
    });

    this.socket.on('viewbot-stopped', (data) => {
      console.log('⏹️ ViewBot stopped streaming:', data);
    });

    this.socket.on('viewbot-error', (data) => {
      console.error('❌ ViewBot error:', data);
    });

    this.socket.on('producer-created', (data) => {
      console.log('📺 Producer created:', data);
    });
  }

  async createViewBot(config) {
    return new Promise((resolve, reject) => {
      console.log(`\n🤖 Creating ViewBot: ${config.name}`);
      console.log(`   Method: ${config.useGStreamer ? 'GStreamer' : 'FFmpeg'}`);
      console.log(`   Video: ${config.videoFile}`);
      
      fetch(`${SERVER_URL}/api/viewbot/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          console.log(`✅ ViewBot created: ${data.botId}`);
          resolve(data);
        } else {
          console.error(`❌ Failed to create ViewBot: ${data.message}`);
          reject(new Error(data.message));
        }
      })
      .catch(reject);
    });
  }

  async startViewBot(botId) {
    return new Promise((resolve, reject) => {
      console.log(`\n▶️ Starting ViewBot: ${botId}`);
      
      fetch(`${SERVER_URL}/api/viewbot/${botId}/start`, {
        method: 'POST'
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          console.log(`✅ ViewBot started: ${botId}`);
          resolve(data);
        } else {
          console.error(`❌ Failed to start ViewBot: ${data.message}`);
          reject(new Error(data.message));
        }
      })
      .catch(reject);
    });
  }

  async stopViewBot(botId) {
    return new Promise((resolve, reject) => {
      console.log(`\n⏹️ Stopping ViewBot: ${botId}`);
      
      fetch(`${SERVER_URL}/api/viewbot/${botId}/stop`, {
        method: 'POST'
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          console.log(`✅ ViewBot stopped: ${botId}`);
          resolve(data);
        } else {
          console.error(`❌ Failed to stop ViewBot: ${data.message}`);
          reject(new Error(data.message));
        }
      })
      .catch(reject);
    });
  }

  async getViewBotStatus(botId) {
    return new Promise((resolve, reject) => {
      fetch(`${SERVER_URL}/api/viewbot/${botId}/status`)
        .then(res => res.json())
        .then(resolve)
        .catch(reject);
    });
  }

  async runTest() {
    try {
      console.log('🧪 Starting GStreamer ViewBot Test');
      console.log('================================\n');

      // Check if test video exists
      const testVideo = TEST_CONFIG.testVideo;
      if (!fs.existsSync(testVideo)) {
        console.error(`❌ Test video not found: ${testVideo}`);
        console.log('📝 Please create a test video at this location or update the path in the script');
        return;
      }

      // Set video file path
      TEST_CONFIG.gstreamerBot.videoFile = testVideo;
      TEST_CONFIG.ffmpegBot.videoFile = testVideo;

      // Connect to server
      await this.connect();

      // Test 1: Create and test GStreamer ViewBot
      console.log('\n=== TEST 1: GStreamer ViewBot ===');
      const gstreamerResult = await this.createViewBot(TEST_CONFIG.gstreamerBot);
      this.gstreamerBotId = gstreamerResult.botId;

      // Wait for auto-start or manually start
      if (!TEST_CONFIG.gstreamerBot.autoStart) {
        await this.startViewBot(this.gstreamerBotId);
      }

      // Check status after a few seconds
      await new Promise(resolve => setTimeout(resolve, 5000));
      const gstreamerStatus = await this.getViewBotStatus(this.gstreamerBotId);
      console.log('📊 GStreamer ViewBot Status:', gstreamerStatus);

      // Test 2: Create and test FFmpeg ViewBot for comparison
      console.log('\n=== TEST 2: FFmpeg ViewBot (for comparison) ===');
      const ffmpegResult = await this.createViewBot(TEST_CONFIG.ffmpegBot);
      this.ffmpegBotId = ffmpegResult.botId;

      await this.startViewBot(this.ffmpegBotId);

      // Check status after a few seconds
      await new Promise(resolve => setTimeout(resolve, 5000));
      const ffmpegStatus = await this.getViewBotStatus(this.ffmpegBotId);
      console.log('📊 FFmpeg ViewBot Status:', ffmpegStatus);

      // Let both run for test duration
      console.log(`\n⏱️ Running both ViewBots for ${TEST_CONFIG.testDuration / 1000} seconds...`);
      console.log('📺 Check the stream output to compare quality and performance');
      
      await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.testDuration));

      // Stop both ViewBots
      console.log('\n=== Stopping ViewBots ===');
      await this.stopViewBot(this.gstreamerBotId);
      await this.stopViewBot(this.ffmpegBotId);

      console.log('\n✅ Test completed successfully!');
      console.log('\n📊 Summary:');
      console.log('- GStreamer ViewBot tested with video file streaming');
      console.log('- FFmpeg ViewBot tested for comparison');
      console.log('- Both methods should produce similar output');
      console.log('- GStreamer may offer better performance for certain video formats');

    } catch (error) {
      console.error('❌ Test failed:', error);
    } finally {
      if (this.socket) {
        this.socket.disconnect();
      }
      process.exit(0);
    }
  }
}

// Run the test
async function main() {
  const tester = new GStreamerViewBotTester();
  await tester.runTest();
}

main().catch(console.error);