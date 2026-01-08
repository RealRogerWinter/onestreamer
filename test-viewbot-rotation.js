/**
 * Comprehensive ViewBot Rotation Test and Fix Script
 * Tests and fixes the ViewBot rotation mechanism
 */

const axios = require('axios');
const io = require('socket.io-client');

const SERVER_URL = 'https://127.0.0.1:8443';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

// Allow self-signed certificates
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ViewBotRotationTester {
  constructor() {
    this.socket = null;
    this.streamReadyReceived = false;
    this.lastStreamEvent = null;
  }

  async connectSocket() {
    console.log('📡 Connecting Socket.IO client...');
    
    this.socket = io(SERVER_URL, {
      transports: ['websocket'],
      rejectUnauthorized: false
    });

    return new Promise((resolve) => {
      this.socket.on('connect', () => {
        console.log('✅ Socket connected');
        
        // Listen for stream events
        this.socket.on('stream-ready', (data) => {
          console.log('🎬 STREAM-READY event received:', data);
          this.streamReadyReceived = true;
          this.lastStreamEvent = data;
        });
        
        this.socket.on('stream-ending', (data) => {
          console.log('🛑 STREAM-ENDING event received:', data);
        });
        
        this.socket.on('new-streamer', (data) => {
          console.log('🆕 NEW-STREAMER event received:', data);
        });
        
        resolve();
      });
      
      this.socket.on('error', (error) => {
        console.error('❌ Socket error:', error);
      });
    });
  }

  async testSimpleRotation() {
    console.log('\n=== Testing Simple MediaSoup Rotation ===\n');
    
    try {
      // 1. Check current status
      console.log('1️⃣ Checking Simple Rotation Status...');
      const statusRes = await axios.get(`${SERVER_URL}/admin/simple-rotation/status`, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      
      const status = statusRes.data;
      console.log('   Status:', JSON.stringify(status, null, 2));
      
      if (!status.enabled) {
        console.log('\n2️⃣ Rotation is disabled. Enabling...');
        const toggleRes = await axios.post(`${SERVER_URL}/admin/simple-rotation/toggle`, {
          enabled: true
        }, {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
        console.log('   Toggle result:', toggleRes.data);
      }
      
      // 3. Force a rotation to test
      console.log('\n3️⃣ Forcing rotation to trigger stream...');
      this.streamReadyReceived = false;
      
      const forceRes = await axios.post(`${SERVER_URL}/admin/simple-rotation/force`, {}, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      console.log('   Force result:', forceRes.data);
      
      // 4. Wait for stream-ready event
      console.log('\n4️⃣ Waiting for stream-ready event (10 seconds)...');
      await sleep(10000);
      
      if (this.streamReadyReceived) {
        console.log('   ✅ SUCCESS: stream-ready event received!');
        console.log('   Event data:', this.lastStreamEvent);
      } else {
        console.log('   ❌ FAILURE: No stream-ready event received');
      }
      
      // 5. Check status again
      console.log('\n5️⃣ Re-checking status after rotation...');
      const finalStatus = await axios.get(`${SERVER_URL}/admin/simple-rotation/status`, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      console.log('   Final status:', JSON.stringify(finalStatus.data, null, 2));
      
      // 6. Check for GStreamer process
      if (!finalStatus.data.hasGStreamer) {
        console.log('\n   ⚠️ WARNING: GStreamer process not running!');
        console.log('   This is the core issue - GStreamer is not starting properly');
        await this.attemptFix();
      }
      
    } catch (error) {
      console.error('❌ Test failed:', error.response?.data || error.message);
    }
  }
  
  async attemptFix() {
    console.log('\n=== Attempting to Fix GStreamer Issue ===\n');
    
    // 1. Check if GStreamer is installed
    console.log('1️⃣ Checking GStreamer installation...');
    const { spawn } = require('child_process');
    
    const checkGst = spawn('which', ['gst-launch-1.0']);
    
    return new Promise((resolve) => {
      checkGst.on('close', async (code) => {
        if (code === 0) {
          console.log('   ✅ GStreamer is installed');
          
          // 2. Test a simple GStreamer pipeline
          console.log('\n2️⃣ Testing simple GStreamer pipeline...');
          await this.testGStreamerPipeline();
          
          // 3. Check for media files
          console.log('\n3️⃣ Checking for media files...');
          await this.checkMediaFiles();
          
          // 4. Try to fix the rotation
          console.log('\n4️⃣ Attempting to fix rotation with proper initialization...');
          await this.fixRotation();
          
        } else {
          console.log('   ❌ GStreamer not found! Installing...');
          await this.installGStreamer();
        }
        resolve();
      });
    });
  }
  
  async testGStreamerPipeline() {
    const { spawn } = require('child_process');
    
    console.log('   Testing videotestsrc pipeline...');
    
    const pipeline = [
      'videotestsrc', 'num-buffers=100',
      '!', 'video/x-raw,width=640,height=480',
      '!', 'fakesink'
    ];
    
    const gst = spawn('gst-launch-1.0', pipeline);
    
    return new Promise((resolve) => {
      let output = '';
      
      gst.stderr.on('data', (data) => {
        output += data.toString();
      });
      
      gst.on('close', (code) => {
        if (code === 0) {
          console.log('   ✅ GStreamer test successful');
        } else {
          console.log('   ❌ GStreamer test failed');
          console.log('   Output:', output);
        }
        resolve();
      });
    });
  }
  
  async checkMediaFiles() {
    const fs = require('fs');
    const path = require('path');
    
    const uploadsDir = path.join(__dirname, 'server', 'uploads');
    
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const mp4Files = files.filter(f => f.endsWith('.mp4'));
      console.log(`   Found ${mp4Files.length} MP4 files in uploads directory`);
      
      if (mp4Files.length > 0) {
        console.log('   Sample files:', mp4Files.slice(0, 5));
      }
    } else {
      console.log('   ❌ Uploads directory not found');
    }
  }
  
  async fixRotation() {
    try {
      // 1. Stop current rotation
      console.log('   Stopping current rotation...');
      await axios.post(`${SERVER_URL}/admin/simple-rotation/stop`, {}, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      
      await sleep(2000);
      
      // 2. Initialize with media files
      console.log('   Re-initializing with media files...');
      const initRes = await axios.post(`${SERVER_URL}/admin/simple-rotation/init`, {
        useMp4Files: true
      }, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      console.log('   Init result:', initRes.data);
      
      // 3. Start rotation
      console.log('   Starting rotation...');
      await axios.post(`${SERVER_URL}/admin/simple-rotation/start`, {}, {
        headers: { 'x-admin-key': ADMIN_KEY }
      });
      
      // 4. Wait for stream
      console.log('   Waiting for stream to start...');
      this.streamReadyReceived = false;
      await sleep(5000);
      
      if (this.streamReadyReceived) {
        console.log('   ✅ FIX SUCCESSFUL: Stream started!');
      } else {
        console.log('   ❌ Fix did not work, need manual intervention');
        console.log('\n   📋 Manual fix steps:');
        console.log('   1. Check server logs: pm2 logs onestreamer-server');
        console.log('   2. Restart server: pm2 restart onestreamer-server');
        console.log('   3. Check GStreamer packages: apt list --installed | grep gstreamer');
        console.log('   4. Test with: node test-simple-rotation.js');
      }
      
    } catch (error) {
      console.error('   Fix attempt failed:', error.response?.data || error.message);
    }
  }
  
  async installGStreamer() {
    console.log('   Installing GStreamer packages...');
    const { execSync } = require('child_process');
    
    try {
      execSync('apt-get update && apt-get install -y gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav', {
        stdio: 'inherit'
      });
      console.log('   ✅ GStreamer installed successfully');
    } catch (error) {
      console.error('   ❌ Failed to install GStreamer:', error.message);
    }
  }
  
  async cleanup() {
    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

async function main() {
  console.log('🎯 ViewBot Rotation Diagnostic and Fix Tool\n');
  
  const tester = new ViewBotRotationTester();
  
  try {
    await tester.connectSocket();
    await tester.testSimpleRotation();
  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await tester.cleanup();
    process.exit(0);
  }
}

main();