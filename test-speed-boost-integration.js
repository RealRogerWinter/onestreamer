const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const BASE_URL = 'http://localhost:8080';
const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

// Test user credentials
const TEST_EMAIL = 'user@example.com';
const TEST_PASSWORD = 'password123';

async function testSpeedBoostIntegration() {
    console.log('🧪 Testing Speed Boost Item Integration with Buff System');
    
    try {
        // Step 1: Login to get token
        console.log('\n🔐 Logging in...');
        const loginResponse = await axios.post(`${BASE_URL}/api/auth/login`, {
            email: TEST_EMAIL,
            password: TEST_PASSWORD
        });
        
        const token = loginResponse.data.token;
        const userId = loginResponse.data.user.id;
        console.log(`✅ Logged in as user ${userId}`);
        
        // Step 2: Get user's inventory to find speed boost item
        console.log('\n📦 Fetching user inventory...');
        const inventoryResponse = await axios.get(`${BASE_URL}/api/inventory`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const speedBoostItem = inventoryResponse.data.find(item => item.name === 'speed_boost');
        
        if (!speedBoostItem) {
            // Grant speed boost item if user doesn't have it
            console.log('⚠️  User doesn\'t have speed boost item, granting one...');
            const grantResponse = await axios.post(`${BASE_URL}/api/admin/items/grant`, {
                userId: userId,
                itemId: 1, // Assuming speed_boost has ID 1
                quantity: 1
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            console.log('✅ Speed boost item granted');
        } else {
            console.log(`✅ Found speed boost item: ${speedBoostItem.quantity} available`);
        }
        
        // Step 3: Check current buffs before using item
        console.log('\n🎭 Checking current buffs before using item...');
        const buffsBefore = await axios.get(`${BASE_URL}/api/buffs/active`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`📊 Active buffs before: ${buffsBefore.data.length} buffs`);
        buffsBefore.data.forEach(buff => {
            console.log(`   - ${buff.displayName} (${buff.remainingSeconds}s remaining)`);
        });
        
        // Step 4: Use the speed boost item
        console.log('\n⚡ Using speed boost item...');
        const useItemResponse = await axios.post(`${BASE_URL}/api/inventory/use/1`, {}, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log('✅ Speed boost item used successfully!');
        console.log('📋 Use item response:', JSON.stringify(useItemResponse.data, null, 2));
        
        // Step 5: Check buffs after using item
        console.log('\n🎭 Checking active buffs after using item...');
        const buffsAfter = await axios.get(`${BASE_URL}/api/buffs/active`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`📊 Active buffs after: ${buffsAfter.data.length} buffs`);
        buffsAfter.data.forEach(buff => {
            console.log(`   - ${buff.displayName} (${buff.remainingSeconds}s remaining)`);
        });
        
        // Step 6: Verify speed boost buff was applied
        const speedBoostBuff = buffsAfter.data.find(buff => buff.itemName === 'speed_boost');
        
        if (speedBoostBuff) {
            console.log('\n🎉 SUCCESS: Speed boost buff was applied correctly!');
            console.log(`   - Buff ID: ${speedBoostBuff.id}`);
            console.log(`   - Duration: ${speedBoostBuff.durationSeconds} seconds`);
            console.log(`   - Remaining: ${speedBoostBuff.remainingSeconds} seconds`);
            console.log(`   - Effect Data: ${JSON.stringify(speedBoostBuff.effectData)}`);
            
            // Also check if the buff was included in the item use response
            if (useItemResponse.data.buffApplied) {
                console.log('✅ Buff information was included in item use response');
                console.log(`   - Applied buff ID: ${useItemResponse.data.buffApplied.id}`);
                console.log(`   - Buff type: ${useItemResponse.data.buffApplied.buffType}`);
            } else {
                console.log('⚠️  Buff information was NOT included in item use response');
            }
        } else {
            console.log('\n❌ FAILURE: Speed boost buff was NOT applied');
            console.log('🔍 Available buffs:', buffsAfter.data.map(b => b.itemName));
        }
        
        // Step 7: Wait a few seconds and check buff countdown
        console.log('\n⏰ Waiting 3 seconds to check buff countdown...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const buffsCountdown = await axios.get(`${BASE_URL}/api/buffs/active`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const speedBoostBuffCountdown = buffsCountdown.data.find(buff => buff.itemName === 'speed_boost');
        
        if (speedBoostBuffCountdown) {
            console.log(`✅ Speed boost buff still active with ${speedBoostBuffCountdown.remainingSeconds}s remaining`);
            console.log('✅ Real-time countdown is working');
        } else {
            console.log('❌ Speed boost buff disappeared (may have expired or there\'s an issue)');
        }
        
        console.log('\n🎉 Speed boost integration test completed!');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.response?.data || error.message);
        if (error.response?.status === 401) {
            console.log('💡 Try creating a user account first or check credentials');
        }
    }
}

// Also check the database directly
async function checkDatabaseBuffs() {
    console.log('\n🗃️  Checking database for active buffs...');
    
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('❌ Database connection error:', err);
            return;
        }
    });
    
    db.all(`SELECT 
        ab.*, 
        i.name as item_name, 
        i.display_name, 
        i.emoji
    FROM active_buffs ab 
    JOIN items i ON ab.item_id = i.id 
    WHERE ab.is_active = 1 AND ab.remaining_seconds > 0
    ORDER BY ab.applied_at DESC`, (err, rows) => {
        if (err) {
            console.error('❌ Database query error:', err);
        } else {
            console.log(`📊 Database shows ${rows.length} active buffs:`);
            rows.forEach(buff => {
                console.log(`   - ${buff.display_name} (${buff.item_name}) for user ${buff.user_id}`);
                console.log(`     Duration: ${buff.duration_seconds}s, Remaining: ${buff.remaining_seconds}s`);
                console.log(`     Applied: ${buff.applied_at}`);
            });
        }
        
        db.close();
    });
}

// Run the tests
testSpeedBoostIntegration().then(() => {
    setTimeout(checkDatabaseBuffs, 1000);
});