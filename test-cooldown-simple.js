const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

// Create a simple admin user for testing
async function testCooldownLogic() {
    console.log('🧪 Simple Cooldown Test\n');
    
    try {
        // First let's just test if we can directly call the cooldown validation logic
        // by creating two test users and testing with the confetti cannon (30s cooldown)
        
        const testUsers = [
            { username: 'cooldowntest1', email: 'cooldowntest1@example.com', password: 'password123' },
            { username: 'cooldowntest2', email: 'cooldowntest2@example.com', password: 'password123' }
        ];
        
        const userTokens = {};
        
        // 1. Register users
        for (const userData of testUsers) {
            try {
                await axios.post(`${BASE_URL}/auth/signup`, userData);
                console.log(`✅ Registered user: ${userData.username}`);
            } catch (error) {
                console.log(`ℹ️ User ${userData.username} already exists`);
            }
            
            const loginResponse = await axios.post(`${BASE_URL}/auth/login`, {
                email: userData.email,
                password: userData.password
            });
            userTokens[userData.username] = loginResponse.data.token;
            console.log(`✅ Logged in user: ${userData.username}`);
        }
        
        // 2. Get available items
        const itemsResponse = await axios.get(`${BASE_URL}/api/items`, {
            headers: { Authorization: `Bearer ${userTokens.cooldowntest1}` }
        });
        
        // Find the confetti cannon (should have 30s cooldown)
        const confettiCannon = itemsResponse.data.find(item => item.name === 'confetti_cannon');
        if (!confettiCannon) {
            console.log('❌ Confetti cannon not found in items');
            return false;
        }
        
        console.log(`🎯 Testing with: ${confettiCannon.display_name} (${confettiCannon.emoji}) - Cooldown: ${confettiCannon.cooldown_seconds}s`);
        
        // 3. Check user inventories first
        const user1Inventory = await axios.get(`${BASE_URL}/api/inventory`, {
            headers: { Authorization: `Bearer ${userTokens.cooldowntest1}` }
        });
        
        const user2Inventory = await axios.get(`${BASE_URL}/api/inventory`, {
            headers: { Authorization: `Bearer ${userTokens.cooldowntest2}` }
        });
        
        console.log(`📦 User1 inventory items: ${user1Inventory.data.length}`);
        console.log(`📦 User2 inventory items: ${user2Inventory.data.length}`);
        
        // Check if users have the confetti cannon
        const user1HasItem = user1Inventory.data.some(item => item.item_id === confettiCannon.id);
        const user2HasItem = user2Inventory.data.some(item => item.item_id === confettiCannon.id);
        
        console.log(`📦 User1 has confetti cannon: ${user1HasItem}`);
        console.log(`📦 User2 has confetti cannon: ${user2HasItem}`);
        
        if (!user1HasItem || !user2HasItem) {
            console.log('❌ Users don\'t have the required item in inventory');
            console.log('ℹ️ This test requires users to have the confetti cannon item');
            console.log('ℹ️ You may need to purchase it from the shop or have admin grant it');
            return false;
        }
        
        // 4. Now test the cooldown behavior!
        console.log('\n🔥 Testing cooldown behavior:');
        
        // User1 uses the item first
        console.log('\n📝 Step 1: User1 uses confetti cannon');
        const user1FirstUse = await axios.post(`${BASE_URL}/api/inventory/use/${confettiCannon.id}`, {}, {
            headers: { Authorization: `Bearer ${userTokens.cooldowntest1}` }
        });
        console.log('✅ User1 used confetti cannon successfully');
        
        // Immediately try User2 - should work if cooldowns are per-user
        console.log('\n📝 Step 2: User2 immediately uses confetti cannon (should work if per-user)');
        try {
            const user2Use = await axios.post(`${BASE_URL}/api/inventory/use/${confettiCannon.id}`, {}, {
                headers: { Authorization: `Bearer ${userTokens.cooldowntest2}` }
            });
            console.log('✅ PASS: User2 can use item even though User1 just used it - cooldowns are PER-USER');
        } catch (error) {
            if (error.response?.data?.error?.includes('cooldown')) {
                console.log('❌ FAIL: User2 cannot use item because of User1\'s cooldown - cooldowns appear to be GLOBAL');
                return false;
            } else {
                console.log(`❌ User2 failed for different reason: ${error.response?.data?.error || error.message}`);
                return false;
            }
        }
        
        // Try User1 again - should fail due to personal cooldown
        console.log('\n📝 Step 3: User1 tries to use again immediately (should fail due to personal cooldown)');
        try {
            await axios.post(`${BASE_URL}/api/inventory/use/${confettiCannon.id}`, {}, {
                headers: { Authorization: `Bearer ${userTokens.cooldowntest1}` }
            });
            console.log('❌ FAIL: User1 was able to reuse item immediately');
            return false;
        } catch (error) {
            if (error.response?.data?.error?.includes('cooldown')) {
                console.log('✅ PASS: User1 cannot immediately reuse item due to personal cooldown');
            } else {
                console.log(`❌ User1 failed for different reason: ${error.response?.data?.error || error.message}`);
                return false;
            }
        }
        
        // Check cooldowns for both users
        console.log('\n📊 Checking individual cooldowns:');
        const user1Cooldowns = await axios.get(`${BASE_URL}/api/inventory/cooldowns`, {
            headers: { Authorization: `Bearer ${userTokens.cooldowntest1}` }
        });
        
        const user2Cooldowns = await axios.get(`${BASE_URL}/api/inventory/cooldowns`, {
            headers: { Authorization: `Bearer ${userTokens.cooldowntest2}` }
        });
        
        console.log(`📊 User1 cooldowns: ${user1Cooldowns.data.length} items`);
        console.log(`📊 User2 cooldowns: ${user2Cooldowns.data.length} items`);
        
        const user1HasCooldown = user1Cooldowns.data.some(cd => cd.itemId === confettiCannon.id);
        const user2HasCooldown = user2Cooldowns.data.some(cd => cd.itemId === confettiCannon.id);
        
        console.log(`📊 User1 has confetti cannon on cooldown: ${user1HasCooldown}`);
        console.log(`📊 User2 has confetti cannon on cooldown: ${user2HasCooldown}`);
        
        if (user1HasCooldown && user2HasCooldown) {
            console.log('\n🎉 EXCELLENT: Both users have individual cooldowns for the same item!');
            console.log('🎉 CONCLUSION: Item cooldowns are working correctly - they are PER-USER, not global!');
            return true;
        } else {
            console.log('\n❌ Unexpected cooldown state');
            return false;
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response?.data) {
            console.error('Error details:', error.response.data);
        }
        return false;
    }
}

// Run the test
testCooldownLogic().then(success => {
    if (success) {
        console.log('\n✅ All cooldown tests PASSED');
        process.exit(0);
    } else {
        console.log('\n❌ Cooldown tests FAILED');
        process.exit(1);
    }
}).catch(error => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
});