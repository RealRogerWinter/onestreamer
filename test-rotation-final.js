/**
 * Final test to verify rotation is working with stream-ready events
 */

const io = require('socket.io-client');
const axios = require('axios');

const SERVER_URL = 'https://127.0.0.1:8443';
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

async function testRotation() {
  console.log('🎯 Final ViewBot Rotation Test\n');
  
  // Connect socket
  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    rejectUnauthorized: false
  });
  
  let streamReadyReceived = false;
  let lastStreamReady = null;
  
  socket.on('connect', () => {
    console.log('✅ Socket connected\n');
  });
  
  socket.on('stream-ready', (data) => {
    console.log('🎬 STREAM-READY EVENT RECEIVED!');
    console.log('   Data:', JSON.stringify(data, null, 2));
    streamReadyReceived = true;
    lastStreamReady = data;
  });
  
  socket.on('stream-ending', (data) => {
    console.log('🛑 Stream-ending:', data.streamerId);
  });
  
  socket.on('stream-ended', (data) => {
    console.log('⏹️ Stream-ended:', data.streamerId);
  });
  
  // Wait for connection
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  try {
    // Check current status
    console.log('1️⃣ Checking rotation status...');
    const statusBefore = await axios.get(`${SERVER_URL}/admin/simple-rotation/status`, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    console.log('   Current bot:', statusBefore.data.currentBot);
    console.log('   Has GStreamer:', statusBefore.data.hasGStreamer);
    console.log('   Has Producers:', statusBefore.data.hasProducers);
    
    // Force rotation
    console.log('\n2️⃣ Forcing rotation...');
    streamReadyReceived = false;
    
    await axios.post(`${SERVER_URL}/admin/simple-rotation/force`, {}, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    // Wait for events
    console.log('\n3️⃣ Waiting 5 seconds for stream-ready event...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check status after
    const statusAfter = await axios.get(`${SERVER_URL}/admin/simple-rotation/status`, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    console.log('\n4️⃣ Status after rotation:');
    console.log('   Current bot:', statusAfter.data.currentBot);
    console.log('   Has GStreamer:', statusAfter.data.hasGStreamer);
    console.log('   Has Producers:', statusAfter.data.hasProducers);
    
    // Results
    console.log('\n' + '='.repeat(50));
    console.log('📊 TEST RESULTS:');
    console.log('='.repeat(50));
    
    if (streamReadyReceived) {
      console.log('✅ SUCCESS: stream-ready event was received!');
      console.log('   Bot ID:', lastStreamReady?.botId || lastStreamReady?.streamerId);
      console.log('   Video Producer:', lastStreamReady?.videoProducerId);
      console.log('   Audio Producer:', lastStreamReady?.audioProducerId);
    } else {
      console.log('❌ FAILURE: No stream-ready event received');
    }
    
    if (statusAfter.data.hasGStreamer) {
      console.log('✅ SUCCESS: GStreamer is running');
    } else {
      console.log('❌ FAILURE: GStreamer is not running');
    }
    
    if (statusAfter.data.hasProducers) {
      console.log('✅ SUCCESS: MediaSoup producers created');
    } else {
      console.log('❌ FAILURE: No MediaSoup producers');
    }
    
    if (statusBefore.data.currentBot !== statusAfter.data.currentBot) {
      console.log('✅ SUCCESS: Bot rotated from', statusBefore.data.currentBot, 'to', statusAfter.data.currentBot);
    } else {
      console.log('⚠️ WARNING: Bot did not change (may be same bot selected)');
    }
    
    console.log('\n' + '='.repeat(50));
    
    // Overall result
    if (streamReadyReceived && statusAfter.data.hasGStreamer && statusAfter.data.hasProducers) {
      console.log('🎉 ROTATION SYSTEM IS WORKING CORRECTLY! 🎉');
      console.log('ViewBot rotation has been successfully fixed!');
    } else {
      console.log('⚠️ Rotation system still has issues.');
      console.log('Check server logs: pm2 logs onestreamer-server');
    }
    
  } catch (error) {
    console.error('❌ Test error:', error.response?.data || error.message);
  }
  
  socket.disconnect();
  process.exit(0);
}

testRotation();