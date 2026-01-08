// Comprehensive test script to debug viewbot buff application flow
const axios = require('axios');

const ADMIN_KEY = 'onestreamer-admin-2024';
const BASE_URL = 'http://localhost:3000';

async function debugViewbotBuffFlow() {
    console.log('🔍 DEBUGGING: Complete Viewbot Buff Application Flow\n');

    try {
        // Step 1: Check current stream status
        console.log('=== STEP 1: Check Current Stream Status ===');
        const statusResponse = await axios.get(`${BASE_URL}/admin/dashboard`, {
            headers: { 'Authorization': 'Bearer your-jwt-token-here' }
        }).catch(err => {
            console.log('Dashboard requires JWT auth, skipping...');
            return { data: null };
        });

        // Step 2: Start a viewbot for testing
        console.log('\n=== STEP 2: Start Viewbot ===');
        const startResponse = await axios.post(`${BASE_URL}/admin/viewbot/start`, {
            config: {
                content: 'color-bars',
                type: 'viewbot'
            }
        }, {
            headers: { 'x-admin-key': ADMIN_KEY }
        }).catch(err => {
            console.error('❌ Failed to start viewbot:', err.response?.data || err.message);
            return null;
        });

        if (!startResponse || !startResponse.data.success) {
            console.error('❌ Cannot proceed without viewbot');
            return;
        }

        const viewbotId = startResponse.data.streamId;
        console.log(`✅ Viewbot started: ${viewbotId}`);

        // Wait for viewbot to initialize
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Step 3: Check viewbot status
        console.log('\n=== STEP 3: Check Viewbot Status ===');
        const viewbotStatusResponse = await axios.get(`${BASE_URL}/admin/viewbot/status`, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });
        
        console.log('Viewbot Status:', JSON.stringify(viewbotStatusResponse.data, null, 2));

        // Step 4: Test what happens when we try to identify the viewbot
        console.log('\n=== STEP 4: Server-side Viewbot Identification Test ===');
        console.log(`Testing if "${viewbotId}" is identified as viewbot stream...`);
        console.log('This should show up in server logs as viewbot detection attempts.');

        // Step 5: Try to apply buff via HTTP API with detailed logging
        console.log('\n=== STEP 5: Test HTTP API Buff Application ===');
        console.log('Attempting to apply buff via HTTP API...');
        console.log(`Target: ${viewbotId} (viewbot socket ID)`);
        console.log('Item: Speed Boost (itemId: 2)');
        console.log('Check server logs for detailed debug output...\n');

        // This will fail due to auth, but we want to see the server-side processing
        const buffResponse = await axios.post(`${BASE_URL}/api/buffs/apply`, {
            targetUserId: viewbotId,  // This should be the viewbot socket ID
            itemId: 2  // Speed Boost item
        }, {
            headers: { 
                'Authorization': 'Bearer fake-token',  // This will fail auth
                'Content-Type': 'application/json'
            }
        }).catch(err => {
            console.log('Expected auth failure:', err.response?.status, err.response?.data?.error);
            return null;
        });

        // Step 6: Check server logs instruction
        console.log('\n=== STEP 6: Manual Verification Required ===');
        console.log('Please check the server logs for:');
        console.log('1. "🎭 BUFF DEBUG HTTP: Received /api/buffs/apply" messages');
        console.log('2. Viewbot detection attempts');
        console.log('3. Synthetic user ID lookup results');
        console.log('4. Any error messages during the process');
        console.log('5. Current socketToUserId mappings');

        // Step 7: Wait and then stop viewbot
        console.log('\n=== STEP 7: Cleanup ===');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const stopResponse = await axios.post(`${BASE_URL}/admin/viewbot/stop`, {}, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });
        
        if (stopResponse.data.success) {
            console.log('✅ Viewbot stopped successfully');
        }

        // Step 8: Key questions to investigate
        console.log('\n=== STEP 8: Key Investigation Points ===');
        console.log('Based on server logs, investigate:');
        console.log('1. Is the viewbot socket ID being correctly identified?');
        console.log('2. Is the synthetic user ID being created and stored?');
        console.log('3. Is the HTTP request reaching the /api/buffs/apply endpoint?');
        console.log('4. Is the viewbot detection logic being triggered?');
        console.log('5. What is the final targetUserId being used?');

    } catch (error) {
        console.error('❌ Debug script failed:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

// Also create a simple socket connection test
async function testSocketConnection() {
    console.log('\n🔌 SOCKET CONNECTION TEST');
    console.log('This would require socket.io-client to test the socket handler path.');
    console.log('The HTTP API path is more likely to be used by the frontend.');
}

console.log('Starting viewbot buff flow debug...\n');
debugViewbotBuffFlow();