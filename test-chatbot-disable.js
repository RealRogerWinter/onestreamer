const axios = require('axios');

const serverUrl = 'http://localhost:8080';
const adminToken = 'your-admin-token'; // Replace with actual admin token if needed

async function testChatbotDisableAll() {
    console.log('🧪 CHATBOT DISABLE TEST: Starting comprehensive test...\n');
    
    try {
        // Step 1: Check current chatbot status
        console.log('📊 Step 1: Checking current chatbot status...');
        let response = await axios.get(`${serverUrl}/api/chatbots`);
        const initialBots = response.data;
        console.log(`   Found ${initialBots.length} chatbots total`);
        const enabledBots = initialBots.filter(bot => bot.is_enabled);
        console.log(`   ${enabledBots.length} are currently enabled\n`);
        
        // Step 2: Enable all chatbots for testing
        console.log('✅ Step 2: Enabling all chatbots for testing...');
        response = await axios.post(`${serverUrl}/api/chatbots/all/enable`, {}, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        }).catch(err => {
            console.log('   Note: Enable all endpoint requires admin auth or may not exist');
            return { data: { success: false } };
        });
        
        if (response.data.success) {
            console.log(`   Successfully enabled ${response.data.count} chatbots`);
        }
        
        // Wait for connections to establish
        console.log('   Waiting 3 seconds for connections to establish...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Step 3: Check active sessions before disable
        console.log('\n📋 Step 3: Checking active chatbot sessions...');
        // This would require database access, so we'll monitor server logs instead
        console.log('   Monitor server logs for active connections...\n');
        
        // Step 4: Disable all chatbots
        console.log('🔴 Step 4: DISABLING ALL CHATBOTS...');
        response = await axios.post(`${serverUrl}/api/chatbots/all/disable`, {}, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        
        console.log('   Response:', response.data);
        if (response.data.success) {
            console.log(`   ✅ Successfully disabled ${response.data.botsDisabled} bots`);
            console.log(`   ✅ Disconnected ${response.data.sessionsDisconnected} active sessions`);
        }
        
        // Step 5: Wait and verify no reconnections
        console.log('\n⏳ Step 5: Waiting 5 seconds to verify no reconnections...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Step 6: Check final status
        console.log('\n📊 Step 6: Checking final chatbot status...');
        response = await axios.get(`${serverUrl}/api/chatbots`);
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
        console.log('   1. "DISABLE ALL: Force disconnecting socket" messages');
        console.log('   2. No more "Bot X connection error" messages after disable');
        console.log('   3. No chat messages from bots after disable\n');
        
    } catch (error) {
        console.error('❌ Test error:', error.message);
        if (error.response) {
            console.error('   Response status:', error.response.status);
            console.error('   Response data:', error.response.data);
        }
    }
}

// Run the test
testChatbotDisableAll();