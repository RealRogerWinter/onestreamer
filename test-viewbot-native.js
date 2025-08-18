/**
 * Simple ViewBot test using native Node.js HTTP
 */

const http = require('http');

function makeRequest(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body });
        }
      });
    });

    req.on('error', reject);
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

async function testViewBot() {
  console.log('🤖 Testing ViewBot creation...');
  
  const options = {
    hostname: 'localhost',
    port: 8080,
    path: '/admin/viewbot-client/create-streamer',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': '***REMOVED-ADMIN-KEY***'
    }
  };

  const payload = {
    config: {
      contentType: 'testPattern',
      testPattern: 'color-bars',
      width: 1280,
      height: 720,
      frameRate: 30,
      autoStart: true
    }
  };

  try {
    const response = await makeRequest(options, payload);
    
    if (response.statusCode === 200 && response.data.success) {
      console.log(`✅ ViewBot created successfully: ${response.data.botId}`);
      console.log(`📺 Test pattern: ${payload.config.testPattern}`);
      console.log(`🌐 View at: http://localhost:3000`);
      console.log('\n🎯 ViewBot should now be streaming!');
      console.log('   - Check your browser for test pattern video');
      console.log('   - Should see color bars instead of black screen');
      console.log('   - Check server logs for RTP activity');
    } else {
      console.error('❌ ViewBot creation failed:', response.data);
    }
  } catch (error) {
    console.error('❌ Request failed:', error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n📋 Server not running. Please start the server first:');
      console.log('   npm start');
    }
  }
}

testViewBot();