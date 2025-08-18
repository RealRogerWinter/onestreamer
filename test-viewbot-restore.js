/**
 * Test ViewBot with original implementation (sync features disabled)
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function testOriginalViewBot() {
  console.log('🔧 Testing ViewBot with Original Implementation\n');
  
  try {
    // Create ViewBot with all new features explicitly disabled
    console.log('Creating ViewBot with original settings...');
    const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, {
      config: {
        contentType: 'testPattern',
        testPattern: 'color-bars',
        width: 640,
        height: 480,
        frameRate: 30,
        // Explicitly disable all new sync features
        useMuxedStream: false,
        usePlainTransport: false,
        autoStart: false
      }
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      },
      timeout: 5000
    });
    
    if (createResponse.data.success) {
      console.log(`✅ ViewBot created: ${createResponse.data.botId}`);
      
      // Start streaming
      console.log('\nStarting ViewBot streaming...');
      const startResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/start-streaming`, {
        botId: createResponse.data.botId
      }, {
        headers: {
          'x-admin-key': ADMIN_KEY
        },
        timeout: 5000
      });
      
      console.log('Start response:', startResponse.data);
      
      // Wait and check status
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      console.log('\nChecking ViewBot status...');
      const statusResponse = await axios.get(`${SERVER_URL}/admin/viewbot-client/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      if (statusResponse.data.activeBots && statusResponse.data.activeBots.length > 0) {
        const bot = statusResponse.data.activeBots[0];
        console.log('\n📊 ViewBot Status:');
        console.log(`  Bot ID: ${bot.botId}`);
        console.log(`  Connected: ${bot.isConnected}`);
        console.log(`  Streaming: ${bot.isStreaming}`);
        console.log(`  Content: ${bot.config.contentType}`);
        
        if (bot.isStreaming) {
          console.log('\n✅ SUCCESS: ViewBot is streaming successfully!');
        } else {
          console.log('\n⚠️ ViewBot created but not streaming');
        }
      }
      
      // Stop ViewBot
      console.log('\nStopping ViewBot...');
      await axios.post(`${SERVER_URL}/admin/viewbot-client/stop-streamer`, {
        botId: createResponse.data.botId
      }, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      console.log('✅ ViewBot stopped');
      
    } else {
      console.error('❌ Failed to create ViewBot:', createResponse.data.message);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n📋 Server not running. Please start:');
      console.log('   npm start');
    }
  }
}

// Also test with the legacy ViewbotService (not ViewBotClientService)
async function testLegacyViewbot() {
  console.log('\n🔧 Testing Legacy ViewBot Service\n');
  
  try {
    console.log('Starting legacy viewbot...');
    const response = await axios.post(`${SERVER_URL}/admin/viewbot/start`, {
      config: {
        type: 'viewbot',
        content: 'color-bars',
        width: 640,
        height: 480,
        frameRate: 30
      }
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      },
      timeout: 5000
    });
    
    console.log('Response:', response.data);
    
    if (response.data.success) {
      console.log('✅ Legacy viewbot started successfully');
      
      // Check status
      const status = await axios.get(`${SERVER_URL}/admin/viewbot/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      console.log('Status:', status.data);
      
      // Stop
      await axios.post(`${SERVER_URL}/admin/viewbot/stop`, {}, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      console.log('✅ Legacy viewbot stopped');
    }
    
  } catch (error) {
    console.error('❌ Legacy test failed:', error.response?.data || error.message);
  }
}

// Run tests
async function runTests() {
  await testOriginalViewBot();
  await testLegacyViewbot();
}

runTests();