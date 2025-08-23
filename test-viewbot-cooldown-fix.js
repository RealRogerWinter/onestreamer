#!/usr/bin/env node
/**
 * Simple test to verify viewbots bypass cooldowns completely
 */

const io = require('socket.io-client');

const API_URL = process.env.API_URL || 'https://127.0.0.1:8443';
const socketOptions = {
  rejectUnauthorized: false,
  transports: ['websocket', 'polling']
};

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

async function testViewbotCooldownBypass() {
  log('🧪 Testing viewbot cooldown bypass fix...', 'cyan');
  
  // Create first viewbot
  const viewbot1 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    viewbot1.on('connect', () => {
      log(`🤖 Viewbot 1 connected: ${viewbot1.id}`, 'blue');
      resolve();
    });
  });
  
  // Set up listeners for viewbot1
  let viewbot1Result = null;
  viewbot1.on('streaming-approved', () => {
    log('✅ Viewbot 1 streaming approved!', 'green');
    viewbot1Result = 'approved';
  });
  
  viewbot1.on('takeover-denied', (data) => {
    log(`❌ Viewbot 1 denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
    viewbot1Result = 'denied';
  });
  
  // Viewbot 1 requests to stream
  log('📡 Viewbot 1 requesting to stream...', 'cyan');
  viewbot1.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot',
    botId: 'test-bot-1'
  });
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Create second viewbot immediately
  const viewbot2 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    viewbot2.on('connect', () => {
      log(`🤖 Viewbot 2 connected: ${viewbot2.id}`, 'blue');
      resolve();
    });
  });
  
  // Set up listeners for viewbot2
  let viewbot2Result = null;
  viewbot2.on('streaming-approved', () => {
    log('✅ Viewbot 2 streaming approved!', 'green');
    viewbot2Result = 'approved';
  });
  
  viewbot2.on('takeover-denied', (data) => {
    log(`❌ Viewbot 2 denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
    viewbot2Result = 'denied';
  });
  
  // Viewbot 2 requests to stream immediately (should bypass cooldown)
  log('📡 Viewbot 2 requesting to stream immediately...', 'cyan');
  viewbot2.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot',
    botId: 'test-bot-2'
  });
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Now test with a real user
  const realUser = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    realUser.on('connect', () => {
      log(`👤 Real user connected: ${realUser.id}`, 'green');
      resolve();
    });
  });
  
  // Set up listeners for real user
  let realUserResult = null;
  let realUserDeniedReason = null;
  realUser.on('streaming-approved', () => {
    log('✅ Real user streaming approved!', 'green');
    realUserResult = 'approved';
  });
  
  realUser.on('takeover-denied', (data) => {
    log(`❌ Real user denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
    realUserResult = 'denied';
    realUserDeniedReason = data.reason;
  });
  
  // Real user requests to stream (should be subject to cooldown)
  log('📡 Real user requesting to stream...', 'cyan');
  realUser.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Clean up
  viewbot1.disconnect();
  viewbot2.disconnect();
  realUser.disconnect();
  
  // Results
  log('\n' + '='.repeat(60), 'cyan');
  log('📊 TEST RESULTS', 'cyan');
  log('='.repeat(60), 'cyan');
  
  log(`Viewbot 1: ${viewbot1Result || 'no response'}`, viewbot1Result === 'approved' ? 'green' : 'red');
  log(`Viewbot 2: ${viewbot2Result || 'no response'}`, viewbot2Result === 'approved' ? 'green' : 'red');
  log(`Real User: ${realUserResult || 'no response'} ${realUserDeniedReason ? `(${realUserDeniedReason})` : ''}`, 
      realUserResult === 'denied' ? 'yellow' : 'red');
  
  if (viewbot2Result === 'approved') {
    log('\n✅ SUCCESS: Viewbots bypass cooldowns correctly!', 'green');
    log('   - Viewbot 2 could take over immediately from Viewbot 1', 'green');
    log('   - No global cooldown was triggered between viewbots', 'green');
  } else {
    log('\n❌ FAILURE: Viewbots are still being blocked by cooldowns', 'red');
    log('   - Fix may not be working correctly', 'red');
  }
  
  process.exit(0);
}

// Run the test
testViewbotCooldownBypass().catch(error => {
  log(`❌ Test error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});