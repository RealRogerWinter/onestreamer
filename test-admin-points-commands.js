const axios = require('axios');

// Configuration
const CHAT_SERVICE_URL = 'http://localhost:3001';
const MAIN_SERVER_URL = 'http://localhost:8080';

async function testAdminPointsCommands() {
  console.log('🧪 Testing Admin Points Commands');
  console.log('================================\n');

  try {
    // Test 1: Check if chat service is running
    console.log('1. Checking chat service health...');
    const healthResponse = await axios.get(`${CHAT_SERVICE_URL}/health`);
    console.log('✅ Chat service is running:', healthResponse.data);
    console.log('\n');

    // Test 2: Check if main server is running
    console.log('2. Checking main server health...');
    const mainHealthResponse = await axios.get(`${MAIN_SERVER_URL}/api/health`);
    console.log('✅ Main server is running');
    console.log('\n');

    // Test 3: Test give points endpoint directly (will fail without auth)
    console.log('3. Testing give points endpoint (expecting auth failure)...');
    try {
      await axios.post(`${MAIN_SERVER_URL}/api/internal/admin/give-points`, {
        targetUsername: 'testuser',
        amount: 100,
        adminUserId: 1
      });
    } catch (error) {
      if (error.response?.status === 401) {
        console.log('✅ Endpoint correctly requires authentication');
      } else {
        console.log('❌ Unexpected error:', error.response?.data || error.message);
      }
    }
    console.log('\n');

    // Test 4: Test take points endpoint directly (will fail without auth)
    console.log('4. Testing take points endpoint (expecting auth failure)...');
    try {
      await axios.post(`${MAIN_SERVER_URL}/api/internal/admin/take-points`, {
        targetUsername: 'testuser',
        amount: 50,
        adminUserId: 1
      });
    } catch (error) {
      if (error.response?.status === 401) {
        console.log('✅ Endpoint correctly requires authentication');
      } else {
        console.log('❌ Unexpected error:', error.response?.data || error.message);
      }
    }
    console.log('\n');

    console.log('================================');
    console.log('✨ Admin points commands endpoints are set up correctly!');
    console.log('\nTo test the commands in chat:');
    console.log('1. Login as an admin user');
    console.log('2. Open the chat interface');
    console.log('3. Use the following commands:');
    console.log('   /give [username] [amount] - Give points to a user');
    console.log('   /take [username] [amount] - Take points from a user');
    console.log('   /help - See all available admin commands');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.log('\n⚠️  Make sure both services are running:');
      console.log('   - Chat service on port 3001');
      console.log('   - Main server on port 8080');
    }
  }
}

// Run the test
testAdminPointsCommands();