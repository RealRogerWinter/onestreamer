const axios = require('axios');

const serverUrl = 'http://localhost:8080';
const credentials = {
    email: 'user@example.com',
    password: '***REMOVED-ADMIN-KEY***'
};

async function testChatbotDisableWithAuth() {
    console.log('🧪 CHATBOT DISABLE TEST: Starting authenticated test...\n');
    
    try {
        // Step 1: Login to get token
        console.log('🔐 Step 1: Authenticating...');
        const loginResponse = await axios.post(`${serverUrl}/auth/login`, credentials);
        const token = loginResponse.data.token;
        console.log('   ✅ Authentication successful\n');
        
        // Configure axios with auth header
        const authAxios = axios.create({
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        // Step 2: Check current chatbot status
        console.log('📊 Step 2: Checking current chatbot status...');
        let response = await authAxios.get(`${serverUrl}/api/chatbots`);
        const initialBots = response.data;
        console.log(`   Found ${initialBots.length} chatbots total`);
        const enabledBots = initialBots.filter(bot => bot.is_enabled);
        console.log(`   ${enabledBots.length} are currently enabled\n`);
        
        // Step 3: Enable all chatbots for testing
        console.log('✅ Step 3: Enabling all chatbots for testing...');
        response = await authAxios.post(`${serverUrl}/api/chatbots/all/enable`);
        console.log(`   Response:`, response.data);
        
        // Wait for connections to establish
        console.log('   Waiting 5 seconds for connections to establish...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Step 4: Check active sessions before disable
        console.log('\n📋 Step 4: Checking for active chatbot connections...');
        console.log('   Monitor server logs for active bot connections...\n');
        
        // Step 5: Disable all chatbots
        console.log('🔴 Step 5: DISABLING ALL CHATBOTS...');
        response = await authAxios.post(`${serverUrl}/api/chatbots/all/disable`);
        console.log('   Response:', response.data);
        if (response.data.success) {
            console.log(`   ✅ Successfully disabled ${response.data.botsDisabled} bots`);
            console.log(`   ✅ Disconnected ${response.data.sessionsDisconnected} active sessions`);
        }
        
        // Step 6: Wait and verify no reconnections
        console.log('\n⏳ Step 6: Waiting 10 seconds to verify no reconnections...');
        console.log('   Watch server logs for any "Bot X connection error" messages...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Step 7: Check final status
        console.log('\n📊 Step 7: Checking final chatbot status...');
        response = await authAxios.get(`${serverUrl}/api/chatbots`);
        const finalBots = response.data;
        const stillEnabled = finalBots.filter(bot => bot.is_enabled);
        
        console.log(`   Total chatbots: ${finalBots.length}`);
        console.log(`   Enabled chatbots: ${stillEnabled.length}`);
        
        if (stillEnabled.length === 0) {
            console.log('\n✅ SUCCESS: All chatbots are disabled!');
        } else {
            console.log('\n⚠️ WARNING: Some chatbots are still enabled:');
            stillEnabled.forEach(bot => {
                console.log(`   - ${bot.name} (ID: ${bot.id})`);
            });
        }
        
        console.log('\n📝 TEST COMPLETE: Check server logs above to verify:');
        console.log('   1. "DISABLE ALL: Force disconnecting socket" messages appear');
        console.log('   2. No more "Bot X connection error" messages after disable');
        console.log('   3. No chat messages from bots appear after disable');
        console.log('   4. No reconnection attempts from disabled bots\n');
        
    } catch (error) {
        console.error('❌ Test error:', error.message);
        if (error.response) {
            console.error('   Response status:', error.response.status);
            console.error('   Response data:', error.response.data);
        }
    }
}

// Run the test
testChatbotDisableWithAuth();