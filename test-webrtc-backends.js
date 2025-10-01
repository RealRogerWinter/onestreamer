#!/usr/bin/env node

/**
 * Test script for WebRTC dual-stack implementation
 * Tests both MediaSoup and LiveKit backends
 */

const axios = require('axios');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY || '***REMOVED-ADMIN-KEY***';

async function testBackend(backendName) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Testing ${backendName.toUpperCase()} Backend`);
  console.log('='.repeat(50));

  try {
    // 1. Get current backend info
    console.log('\n1. Getting backend info...');
    const backendResponse = await axios.get(`${SERVER_URL}/api/webrtc/backend`);
    console.log(`   Current backend: ${backendResponse.data.backend}`);
    console.log(`   Initialized: ${backendResponse.data.initialized}`);
    console.log(`   Stats:`, backendResponse.data.stats);

    // 2. Get capabilities
    console.log('\n2. Getting RTP capabilities...');
    const capResponse = await axios.get(`${SERVER_URL}/api/webrtc/capabilities`);
    console.log(`   Backend: ${capResponse.data.backend}`);
    console.log(`   Codecs available: ${capResponse.data.rtpCapabilities.codecs.length}`);
    capResponse.data.rtpCapabilities.codecs.forEach(codec => {
      console.log(`     - ${codec.kind}: ${codec.mimeType}`);
    });

    // 3. Test MediaSoup-specific stats endpoint
    if (backendName === 'mediasoup') {
      console.log('\n3. Getting MediaSoup stats...');
      const statsResponse = await axios.get(`${SERVER_URL}/api/mediasoup/stats`);
      console.log(`   Transport count: ${statsResponse.data.transportCount}`);
      console.log(`   Producer count: ${statsResponse.data.producerCount}`);
      console.log(`   Consumer count: ${statsResponse.data.consumerCount}`);
    }

    console.log(`\n✅ ${backendName.toUpperCase()} backend test PASSED`);
    return true;

  } catch (error) {
    console.error(`\n❌ ${backendName.toUpperCase()} backend test FAILED:`, error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
    return false;
  }
}

async function switchBackend(targetBackend) {
  console.log(`\n🔄 Attempting to switch to ${targetBackend}...`);
  
  try {
    const response = await axios.post(
      `${SERVER_URL}/api/admin/webrtc/backend`,
      { backend: targetBackend },
      {
        headers: {
          'x-admin-key': ADMIN_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`   ${response.data.message}`);
    console.log(`   Current backend: ${response.data.currentBackend}`);
    console.log(`   New backend: ${response.data.newBackend}`);
    
    if (response.data.requiresRestart) {
      console.log('   ⚠️  Server restart required for changes to take effect');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Failed to switch backend:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
    return false;
  }
}

async function main() {
  console.log('OneStreamer WebRTC Backend Test Suite');
  console.log('=====================================\n');
  
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'switch') {
    const targetBackend = args[1];
    if (!targetBackend || !['mediasoup', 'livekit'].includes(targetBackend)) {
      console.error('Usage: node test-webrtc-backends.js switch [mediasoup|livekit]');
      process.exit(1);
    }
    await switchBackend(targetBackend);
  } else if (command === 'test') {
    const backend = args[1] || 'current';
    if (backend === 'current') {
      // Test current backend
      const response = await axios.get(`${SERVER_URL}/api/webrtc/backend`);
      await testBackend(response.data.backend);
    } else if (['mediasoup', 'livekit'].includes(backend)) {
      await testBackend(backend);
    } else {
      console.error('Usage: node test-webrtc-backends.js test [mediasoup|livekit|current]');
      process.exit(1);
    }
  } else if (command === 'test-all') {
    // Test current backend first
    const response = await axios.get(`${SERVER_URL}/api/webrtc/backend`);
    const currentBackend = response.data.backend;
    
    console.log(`Current backend: ${currentBackend}`);
    const currentPassed = await testBackend(currentBackend);
    
    // Note about testing the other backend
    const otherBackend = currentBackend === 'mediasoup' ? 'livekit' : 'mediasoup';
    console.log(`\n📝 To test ${otherBackend}, run:`);
    console.log(`   1. node test-webrtc-backends.js switch ${otherBackend}`);
    console.log(`   2. Restart the server`);
    console.log(`   3. node test-webrtc-backends.js test ${otherBackend}`);
    
    process.exit(currentPassed ? 0 : 1);
  } else {
    console.log('Usage:');
    console.log('  node test-webrtc-backends.js test [mediasoup|livekit|current]  - Test a specific backend');
    console.log('  node test-webrtc-backends.js test-all                          - Test current backend');
    console.log('  node test-webrtc-backends.js switch [mediasoup|livekit]        - Switch backend (requires restart)');
    console.log('');
    console.log('Environment variables:');
    console.log('  SERVER_URL  - Server URL (default: http://localhost:3000)');
    console.log('  ADMIN_KEY   - Admin key for switching backends (default: ***REMOVED-ADMIN-KEY***)');
  }
}

// Run the tests
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});