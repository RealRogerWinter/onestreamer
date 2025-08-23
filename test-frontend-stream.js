/**
 * Test script to verify stream is accessible from frontend perspective
 */

const io = require('socket.io-client');
const axios = require('axios');

const SERVER_URL = 'https://onestreamer.live';
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

async function testFrontendStream() {
  console.log('🎯 Testing Frontend Stream Access\n');
  
  // 1. Connect to Socket.IO
  console.log('1️⃣ Connecting to Socket.IO...');
  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    rejectUnauthorized: false
  });
  
  await new Promise((resolve) => {
    socket.on('connect', () => {
      console.log('   ✅ Connected to Socket.IO\n');
      resolve();
    });
  });
  
  // 2. Check if any stream is active
  console.log('2️⃣ Checking for active streams...');
  
  let activeStreamer = null;
  let streamReady = false;
  
  socket.on('stream-ready', (data) => {
    console.log('   🎬 Stream-ready event received:', data);
    activeStreamer = data.streamerId;
    streamReady = true;
  });
  
  socket.on('current-streamer', (data) => {
    console.log('   📺 Current streamer:', data);
    activeStreamer = data.streamerId;
  });
  
  socket.on('no-active-stream', () => {
    console.log('   ❌ No active stream');
  });
  
  // Request current stream status
  socket.emit('get-current-streamer');
  
  // 3. Check rotation status
  console.log('\n3️⃣ Checking rotation status...');
  try {
    const rotationStatus = await axios.get(`${SERVER_URL}/admin/simple-rotation/status`, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    console.log('   Rotation enabled:', rotationStatus.data.enabled);
    console.log('   Current bot:', rotationStatus.data.currentBot);
    console.log('   Has GStreamer:', rotationStatus.data.hasGStreamer);
    console.log('   Has producers:', rotationStatus.data.hasProducers);
    
    if (!rotationStatus.data.hasGStreamer || !rotationStatus.data.hasProducers) {
      console.log('\n   ⚠️ Stream is not properly running!');
      console.log('   Forcing rotation...');
      
      await axios.post(`${SERVER_URL}/admin/simple-rotation/force`, {}, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch (error) {
    console.error('   Error checking rotation:', error.message);
  }
  
  // 4. Wait for stream events
  console.log('\n4️⃣ Waiting for stream events (10 seconds)...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  // 5. Try to get MediaSoup router capabilities (what a viewer would do)
  console.log('\n5️⃣ Testing MediaSoup connection (as viewer would)...');
  
  socket.emit('getRouterRtpCapabilities', {}, (response) => {
    if (response && response.rtpCapabilities) {
      console.log('   ✅ MediaSoup router capabilities received');
      console.log('   Codecs available:', response.rtpCapabilities.codecs?.map(c => c.mimeType).join(', '));
    } else {
      console.log('   ❌ Failed to get router capabilities');
    }
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // 6. Check if we can create transport (viewer side)
  console.log('\n6️⃣ Testing transport creation...');
  
  socket.emit('createWebRtcTransport', { isProducer: false }, (response) => {
    if (response && response.id) {
      console.log('   ✅ Transport created successfully');
      console.log('   Transport ID:', response.id);
    } else {
      console.log('   ❌ Failed to create transport:', response);
    }
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Results
  console.log('\n' + '='.repeat(50));
  console.log('📊 RESULTS:');
  console.log('='.repeat(50));
  
  if (streamReady && activeStreamer) {
    console.log('✅ Stream is active and ready');
    console.log('   Streamer ID:', activeStreamer);
    console.log('\n🎉 Frontend should be able to view the stream!');
    console.log('   Visit https://onestreamer.live to see it');
  } else {
    console.log('❌ No active stream detected');
    console.log('\n⚠️ Possible issues:');
    console.log('   1. ViewBot rotation not running');
    console.log('   2. GStreamer process failed');
    console.log('   3. MediaSoup producers not created');
    console.log('\nTry: pm2 restart onestreamer-server');
  }
  
  socket.disconnect();
  process.exit(0);
}

testFrontendStream();