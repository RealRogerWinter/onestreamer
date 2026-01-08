// Comprehensive test to identify the root cause of viewbot buff issues
const axios = require('axios');

const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';
const BASE_URL = 'http://localhost:3000';

async function runCompleteViewbotBuffTest() {
    console.log('🧪 COMPLETE VIEWBOT BUFF TEST');
    console.log('===============================\n');

    try {
        // Step 1: Get existing viewbot status  
        console.log('1️⃣ Checking existing viewbots...');
        const statusResponse = await axios.get(`${BASE_URL}/admin/viewbot/status`, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });

        let viewbotSocketId;
        if (statusResponse.data.activeStreams && statusResponse.data.activeStreams.length > 0) {
            viewbotSocketId = statusResponse.data.activeStreams[0];
            console.log(`✅ Using existing viewbot: ${viewbotSocketId}\n`);
        } else {
            console.log('No existing viewbots found, starting a new one...');
            const startResponse = await axios.post(`${BASE_URL}/admin/viewbot/start`, {
                config: {
                    content: 'color-bars',
                    type: 'viewbot'
                }
            }, {
                headers: { 'x-admin-key': ADMIN_KEY }
            });

            if (!startResponse.data.success) {
                throw new Error('Failed to start viewbot');
            }

            viewbotSocketId = startResponse.data.streamId;
            console.log(`✅ New viewbot started: ${viewbotSocketId}\n`);

            // Wait for initialization
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // Step 2: Test different scenarios that the client might be doing
        console.log('2️⃣ Testing different client scenarios...\n');

        // Scenario A: Client sends viewbot socket ID (what we expect)
        console.log('📊 SCENARIO A: Client sends viewbot socket ID');
        console.log(`Target: "${viewbotSocketId}" (string, socket ID)`);
        console.log('Expected: Should detect as viewbot and translate to synthetic user ID');
        
        try {
            await axios.post(`${BASE_URL}/api/buffs/apply`, {
                targetUserId: viewbotSocketId,  // String socket ID
                itemId: 2
            }, {
                headers: {
                    'Authorization': 'Bearer fake-token',
                    'Content-Type': 'application/json'
                }
            });
        } catch (err) {
            console.log(`Response: ${err.response?.status} - ${err.response?.data?.error}`);
        }
        console.log('Check server logs for "🔍 BUFF DEBUG" messages\n');

        // Scenario B: Client sends numeric ID (potential issue)
        console.log('📊 SCENARIO B: Client sends numeric user ID');
        console.log('Target: 3 (number, user ID)');
        console.log('Expected: Should NOT detect as viewbot, apply to user 3');
        
        try {
            await axios.post(`${BASE_URL}/api/buffs/apply`, {
                targetUserId: 3,  // Numeric user ID
                itemId: 2
            }, {
                headers: {
                    'Authorization': 'Bearer fake-token',
                    'Content-Type': 'application/json'
                }
            });
        } catch (err) {
            console.log(`Response: ${err.response?.status} - ${err.response?.data?.error}`);
        }
        console.log('Check server logs for "🔍 BUFF DEBUG" messages\n');

        // Scenario C: Client sends string numeric ID
        console.log('📊 SCENARIO C: Client sends string numeric ID');
        console.log('Target: "3" (string, user ID)');
        console.log('Expected: Should NOT detect as viewbot, apply to user 3');
        
        try {
            await axios.post(`${BASE_URL}/api/buffs/apply`, {
                targetUserId: "3",  // String user ID
                itemId: 2
            }, {
                headers: {
                    'Authorization': 'Bearer fake-token',
                    'Content-Type': 'application/json'
                }
            });
        } catch (err) {
            console.log(`Response: ${err.response?.status} - ${err.response?.data?.error}`);
        }
        console.log('Check server logs for "🔍 BUFF DEBUG" messages\n');

        // Step 3: Check what the server knows about the current state
        console.log('3️⃣ Server state verification...');
        console.log('Current viewbots:', JSON.stringify(statusResponse.data.activeStreams, null, 2));

        // Step 4: Manual verification instructions
        console.log('\n4️⃣ MANUAL VERIFICATION REQUIRED');
        console.log('==========================================');
        console.log('Check server logs for the following patterns:');
        console.log('');
        console.log('🔍 Look for "🔍 BUFF DEBUG" messages showing:');
        console.log('  - What targetUserId was received (type and value)');
        console.log('  - Whether viewbot detection was triggered');
        console.log('  - Current streamer socket ID');
        console.log('  - Whether current streamer is detected as viewbot');
        console.log('');
        console.log('🎯 EXPECTED PATTERNS:');
        console.log('  Scenario A (socket ID): Should show viewbot detection = true');
        console.log('  Scenario B & C (user ID): Should show viewbot detection = false');
        console.log('');
        console.log('🚨 KEY QUESTION: Which scenario matches your actual client behavior?');

        // Step 5: Next steps based on findings
        console.log('\n5️⃣ NEXT STEPS BASED ON FINDINGS:');
        console.log('=====================================');
        console.log('IF client sends socket ID (Scenario A):');
        console.log('  → Check why viewbot detection isn\'t working');
        console.log('  → Verify synthetic user ID creation/mapping');
        console.log('');
        console.log('IF client sends user ID (Scenarios B/C):');
        console.log('  → This explains the bug completely');
        console.log('  → Need to either:');
        console.log('    a) Fix client to send socket ID, OR');
        console.log('    b) Add server logic to detect current-streamer targeting');
        console.log('');
        console.log('The server logs will reveal which scenario is happening.');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

// Run the test
console.log('Starting comprehensive viewbot buff test...');
console.log('This will test multiple scenarios to identify the root cause.\n');
runCompleteViewbotBuffTest();