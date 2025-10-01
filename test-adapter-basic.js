#!/usr/bin/env node

/**
 * Basic test for WebRTC adapter functionality
 * Tests adapter initialization and backend selection
 */

const WebRTCAdapter = require('./server/services/WebRTCAdapter');

async function testAdapter() {
  console.log('Testing WebRTC Adapter...\n');
  
  try {
    // Test 1: Create adapter
    console.log('1. Creating WebRTC adapter...');
    const adapter = new WebRTCAdapter();
    console.log(`   ✅ Adapter created with backend: ${adapter.getBackendType()}`);
    
    // Test 2: Check backend before initialization
    console.log('\n2. Checking backend before initialization...');
    console.log(`   Backend type: ${adapter.getBackendType()}`);
    console.log(`   Is MediaSoup: ${adapter.isMediaSoup()}`);
    console.log(`   Is LiveKit: ${adapter.isLiveKit()}`);
    console.log(`   Initialized: ${adapter.initialized}`);
    
    // Test 3: Initialize adapter
    console.log('\n3. Initializing adapter...');
    await adapter.initialize();
    console.log(`   ✅ Adapter initialized`);
    
    // Test 4: Check backend after initialization
    console.log('\n4. Checking backend after initialization...');
    const stats = adapter.getStats();
    console.log(`   Backend: ${stats.adapterBackend}`);
    console.log(`   Stats:`, stats);
    
    // Test 5: Get router capabilities
    console.log('\n5. Getting router RTP capabilities...');
    const capabilities = await adapter.getRouterRtpCapabilities();
    console.log(`   ✅ Got capabilities with ${capabilities.codecs.length} codecs`);
    capabilities.codecs.forEach(codec => {
      console.log(`     - ${codec.kind}: ${codec.mimeType}`);
    });
    
    console.log('\n✅ All tests passed!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
testAdapter().then(() => {
  console.log('\nTest completed successfully');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});