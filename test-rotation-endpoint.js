/**
 * Quick test for rotation status endpoint
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testRotationEndpoint() {
  console.log('🔍 Testing Rotation Status Endpoint\n');
  
  try {
    console.log('Testing each endpoint individually...\n');

    // Test 1: Toggle rotation
    console.log('1. Testing rotation toggle...');
    const toggleResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/toggle`, 
      { enabled: true }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log('Toggle response:', toggleResponse.data);

    // Test 2: Set real streamer status  
    console.log('\n2. Testing real streamer status...');
    const realStreamerResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/real-streamer-status`, 
      { isActive: false }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log('Real streamer response:', realStreamerResponse.data);

    // Test 3: Get rotation status
    console.log('\n3. Testing rotation status...');
    const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/rotation/status`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log('Status response:', statusResponse.data);

    // Test 4: Get health (which includes rotation info)
    console.log('\n4. Testing health endpoint (includes rotation info)...');
    const healthResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/health`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log('Health response (rotation info):', {
      rotationEnabled: healthResponse.data.rotationEnabled,
      currentLiveBot: healthResponse.data.currentLiveBot,
      realStreamerActive: healthResponse.data.realStreamerActive
    });

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testRotationEndpoint();