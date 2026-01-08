const https = require('https');

// First, let's get a test token by logging in
const loginData = JSON.stringify({
  username: 'onestreamer',
  password: 'test123' // You'll need to replace with actual password
});

const loginOptions = {
  hostname: 'onestreamer.live',
  port: 443,
  path: '/api/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': loginData.length
  },
  rejectUnauthorized: false
};

console.log('🔐 Attempting to login...');

const loginReq = https.request(loginOptions, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      
      if (res.statusCode !== 200) {
        console.log('❌ Login failed:', result);
        console.log('Note: You need to update the password in this script');
        return;
      }
      
      console.log('✅ Login successful');
      const token = result.token;
      
      // Now test the fart item usage
      testFartItem(token);
      
    } catch (error) {
      console.error('❌ Error parsing login response:', error);
      console.log('Raw response:', data);
    }
  });
});

loginReq.on('error', (error) => {
  console.error('❌ Login request failed:', error);
});

function testFartItem(token) {
  console.log('\n💨 Testing fart item usage...');
  
  const useOptions = {
    hostname: 'onestreamer.live',
    port: 443,
    path: '/api/inventory/use/77', // Fart item ID
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    rejectUnauthorized: false
  };
  
  const useReq = https.request(useOptions, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log(`Response Status: ${res.statusCode}`);
      console.log('Response Headers:', res.headers);
      
      try {
        const result = JSON.parse(data);
        console.log('Response Body:', JSON.stringify(result, null, 2));
        
        if (res.statusCode === 200) {
          console.log('✅ Fart item used successfully!');
        } else {
          console.log('❌ Failed to use fart item');
        }
      } catch (error) {
        console.log('Raw response:', data);
      }
    });
  });
  
  useReq.on('error', (error) => {
    console.error('❌ Use item request failed:', error);
  });
  
  useReq.end();
}

// If you want to skip login and test with a known token:
// testFartItem('YOUR_TOKEN_HERE');

loginReq.write(loginData);
loginReq.end();