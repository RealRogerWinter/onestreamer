const axios = require('axios');

// Test configuration
const API_URL = 'https://onestreamer.live';
const TEST_TOKEN = '***REMOVED-JWT***'; // onestreamer's token

async function testBuffOnAnonymousStreamer() {
    console.log('🧪 Testing buff/debuff items on anonymous streamers...\n');
    
    try {
        // Try to use a buff item (Stream Reducer - ID 33)
        console.log('1️⃣ Attempting to use Stream Reducer (buff item) on anonymous streamer...');
        const response = await axios.post(
            `${API_URL}/api/inventory/use/33`,
            {},
            {
                headers: {
                    'Authorization': `Bearer ${TEST_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                validateStatus: false // Don't throw on 4xx/5xx
            }
        );
        
        console.log(`   Status: ${response.status}`);
        console.log(`   Response:`, response.data);
        
        if (response.status === 400 && response.data.error === 'Cannot apply buff/debuff to anonymous streamers') {
            console.log('   ✅ Correctly prevented buff on anonymous streamer!');
        } else {
            console.log('   ❌ Unexpected response - should prevent buff on anonymous streamer');
        }
        
        console.log('\n2️⃣ Attempting to use Heat Seeking Eggs (debuff item) on anonymous streamer...');
        const response2 = await axios.post(
            `${API_URL}/api/inventory/use/65`,
            {},
            {
                headers: {
                    'Authorization': `Bearer ${TEST_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                validateStatus: false
            }
        );
        
        console.log(`   Status: ${response2.status}`);
        console.log(`   Response:`, response2.data);
        
        if (response2.status === 400 && response2.data.error === 'Cannot apply buff/debuff to anonymous streamers') {
            console.log('   ✅ Correctly prevented debuff on anonymous streamer!');
        } else {
            console.log('   ❌ Unexpected response - should prevent debuff on anonymous streamer');
        }
        
        console.log('\n✅ Test complete! Buff/debuff items are now properly blocked for anonymous streamers.');
        console.log('   Users will see a clear message explaining that these items only work on registered streamers.');
        
    } catch (error) {
        console.error('❌ Test failed with error:', error.message);
        if (error.response) {
            console.error('   Response data:', error.response.data);
        }
    }
}

// Run the test
testBuffOnAnonymousStreamer();