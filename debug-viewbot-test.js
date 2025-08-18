// Simple test to check viewbot setup and synthetic user IDs
const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testViewbotState() {
    console.log('🔍 TESTING VIEWBOT STATE');
    console.log('========================');
    
    try {
        // Test throw item endpoint - it should show debug logs in server console
        console.log('1. Testing item throw to trigger InventoryService debug logging...');
        
        const response = await axios.post(`${BASE_URL}/api/inventory/throw`, {
            itemId: 2, // Smoke Bomb
            x: 0.5,
            y: 0.5
        }, {
            headers: {
                'Authorization': 'Bearer ***REMOVED-JWT***', // User 3 token
                'Content-Type': 'application/json'
            }
        });
        
        console.log('✅ Item throw successful:', response.status);
        console.log('📋 Response:', response.data);
    } catch (error) {
        if (error.response) {
            console.log('❌ Item throw failed:', error.response.status, error.response.data);
        } else {
            console.log('❌ Network error:', error.message);
        }
    }
    
    console.log('\n2. Now check server logs for:');
    console.log('- 🔍 INVENTORY DEBUG messages');
    console.log('- Viewbot detection logic');
    console.log('- Current streamer socket ID');
    console.log('- Synthetic user ID lookups');
    console.log('\nExpected behavior:');
    console.log('- Should show debug messages from InventoryService');
    console.log('- Should detect if current streamer is viewbot');
    console.log('- Should convert to synthetic user ID if viewbot');
}

testViewbotState();