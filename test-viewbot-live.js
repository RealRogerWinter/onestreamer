const axios = require('axios');

async function testViewBotLive() {
  console.log('🧪 Testing ViewBot streaming on live server...\n');
  
  const BASE_URL = 'http://localhost:8080';
  const ADMIN_KEY = process.env.ADMIN_KEY || 'test123';
  
  try {
    console.log('1. Starting ViewBot stream...');
    const startResponse = await axios.post(`${BASE_URL}/admin/viewbot/start`, {
      config: {
        content: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30
      }
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (startResponse.data.success) {
      console.log('✅ ViewBot started successfully');
      console.log(`📊 Stream ID: ${startResponse.data.streamId}`);
      console.log(`🎭 Mode: ${startResponse.data.mode}`);
      console.log(`📺 Config:`, startResponse.data.config);
      
      console.log('\n2. Checking stream status...');
      const statusResponse = await axios.get(`${BASE_URL}/admin/viewbot/status`, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      console.log('📊 ViewBot Status:');
      console.log(`  Active: ${statusResponse.data.isActive}`);
      console.log(`  Process: ${statusResponse.data.processStatus}`);
      console.log(`  MediaSoup: ${statusResponse.data.hasMediaSoupProducer ? 'Connected' : 'Not Connected'}`);
      
      if (statusResponse.data.webrtcStatus) {
        console.log(`  WebRTC Bots: ${statusResponse.data.webrtcStatus.runningBots}/${statusResponse.data.webrtcStatus.totalBots}`);
      }
      
      console.log('\n3. Waiting 5 seconds for stream to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      console.log('\n4. Stopping ViewBot stream...');
      const stopResponse = await axios.post(`${BASE_URL}/admin/viewbot/stop`, {}, {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      });
      
      if (stopResponse.data.success) {
        console.log('✅ ViewBot stopped successfully');
        console.log(`📊 Stream ID: ${stopResponse.data.streamId}`);
      } else {
        console.log('❌ Failed to stop ViewBot:', stopResponse.data.message);
      }
      
      console.log('\n🎉 ViewBot live test completed!');
      console.log('\n💡 Next steps:');
      console.log('  1. Open browser at http://localhost:8080');
      console.log('  2. Start ViewBot from admin panel');
      console.log('  3. Check if video appears for viewers');
      
    } else {
      console.log('❌ Failed to start ViewBot:', startResponse.data.message);
    }
    
  } catch (error) {
    if (error.response) {
      console.error('❌ API Error:', error.response.status, error.response.data);
    } else if (error.request) {
      console.error('❌ No response from server. Is it running on port 8080?');
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

// Run the test
testViewBotLive();