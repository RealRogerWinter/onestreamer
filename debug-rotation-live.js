/**
 * Live debugging of rotation system
 */

const io = require('socket.io-client');
const axios = require('axios');

const SERVER_URL = 'https://onestreamer.live';
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

async function debugRotation() {
  console.log('🔍 Live Rotation Debugging\n');
  
  // Connect and listen for ALL events
  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    rejectUnauthorized: false
  });
  
  const events = [];
  
  socket.onAny((eventName, ...args) => {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}] Event: ${eventName}`, args[0]?.streamerId || args[0]?.botId || '');
    events.push({ time: timestamp, event: eventName, data: args[0] });
  });
  
  socket.on('connect', async () => {
    console.log('✅ Connected to Socket.IO\n');
    console.log('📡 Listening for all events...\n');
    
    // Wait a bit then force rotation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('\n🔄 Forcing rotation...\n');
    try {
      await axios.post(`${SERVER_URL}/admin/simple-rotation/force`, {}, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
    } catch (error) {
      console.error('Force rotation error:', error.message);
    }
    
    // Listen for 15 seconds
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 EVENT SUMMARY:');
    console.log('='.repeat(50));
    
    const streamReadyEvents = events.filter(e => e.event === 'stream-ready');
    const streamEndingEvents = events.filter(e => e.event === 'stream-ending');
    const streamEndedEvents = events.filter(e => e.event === 'stream-ended');
    const viewbotEvents = events.filter(e => e.event.includes('viewbot'));
    
    console.log(`Stream-ready events: ${streamReadyEvents.length}`);
    console.log(`Stream-ending events: ${streamEndingEvents.length}`);
    console.log(`Stream-ended events: ${streamEndedEvents.length}`);
    console.log(`ViewBot events: ${viewbotEvents.length}`);
    console.log(`Total events: ${events.length}`);
    
    if (streamReadyEvents.length > 0) {
      console.log('\n✅ stream-ready events detected:');
      streamReadyEvents.forEach(e => {
        console.log(`  - ${e.time}: ${e.data.streamerId || e.data.botId}`);
      });
    } else {
      console.log('\n❌ No stream-ready events detected!');
    }
    
    // Check current status
    console.log('\n📊 Final rotation status:');
    try {
      const status = await axios.get(`${SERVER_URL}/admin/simple-rotation/status`, {
        headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
      });
      console.log(`  Current bot: ${status.data.currentBot}`);
      console.log(`  Has GStreamer: ${status.data.hasGStreamer}`);
      console.log(`  Has Producers: ${status.data.hasProducers}`);
    } catch (error) {
      console.error('  Error getting status:', error.message);
    }
    
    socket.disconnect();
    process.exit(0);
  });
  
  socket.on('connect_error', (error) => {
    console.error('Connection error:', error.message);
    process.exit(1);
  });
}

debugRotation();