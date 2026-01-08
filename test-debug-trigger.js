// Simple test to trigger debug logging for viewbot buff detection
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function triggerDebugLogging() {
    console.log('🔍 TRIGGERING DEBUG LOGGING FOR VIEWBOT BUFF DETECTION');
    console.log('=====================================================\n');

    console.log('Sending HTTP requests to trigger debug logging...');
    console.log('These will fail authentication, but should show debug output in server logs.\n');

    // Test different scenarios
    const testCases = [
        { name: 'User ID 3 (number)', targetUserId: 3, itemId: 2 },
        { name: 'User ID "3" (string)', targetUserId: "3", itemId: 2 },
        { name: 'Viewbot socket ID', targetUserId: "viewbot-1754798777716-3", itemId: 2 }
    ];

    for (const testCase of testCases) {
        console.log(`📊 Testing: ${testCase.name}`);
        console.log(`   Target: ${JSON.stringify(testCase.targetUserId)} (${typeof testCase.targetUserId})`);
        
        try {
            await axios.post(`${BASE_URL}/api/buffs/apply`, {
                targetUserId: testCase.targetUserId,
                itemId: testCase.itemId
            }, {
                headers: {
                    'Authorization': 'Bearer fake-token',
                    'Content-Type': 'application/json'
                }
            });
        } catch (err) {
            console.log(`   Result: ${err.response?.status} - ${err.response?.data?.error}`);
        }
        console.log('');
    }

    console.log('🔍 NOW CHECK SERVER LOGS FOR:');
    console.log('============================');
    console.log('Look for lines containing:');
    console.log('• "🔍 BUFF DEBUG"');
    console.log('• "🎯 BUFF DEBUG: MATCH!"');
    console.log('• "🎭 BUFF HTTP: Converting user ID"');
    console.log('');
    console.log('Expected behavior with the fix:');
    console.log('- For user ID 3: Should detect current streamer scenario and convert');
    console.log('- For viewbot socket ID: Should use existing viewbot detection');
}

triggerDebugLogging();