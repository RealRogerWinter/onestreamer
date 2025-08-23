/**
 * Enable the test bot to verify Socket.IO is working
 */

const axios = require('axios');

const SERVER_URL = 'https://127.0.0.1:8443';
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

async function enableTestBot() {
  console.log('🤖 Enabling Test Bot\n');
  
  try {
    // Call admin endpoint to enable test bot
    const response = await axios.post(`${SERVER_URL}/admin/enable-test-bot`, {}, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    console.log('Response:', response.data);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    
    // If endpoint doesn't exist, provide manual instructions
    if (error.response?.status === 404) {
      console.log('\n📝 Manual steps to enable test bot:');
      console.log('1. SSH into server');
      console.log('2. Run: pm2 attach onestreamer-server');
      console.log('3. Type: global.testBot.start()');
      console.log('4. You should see stream-ready events every 5 seconds');
    }
  }
}

enableTestBot();