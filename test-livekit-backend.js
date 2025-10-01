#!/usr/bin/env node

/**
 * Test LiveKit backend integration
 * This script tests the server-side LiveKit integration
 */

const fetch = require('node-fetch');

async function testLiveKitBackend() {
  console.log('🚀 Testing LiveKit Backend Integration\n');
  console.log('='.repeat(50));
  
  // Step 1: Check backend status
  console.log('\n1️⃣ Backend Status Check');
  console.log('-'.repeat(30));
  const backendResponse = await fetch('http://127.0.0.1:8080/api/webrtc/backend');
  const backendData = await backendResponse.json();
  console.log('Backend:', backendData.backend);
  console.log('Adapter Enabled:', backendData.adapterEnabled);
  console.log('Initialized:', backendData.stats?.initialized);
  console.log('Transport Count:', backendData.stats?.transportCount || 0);
  console.log('Producer Count:', backendData.stats?.producerCount || 0);
  console.log('Consumer Count:', backendData.stats?.consumerCount || 0);
  
  if (backendData.backend !== 'livekit') {
    console.error('\n❌ ERROR: LiveKit backend not active!');
    console.error('Current backend:', backendData.backend);
    console.error('Run: ./enable-dual-stack.sh enable livekit');
    process.exit(1);
  }
  
  // Step 2: Test token generation
  console.log('\n2️⃣ Token Generation Test');
  console.log('-'.repeat(30));
  
  const identities = ['streamer-1', 'viewer-1', 'viewer-2'];
  const tokens = {};
  
  for (const identity of identities) {
    const tokenResponse = await fetch(
      `http://127.0.0.1:8080/api/livekit/token?identity=${identity}&room=onestreamer-main`
    );
    const tokenData = await tokenResponse.json();
    tokens[identity] = tokenData;
    console.log(`✅ Token for ${identity}:`, tokenData.token.substring(0, 50) + '...');
  }
  
  // Step 3: Test MediaSoup-compatible endpoints
  console.log('\n3️⃣ MediaSoup-Compatible API Test');
  console.log('-'.repeat(30));
  
  // Test router capabilities
  const capsResponse = await fetch('http://127.0.0.1:8080/api/mediasoup/router-capabilities');
  const caps = await capsResponse.json();
  console.log('Router RTP Capabilities:', caps.codecs ? `${caps.codecs.length} codecs` : 'Not available');
  
  // Test transport creation
  const transportResponse = await fetch('http://127.0.0.1:8080/api/mediasoup/create-transport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      socketId: 'test-socket-' + Date.now(),
      isMobile: false
    })
  });
  
  const transport = await transportResponse.json();
  console.log('Transport Created:', transport.id ? `✅ ${transport.id}` : '❌ Failed');
  
  if (transport.livekitData) {
    console.log('LiveKit-specific data present:', '✅');
    console.log('  - URL:', transport.livekitData.url);
    console.log('  - Room:', transport.livekitData.roomName);
    console.log('  - Token length:', transport.livekitData.token?.length || 0);
  }
  
  // Step 4: Check LiveKit server logs
  console.log('\n4️⃣ LiveKit Server Activity');
  console.log('-'.repeat(30));
  
  try {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    const { stdout } = await execPromise('tail -5 /tmp/livekit.log 2>/dev/null || echo "No logs available"');
    console.log('Recent LiveKit logs:');
    stdout.split('\n').filter(line => line).forEach(line => {
      console.log('  ', line.substring(0, 100));
    });
  } catch (error) {
    console.log('Could not read LiveKit logs');
  }
  
  // Step 5: Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 SUMMARY');
  console.log('='.repeat(50));
  
  const allChecks = [
    { name: 'LiveKit Backend Active', passed: backendData.backend === 'livekit' },
    { name: 'Adapter Enabled', passed: backendData.adapterEnabled },
    { name: 'Service Initialized', passed: backendData.stats?.initialized },
    { name: 'Token Generation', passed: Object.keys(tokens).length === 3 },
    { name: 'MediaSoup API Compatibility', passed: !!transport.id },
    { name: 'LiveKit Integration', passed: !!transport.livekitData },
  ];
  
  allChecks.forEach(check => {
    console.log(`${check.passed ? '✅' : '❌'} ${check.name}`);
  });
  
  const allPassed = allChecks.every(c => c.passed);
  
  if (allPassed) {
    console.log('\n🎉 SUCCESS: LiveKit backend is fully operational!');
    console.log('📝 Next steps:');
    console.log('   1. Open test-livekit-streaming.html in a browser');
    console.log('   2. Click "Get LiveKit Token" and then "Connect to LiveKit"');
    console.log('   3. Test publishing and subscribing to streams');
  } else {
    console.log('\n⚠️ WARNING: Some checks failed. Review the output above.');
  }
  
  console.log('\n💡 To switch back to MediaSoup:');
  console.log('   ./enable-dual-stack.sh enable mediasoup');
}

// Run the test
testLiveKitBackend().catch(error => {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
});