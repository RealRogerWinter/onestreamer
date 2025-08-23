#!/usr/bin/env node
/**
 * Simple test to verify viewbots don't trigger global cooldown
 */

const io = require('socket.io-client');

const API_URL = 'https://127.0.0.1:8443';
const socketOptions = {
  rejectUnauthorized: false,
  transports: ['websocket', 'polling']
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test() {
  console.log('🧪 Test: Viewbot should NOT trigger global cooldown\n');
  
  // Create viewbot
  const viewbot = io(API_URL, socketOptions);
  
  await new Promise((resolve) => {
    viewbot.on('connect', () => {
      console.log(`✅ Viewbot connected: ${viewbot.id}`);
      resolve();
    });
  });
  
  // Listen for events
  viewbot.on('streaming-approved', () => {
    console.log('✅ Viewbot got streaming-approved');
  });
  
  viewbot.on('takeover-denied', (data) => {
    console.log(`❌ Viewbot denied: ${data.reason}`);
  });
  
  // Request to stream as viewbot
  console.log('📡 Viewbot requesting to stream...');
  viewbot.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot'
  }, (ack) => {
    console.log('📡 Request acknowledged:', ack);
  });
  
  await sleep(3000);
  
  console.log('\n✅ Check server logs for:');
  console.log('   - "🤖 TAKEOVER: Skipping takeover recording for viewbot"');
  console.log('   - NO "🔒 TAKEOVER: Recording takeover for real user"');
  
  viewbot.disconnect();
  process.exit(0);
}

test().catch(console.error);
