const axios = require('axios');

const BASE_URL = 'https://onestreamer.live';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'your-admin-token-here';

async function testModerationEndpoints() {
  console.log('🧪 Testing Stream Moderation Endpoints\n');

  // Test 1: Verify admin access
  console.log('1. Testing admin verification...');
  try {
    const response = await axios.get(`${BASE_URL}/api/admin/verify`, {
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`
      }
    });
    console.log('✅ Admin verification successful:', response.data);
  } catch (error) {
    console.log('❌ Admin verification failed:', error.response?.data || error.message);
  }

  // Test 2: Get current stream info
  console.log('\n2. Testing stream info endpoint...');
  try {
    const response = await axios.get(`${BASE_URL}/api/stream/active`, {
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`
      }
    });
    console.log('✅ Stream info retrieved:', response.data);
    
    if (response.data.isActive && response.data.streamerId) {
      // Test 3: Get stream details with IP
      console.log('\n3. Testing stream details endpoint...');
      try {
        const detailsResponse = await axios.get(
          `${BASE_URL}/api/admin/stream-details/${response.data.streamerId}`,
          {
            headers: {
              'Authorization': `Bearer ${ADMIN_TOKEN}`
            }
          }
        );
        console.log('✅ Stream details retrieved:', detailsResponse.data);
      } catch (error) {
        console.log('❌ Stream details failed:', error.response?.data || error.message);
      }
    }
  } catch (error) {
    console.log('❌ Stream info failed:', error.response?.data || error.message);
  }

  // Test 4: Get banned IPs
  console.log('\n4. Testing banned IPs list...');
  try {
    const response = await axios.get(`${BASE_URL}/api/admin/banned-ips`, {
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`
      }
    });
    console.log('✅ Banned IPs retrieved:', response.data);
  } catch (error) {
    console.log('❌ Banned IPs failed:', error.response?.data || error.message);
  }

  console.log('\n🏁 Moderation endpoint tests complete!');
}

// Run tests
testModerationEndpoints().catch(console.error);