const axios = require('axios');

const serverUrl = 'http://localhost:8080';
const credentials = {
    email: 'user@example.com',
    password: '***REMOVED-ADMIN-KEY***'
};

async function quickDisableTest() {
    console.log('🧪 QUICK CHATBOT TEST: Testing disable functionality...\n');
    
    try {
        // Login
        const loginResponse = await axios.post(`${serverUrl}/auth/login`, credentials);
        const token = loginResponse.data.token;
        const authAxios = axios.create({
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        console.log('✅ Enabling all chatbots...');
        await authAxios.post(`${serverUrl}/api/chatbots/all/enable`);
        
        console.log('⏳ Waiting 8 seconds for connections...');
        await new Promise(resolve => setTimeout(resolve, 8000));
        
        console.log('🔴 DISABLING ALL CHATBOTS NOW...');
        const response = await authAxios.post(`${serverUrl}/api/chatbots/all/disable`);
        console.log('Disable Response:', JSON.stringify(response.data, null, 2));
        
        console.log('\n⏳ Waiting 10 seconds to monitor for reconnection attempts...');
        console.log('Watch the server logs above for:');
        console.log('  - "DISABLE ALL: Force disconnecting socket" messages');
        console.log('  - No more "Bot X connection error" messages');
        console.log('  - No reconnection attempts from bots\n');
        
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        console.log('✅ Test complete! Check server logs for disconnection behavior.');
        
    } catch (error) {
        console.error('❌ Test error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

quickDisableTest();