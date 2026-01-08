#!/usr/bin/env node
/**
 * Test script to verify that viewbots don't trigger global cooldown
 * but real users do trigger it
 */

const io = require('socket.io-client');
const axios = require('axios');

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
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

// Axios instance with SSL bypass for local testing
const api = axios.create({
  baseURL: API_URL,
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
});

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

async function waitForCooldowns() {
  log('⏳ Waiting 65 seconds for all cooldowns to expire...', 'yellow');
  for (let i = 65; i > 0; i--) {
    process.stdout.write(`\r⏳ ${i} seconds remaining...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('\r✅ Cooldowns should be expired now!                    ');
}

async function testViewbotNoGlobalCooldown() {
  log('🧪 Starting viewbot global cooldown test...', 'cyan');
  
  // First wait for any existing cooldowns to expire
  await waitForCooldowns();
  
  // Test 1: Viewbot goes live, then another socket tries to take over
  log('\n📝 Test 1: Viewbot → New User (should NOT have global cooldown)', 'cyan');
  
  // Create viewbot socket
  const viewbot1 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    viewbot1.on('connect', () => {
      log(`🤖 Viewbot 1 connected: ${viewbot1.id}`, 'blue');
      resolve();
    });
  });
  
  // Viewbot goes live
  let viewbot1Approved = false;
  viewbot1.on('streaming-approved', () => {
    log('✅ Viewbot 1 streaming approved!', 'green');
    viewbot1Approved = true;
  });
  
  viewbot1.on('takeover-denied', (data) => {
    log(`❌ Viewbot 1 denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
  });
  
  viewbot1.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot',
    botId: 'test-bot-1'
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  if (!viewbot1Approved) {
    log('⚠️ Viewbot 1 could not go live, waiting for cooldown...', 'yellow');
    await waitForCooldowns();
    
    // Try again
    viewbot1.emit('request-to-stream', {
      isViewBot: true,
      streamType: 'viewbot',
      botId: 'test-bot-1'
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Now create a new user socket and try to take over
  const user1 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    user1.on('connect', () => {
      log(`👤 User 1 connected: ${user1.id}`, 'green');
      resolve();
    });
  });
  
  let user1Approved = false;
  let user1DeniedReason = null;
  
  user1.on('streaming-approved', () => {
    log('✅ User 1 streaming approved!', 'green');
    user1Approved = true;
  });
  
  user1.on('takeover-denied', (data) => {
    log(`❌ User 1 denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
    user1DeniedReason = data.reason;
  });
  
  // User tries to take over immediately
  user1.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Check result
  if (user1Approved) {
    log('✅ PASS: User could take over immediately (no global cooldown from viewbot)', 'green');
  } else if (user1DeniedReason === 'global_cooldown') {
    log('❌ FAIL: User blocked by global cooldown from viewbot', 'red');
  } else {
    log(`⚠️ User denied for other reason: ${user1DeniedReason}`, 'yellow');
  }
  
  // Clean up
  viewbot1.disconnect();
  user1.disconnect();
  
  // Wait a bit before next test
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Test 2: Real user goes live, then another socket tries to take over
  log('\n📝 Test 2: Real User → New User (SHOULD have global cooldown)', 'cyan');
  
  const user2 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    user2.on('connect', () => {
      log(`👤 User 2 connected: ${user2.id}`, 'green');
      resolve();
    });
  });
  
  let user2Approved = false;
  user2.on('streaming-approved', () => {
    log('✅ User 2 streaming approved!', 'green');
    user2Approved = true;
  });
  
  user2.on('takeover-denied', (data) => {
    log(`❌ User 2 denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
  });
  
  // Real user goes live
  user2.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  if (!user2Approved) {
    log('⚠️ User 2 could not go live, may have cooldown from previous test', 'yellow');
  }
  
  // Now another user tries to take over immediately
  const user3 = io(API_URL, socketOptions);
  await new Promise((resolve) => {
    user3.on('connect', () => {
      log(`👤 User 3 connected: ${user3.id}`, 'green');
      resolve();
    });
  });
  
  let user3Approved = false;
  let user3DeniedReason = null;
  let user3CooldownRemaining = 0;
  
  user3.on('streaming-approved', () => {
    log('✅ User 3 streaming approved!', 'green');
    user3Approved = true;
  });
  
  user3.on('takeover-denied', (data) => {
    log(`❌ User 3 denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
    user3DeniedReason = data.reason;
    user3CooldownRemaining = data.cooldownRemaining;
  });
  
  // Try to take over immediately
  user3.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Check result
  if (!user3Approved && user3DeniedReason === 'global_cooldown') {
    log('✅ PASS: User 3 blocked by global cooldown from real user', 'green');
    log(`   Global cooldown remaining: ${user3CooldownRemaining}s`, 'cyan');
  } else if (user3Approved) {
    log('❌ FAIL: User 3 could take over (no global cooldown from real user)', 'red');
  } else {
    log(`⚠️ User 3 denied for other reason: ${user3DeniedReason}`, 'yellow');
  }
  
  // Clean up
  user2.disconnect();
  user3.disconnect();
  
  // Summary
  log('\n' + '='.repeat(60), 'cyan');
  log('📊 TEST SUMMARY', 'cyan');
  log('='.repeat(60), 'cyan');
  
  if (user1Approved && user3DeniedReason === 'global_cooldown') {
    log('✅ ALL TESTS PASSED!', 'green');
    log('   - Viewbots do NOT trigger global cooldown', 'green');
    log('   - Real users DO trigger global cooldown', 'green');
  } else {
    log('❌ SOME TESTS FAILED', 'red');
    if (!user1Approved) {
      log('   - Viewbot may have triggered global cooldown', 'red');
    }
    if (user3DeniedReason !== 'global_cooldown') {
      log('   - Real user may not have triggered global cooldown', 'red');
    }
  }
  
  process.exit(0);
}

// Run the test
testViewbotNoGlobalCooldown().catch(error => {
  log(`❌ Test error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});