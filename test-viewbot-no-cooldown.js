#!/usr/bin/env node
/**
 * Test script to verify that viewbots don't trigger global cooldown when going live
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

async function testViewbotNoCooldown() {
  log('🧪 Starting viewbot global cooldown test...', 'cyan');
  
  // Create a regular user socket first
  const userSocket = io(API_URL, socketOptions);
  
  await new Promise((resolve) => {
    userSocket.on('connect', () => {
      log(`✅ User socket connected: ${userSocket.id}`, 'green');
      resolve();
    });
  });
  
  // Wait a bit to ensure connection is stable
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Check initial cooldown status
  let cooldownActive = false;
  userSocket.on('global-cooldown', (data) => {
    log(`⏱️ User received global cooldown: ${data.cooldownRemaining}s remaining`, 'yellow');
    cooldownActive = true;
  });
  
  // Create a viewbot socket
  const viewbotSocket = io(API_URL, socketOptions);
  
  await new Promise((resolve) => {
    viewbotSocket.on('connect', () => {
      log(`🤖 Viewbot socket connected: ${viewbotSocket.id}`, 'blue');
      resolve();
    });
  });
  
  // Wait for connection to stabilize
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Viewbot requests to stream
  log('🤖 Viewbot requesting to stream...', 'magenta');
  
  let viewbotApproved = false;
  viewbotSocket.on('streaming-approved', () => {
    log('✅ Viewbot streaming approved!', 'green');
    viewbotApproved = true;
  });
  
  viewbotSocket.on('takeover-denied', (data) => {
    log(`❌ Viewbot takeover denied: ${data.reason}`, 'red');
  });
  
  // Request to stream as viewbot
  viewbotSocket.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot'
  });
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Now check if user can take over immediately (should be able to if no global cooldown)
  log('👤 User attempting to take over from viewbot...', 'cyan');
  
  let userApproved = false;
  let userDeniedReason = null;
  
  userSocket.on('streaming-approved', () => {
    log('✅ User streaming approved!', 'green');
    userApproved = true;
  });
  
  userSocket.on('takeover-denied', (data) => {
    log(`❌ User takeover denied: ${data.reason} (${data.cooldownRemaining}s)`, 'red');
    userDeniedReason = data.reason;
  });
  
  // User requests to stream
  userSocket.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Analyze results
  log('\n📊 Test Results:', 'cyan');
  log('================', 'cyan');
  
  if (viewbotApproved) {
    log('✅ Viewbot was able to go live', 'green');
  } else {
    log('❌ Viewbot was NOT able to go live', 'red');
  }
  
  if (userApproved) {
    log('✅ User was able to take over immediately (NO global cooldown from viewbot)', 'green');
    log('🎉 TEST PASSED: Viewbots do not trigger global cooldown!', 'green');
  } else if (userDeniedReason === 'global_cooldown') {
    log('❌ User was blocked by global cooldown', 'red');
    log('❌ TEST FAILED: Viewbot triggered global cooldown', 'red');
  } else {
    log(`⚠️ User was denied for other reason: ${userDeniedReason}`, 'yellow');
  }
  
  // Test reverse scenario: User goes live first, then viewbot tries
  log('\n🔄 Testing reverse scenario: User → Viewbot', 'cyan');
  
  // First, have the user end their stream
  userSocket.emit('end-stream');
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // User goes live
  userSocket.emit('request-to-stream', {
    isViewBot: false,
    streamType: 'user'
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Now viewbot tries to take over (should be denied due to real user priority)
  log('🤖 Viewbot attempting to take over from real user...', 'magenta');
  
  let viewbotDeniedFromUser = false;
  viewbotSocket.once('takeover-denied', (data) => {
    log(`✅ Viewbot correctly denied: ${data.reason}`, 'green');
    viewbotDeniedFromUser = true;
  });
  
  viewbotSocket.emit('request-to-stream', {
    isViewBot: true,
    streamType: 'viewbot'
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  if (viewbotDeniedFromUser) {
    log('✅ TEST PASSED: Viewbot cannot take over from real user', 'green');
  } else {
    log('❌ TEST FAILED: Viewbot was able to take over from real user', 'red');
  }
  
  // Clean up
  userSocket.disconnect();
  viewbotSocket.disconnect();
  
  log('\n✅ Test completed!', 'green');
  process.exit(0);
}

// Run the test
testViewbotNoCooldown().catch(error => {
  log(`❌ Test error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});