const axios = require('axios');
const https = require('https');

// Create HTTPS agent to accept self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

async function testAdminAuth() {
  try {
    // First, login to get a token
    console.log('1. Logging in as admin...');
    const loginResponse = await axios.post(
      'https://<SERVER_IP>:8443/api/auth/login',
      {
        username: 'admin',
        password: 'REDACTED-ADMIN-KEY'
      },
      { httpsAgent }
    );
    
    const token = loginResponse.data.token;
    const userId = loginResponse.data.user.id;
    console.log('✅ Login successful, got token:', token.substring(0, 20) + '...');
    console.log('   User ID:', userId);
    console.log('   Is Admin:', loginResponse.data.user.is_admin);
    
    // Test the admin status endpoint directly
    console.log('\n2. Testing admin status endpoint...');
    const adminStatusResponse = await axios.get(
      `https://<SERVER_IP>:8443/api/internal/user/${userId}/admin-status`,
      { httpsAgent }
    );
    
    console.log('✅ Admin status response:', adminStatusResponse.data);
    
    // Test connecting to chat with admin token
    console.log('\n3. Testing chat service admin check...');
    const io = require('socket.io-client');
    
    const socket = io('https://<SERVER_IP>:8444', {
      auth: {
        token: token
      },
      rejectUnauthorized: false // Accept self-signed certificates
    });
    
    socket.on('connect', () => {
      console.log('✅ Connected to chat service');
      
      // Try an admin command
      socket.emit('send-message', { message: '/help' });
    });
    
    socket.on('new-message', (message) => {
      if (message.isAdminOnly) {
        console.log('✅ Received admin response:', message.message.substring(0, 50) + '...');
        console.log('🎉 Admin authentication is working properly!');
        process.exit(0);
      }
    });
    
    socket.on('error', (error) => {
      console.error('❌ Socket error:', error);
    });
    
    socket.on('disconnect', () => {
      console.log('❌ Disconnected from chat service');
    });
    
    // Timeout after 5 seconds
    setTimeout(() => {
      console.log('⏱️ Test timed out');
      process.exit(1);
    }, 5000);
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

testAdminAuth();