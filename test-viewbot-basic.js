/**
 * Basic ViewBot test to diagnose streaming issues
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testBasicViewBot() {
  console.log('🔧 Testing Basic ViewBot Functionality\n');
  
  try {
    // Step 1: Check server health
    console.log('1. Checking server health...');
    try {
      const health = await axios.get(`${SERVER_URL}/api/health`);
      console.log('✅ Server is running:', health.data);
    } catch (error) {
      console.error('❌ Server health check failed:', error.message);
      return;
    }
    
    // Step 2: Create a basic ViewBot with test pattern
    console.log('\n2. Creating ViewBot with test pattern...');
    const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, {
      config: {
        contentType: 'testPattern',
        testPattern: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30,
        // Disable new features to test basic functionality
        useMuxedStream: false,
        usePlainTransport: false,
        autoStart: true
      }
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      },
      timeout: 10000
    });
    
    console.log('Response:', createResponse.data);
    
    if (createResponse.data.success) {
      console.log(`✅ ViewBot created: ${createResponse.data.botId}`);
      
      // Step 3: Check status
      console.log('\n3. Checking ViewBot status...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      console.log('Status:', JSON.stringify(statusResponse.data, null, 2));
      
      // Step 4: Stop ViewBot
      console.log('\n4. Stopping ViewBot...');
      const stopResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/stop-streamer`, {
        botId: createResponse.data.botId
      }, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      console.log('Stop response:', stopResponse.data);
      
    } else {
      console.error('❌ Failed to create ViewBot:', createResponse.data.message);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n📋 Server not running. Please start the server:');
      console.log('   npm start');
    } else if (error.response?.status === 404) {
      console.log('\n❌ ViewBot endpoints not found. Check server routes.');
    } else {
      console.log('\nError details:', error);
    }
  }
}

// Run test
console.log('Starting ViewBot diagnostic test...\n');
testBasicViewBot();