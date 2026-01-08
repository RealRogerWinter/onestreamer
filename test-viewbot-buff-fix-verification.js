// Test script to verify the viewbot buff fix is working correctly
const axios = require('axios');

const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';
const BASE_URL = 'http://localhost:3000';

async function testViewbotBuffFix() {
    console.log('🧪 TESTING VIEWBOT BUFF FIX');
    console.log('============================\n');

    try {
        // Step 1: Get current viewbot status
        console.log('1️⃣ Checking current viewbots...');
        const statusResponse = await axios.get(`${BASE_URL}/admin/viewbot/status`, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });

        console.log('Active viewbots:', statusResponse.data.activeStreams);

        if (!statusResponse.data.activeStreams || statusResponse.data.activeStreams.length === 0) {
            console.log('No viewbots found. Starting one for testing...');
            
            const startResponse = await axios.post(`${BASE_URL}/admin/viewbot/start`, {
                config: {
                    content: 'color-bars',
                    type: 'viewbot'
                }
            }, {
                headers: { 'x-admin-key': ADMIN_KEY }
            });

            if (startResponse.data.success) {
                console.log(`✅ Started viewbot: ${startResponse.data.streamId}\n`);
                await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for initialization
            } else {
                throw new Error('Failed to start viewbot');
            }
        }

        // Step 2: Test the scenarios that should now work
        console.log('2️⃣ Testing buff application scenarios...\n');

        // First test with a fake JWT token (will fail auth but show our debug logic)
        console.log('📊 SCENARIO TEST: HTTP route with debug logging');
        console.log('This will fail authentication, but check server logs for debug output...');
        
        try {
            await axios.post(`${BASE_URL}/api/buffs/apply`, {
                targetUserId: 3, // Test with a user ID
                itemId: 2
            }, {
                headers: {
                    'Authorization': 'Bearer fake-token',
                    'Content-Type': 'application/json'
                }
            });
        } catch (err) {
            console.log(`Expected auth failure: ${err.response?.status}`);
        }

        console.log('\n📋 CHECK SERVER LOGS FOR:');
        console.log('=========================');
        console.log('Look for these debug messages in the server console:');
        console.log('🔍 "🔍 BUFF DEBUG: Current streamer socket ID"');
        console.log('🔍 "🔍 BUFF DEBUG: Is current streamer a viewbot?"');
        console.log('🔍 "🔍 BUFF DEBUG: Checking if targetUserId matches current streamer scenario"');
        console.log('🔍 "🎯 BUFF DEBUG: MATCH! Client sent current streamer user ID"');
        console.log('🔍 "🎯 BUFF DEBUG: Final targetUserId after all processing"');
        console.log('');
        console.log('🎯 EXPECTED BEHAVIOR:');
        console.log('- If current streamer is a viewbot and targetUserId=3, should see "MATCH!" message');
        console.log('- Final targetUserId should be a negative number (synthetic user ID)');
        console.log('- This means buff will be applied to viewbot, not user 3');
        console.log('');
        console.log('⚠️  MANUAL VERIFICATION NEEDED:');
        console.log('Use the actual frontend to apply a buff to the current viewbot.');
        console.log('With this fix, the buff should now correctly target the viewbot.');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

console.log('Testing the viewbot buff fix...\n');
testViewbotBuffFix();