const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

// User credentials
const EMAIL = 'user@example.com';
const PASSWORD = '***REMOVED-ADMIN-KEY***';

async function testOnestreamerFix() {
    console.log('🧪 Testing onestreamer speed boost fix...\n');
    
    try {
        // Login
        console.log('🔐 Logging in as onestreamer...');
        const loginResponse = await axios.post(`${BASE_URL}/api/auth/login`, {
            email: EMAIL,
            password: PASSWORD
        });
        
        const token = loginResponse.data.token;
        const userId = loginResponse.data.user.id;
        console.log(`✅ Logged in as ${loginResponse.data.user.username} (ID: ${userId})`);
        
        // Get inventory to confirm speed boost items
        console.log('\n📦 Checking inventory...');
        const inventoryResponse = await axios.get(`${BASE_URL}/api/inventory`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const speedBoostItem = inventoryResponse.data.find(item => item.name === 'speed_boost');
        
        if (speedBoostItem) {
            console.log(`✅ Has ${speedBoostItem.quantity} speed boost items`);
        } else {
            console.log('❌ No speed boost items found');
            return;
        }
        
        // Check cooldowns before using
        console.log('\n⏰ Checking cooldowns...');
        const cooldownsResponse = await axios.get(`${BASE_URL}/api/inventory/cooldowns`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const speedBoostCooldown = cooldownsResponse.data.find(cd => cd.name === 'speed_boost');
        if (speedBoostCooldown) {
            console.log(`⚠️  Speed boost on cooldown: ${speedBoostCooldown.cooldownRemaining}s remaining`);
        } else {
            console.log('✅ Speed boost not on cooldown');
        }
        
        // Try to use the speed boost item
        console.log('\n⚡ Attempting to use speed boost item...');
        const useResponse = await axios.post(`${BASE_URL}/api/inventory/use/1`, {}, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log('🎉 SUCCESS! Speed boost used successfully!');
        console.log('📋 Response:', JSON.stringify(useResponse.data, null, 2));
        
        // Check if a buff was applied
        if (useResponse.data.buffApplied) {
            console.log(`✅ Buff applied: ID ${useResponse.data.buffApplied.id}, Duration: ${useResponse.data.buffApplied.duration}s`);
        }
        
        // Check active buffs
        console.log('\n🎭 Checking active buffs...');
        const buffsResponse = await axios.get(`${BASE_URL}/api/buffs/active`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log(`📊 Active buffs: ${buffsResponse.data.length}`);
        buffsResponse.data.forEach(buff => {
            console.log(`   - ${buff.displayName}: ${buff.remainingSeconds}s remaining`);
        });
        
        console.log('\n✅ Test completed successfully! The bug has been fixed.');
        
    } catch (error) {
        if (error.response) {
            console.error(`❌ API Error: ${error.response.status} - ${error.response.data.error || error.response.data}`);
            
            if (error.response.data.error && error.response.data.error.includes('cooldown')) {
                console.log('\n🔍 Still on cooldown - this means the fix needs more investigation');
            }
        } else {
            console.error('❌ Network error:', error.message);
        }
    }
}

testOnestreamerFix();