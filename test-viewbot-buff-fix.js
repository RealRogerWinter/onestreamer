// Test script to verify viewbot buff/debuff functionality
const axios = require('axios');

const ADMIN_KEY = 'onestreamer-admin-2024';
const BASE_URL = 'http://localhost:3000';

async function testViewbotBuffSystem() {
    console.log('🧪 Testing Viewbot Buff/Debuff System...');

    try {
        // Step 1: Start a viewbot
        console.log('1. Starting viewbot...');
        const startResponse = await axios.post(`${BASE_URL}/admin/viewbot/start`, {
            config: {
                content: 'color-bars',
                type: 'viewbot'
            }
        }, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });

        if (!startResponse.data.success) {
            throw new Error(`Failed to start viewbot: ${startResponse.data.message}`);
        }

        const viewbotId = startResponse.data.streamId;
        console.log(`✅ Viewbot started with ID: ${viewbotId}`);

        // Wait a moment for the viewbot to fully initialize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Step 2: Check viewbot status
        console.log('2. Checking viewbot status...');
        const statusResponse = await axios.get(`${BASE_URL}/admin/viewbot/status`, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });

        console.log('✅ Viewbot status:', JSON.stringify(statusResponse.data, null, 2));

        // Step 3: Verify synthetic user mapping was created
        console.log('3. The synthetic user mapping should have been created automatically');
        console.log(`   Expected synthetic user ID for ${viewbotId} should be visible in server logs`);

        // Wait a few more seconds to see if the buff system detects the viewbot as current streamer
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log('4. Testing complete! Check server logs for:');
        console.log('   - 🎭 BUFF: Created synthetic user ID [ID] for viewbot [streamId]');
        console.log('   - 🎭 BUFF: Linked viewbot [streamId] to synthetic user [ID] for buff system');
        console.log('   - 🎭 BUFF: Current streamer socketId [streamId] -> userId [syntheticID]');

        // Step 4: Stop the viewbot
        console.log('5. Stopping viewbot...');
        const stopResponse = await axios.post(`${BASE_URL}/admin/viewbot/stop`, {}, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });

        if (stopResponse.data.success) {
            console.log('✅ Viewbot stopped successfully');
            console.log('   Check logs for synthetic user mapping cleanup');
        }

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

// Run the test
testViewbotBuffSystem();