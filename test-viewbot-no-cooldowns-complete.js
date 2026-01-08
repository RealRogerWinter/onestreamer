#!/usr/bin/env node
/**
 * Comprehensive test to verify viewbots don't create ANY cooldowns for users
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
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

async function testViewbotNoCooldowns() {
  log('🧪 COMPREHENSIVE TEST: Viewbots should not create ANY cooldowns', 'cyan');
  log('=' .repeat(60), 'cyan');
  
  // Test 1: Viewbot starts and stops, then real user should have no cooldown
  log('\n📝 Test 1: Viewbot stream → disconnect → Real user (NO cooldown)', 'magenta');
  
  // Create and start viewbot
  const viewbot1 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    viewbot1.on('connect', () => {
      log(`🤖 Viewbot 1 connected: ${viewbot1.id}`, 'blue');
      resolve();
    });
  });
  
  let viewbot1Approved = false;
  viewbot1.on('streaming-approved', () => {
    viewbot1Approved = true;
  });
  
  viewbot1.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot',
    botId: 'test-bot-1'
  });
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  log(`🤖 Viewbot 1 streaming: ${viewbot1Approved ? '✅ approved' : '❌ denied'}`, viewbot1Approved ? 'green' : 'red');
  
  // Disconnect viewbot
  viewbot1.disconnect();
  log('🔌 Viewbot 1 disconnected', 'yellow');
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Now real user tries to stream
  const user1 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    user1.on('connect', () => {
      log(`👤 User 1 connected: ${user1.id}`, 'green');
      resolve();
    });
  });
  
  let user1Result = null;
  let user1Reason = null;
  user1.on('streaming-approved', () => {
    user1Result = 'approved';
  });
  
  user1.on('takeover-denied', (data) => {
    user1Result = 'denied';
    user1Reason = data.reason;
  });
  
  user1.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  if (user1Result === 'approved') {
    log('✅ PASS: User 1 could stream after viewbot disconnect (no cooldown)', 'green');
  } else {
    log(`❌ FAIL: User 1 blocked after viewbot disconnect (${user1Reason})`, 'red');
  }
  
  user1.disconnect();
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 2: Real user takes over from viewbot (should work, no cooldown)
  log('\n📝 Test 2: Viewbot streaming → Real user takeover (NO cooldown)', 'magenta');
  
  // Start viewbot 2
  const viewbot2 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    viewbot2.on('connect', () => {
      log(`🤖 Viewbot 2 connected: ${viewbot2.id}`, 'blue');
      resolve();
    });
  });
  
  let viewbot2Approved = false;
  viewbot2.on('streaming-approved', () => {
    viewbot2Approved = true;
  });
  
  viewbot2.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot',
    botId: 'test-bot-2'
  });
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  log(`🤖 Viewbot 2 streaming: ${viewbot2Approved ? '✅ approved' : '❌ denied'}`, viewbot2Approved ? 'green' : 'red');
  
  // Real user takes over from viewbot
  const user2 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    user2.on('connect', () => {
      log(`👤 User 2 connected: ${user2.id}`, 'green');
      resolve();
    });
  });
  
  let user2Result = null;
  let user2Reason = null;
  user2.on('streaming-approved', () => {
    user2Result = 'approved';
  });
  
  user2.on('takeover-denied', (data) => {
    user2Result = 'denied';
    user2Reason = data.reason;
  });
  
  user2.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  if (user2Result === 'approved') {
    log('✅ PASS: User 2 could take over from viewbot (no cooldown)', 'green');
  } else {
    log(`❌ FAIL: User 2 blocked from taking over viewbot (${user2Reason})`, 'red');
  }
  
  // Clean up
  viewbot2.disconnect();
  user2.disconnect();
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 3: Viewbot takes over from viewbot (should work)
  log('\n📝 Test 3: Viewbot → Viewbot takeover (NO cooldown)', 'magenta');
  
  const viewbot3 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    viewbot3.on('connect', () => {
      log(`🤖 Viewbot 3 connected: ${viewbot3.id}`, 'blue');
      resolve();
    });
  });
  
  viewbot3.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot',
    botId: 'test-bot-3'
  });
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const viewbot4 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    viewbot4.on('connect', () => {
      log(`🤖 Viewbot 4 connected: ${viewbot4.id}`, 'blue');
      resolve();
    });
  });
  
  let viewbot4Result = null;
  viewbot4.on('streaming-approved', () => {
    viewbot4Result = 'approved';
  });
  
  viewbot4.on('takeover-denied', (data) => {
    viewbot4Result = 'denied';
  });
  
  viewbot4.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot',
    botId: 'test-bot-4'
  });
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  if (viewbot4Result === 'approved') {
    log('✅ PASS: Viewbot 4 could take over from Viewbot 3 (no cooldown)', 'green');
  } else {
    log('❌ FAIL: Viewbot 4 blocked from taking over Viewbot 3', 'red');
  }
  
  // Clean up
  viewbot3.disconnect();
  viewbot4.disconnect();
  
  // Summary
  log('\n' + '=' .repeat(60), 'cyan');
  log('📊 TEST SUMMARY', 'cyan');
  log('=' .repeat(60), 'cyan');
  
  const test1Pass = user1Result === 'approved';
  const test2Pass = user2Result === 'approved';
  const test3Pass = viewbot4Result === 'approved';
  
  log(`Test 1 (Viewbot disconnect → User): ${test1Pass ? '✅ PASS' : '❌ FAIL'}`, test1Pass ? 'green' : 'red');
  log(`Test 2 (Viewbot streaming → User takeover): ${test2Pass ? '✅ PASS' : '❌ FAIL'}`, test2Pass ? 'green' : 'red');
  log(`Test 3 (Viewbot → Viewbot takeover): ${test3Pass ? '✅ PASS' : '❌ FAIL'}`, test3Pass ? 'green' : 'red');
  
  if (test1Pass && test2Pass && test3Pass) {
    log('\n🎉 ALL TESTS PASSED! Viewbots do not create any cooldowns.', 'green');
  } else {
    log('\n⚠️ SOME TESTS FAILED. Viewbots may still be creating cooldowns.', 'red');
  }
  
  process.exit(0);
}

// Run the test
testViewbotNoCooldowns().catch(error => {
  log(`❌ Test error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});