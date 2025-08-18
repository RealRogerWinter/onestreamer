const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

// Test user credentials
const testUsers = [
    { username: 'testuser1', email: 'test1@example.com', password: 'password123' },
    { username: 'testuser2', email: 'test2@example.com', password: 'password123' }
];

let userTokens = {};
let testItemId = null;

async function register(userData) {
    try {
        const response = await axios.post(`${BASE_URL}/auth/signup`, userData);
        console.log(`✅ Registered user: ${userData.username}`);
        return response.data;
    } catch (error) {
        if (error.response?.data?.error?.includes('already exists')) {
            console.log(`ℹ️ User ${userData.username} already exists`);
            return null;
        }
        throw error;
    }
}

async function login(userData) {
    try {
        const response = await axios.post(`${BASE_URL}/auth/login`, {
            email: userData.email,
            password: userData.password
        });
        console.log(`✅ Logged in user: ${userData.username}`);
        return response.data.token;
    } catch (error) {
        console.error(`❌ Failed to login ${userData.username}:`, error.response?.data || error.message);
        throw error;
    }
}

async function getItems(token) {
    try {
        const response = await axios.get(`${BASE_URL}/api/items`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data;
    } catch (error) {
        console.error('❌ Failed to get items:', error.response?.data || error.message);
        throw error;
    }
}

async function giveUserPoints(userId, points = 10000) {
    // Since we can't easily give points via API without admin access, 
    // let's simulate by using a direct database approach or skip this for now
    console.log(`ℹ️ Note: Would give ${points} points to user ${userId} (skipped for test)`);
}

async function purchaseItem(token, itemId, quantity = 1) {
    try {
        const response = await axios.post(`${BASE_URL}/api/shop/purchase`, {
            itemId,
            quantity
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`✅ Purchased ${quantity}x item ${itemId}`);
        return response.data;
    } catch (error) {
        console.error(`❌ Failed to purchase item:`, error.response?.data || error.message);
        // If purchase fails due to insufficient funds, that's okay for our test
        if (error.response?.data?.error?.includes('Insufficient points')) {
            console.log(`ℹ️ User doesn't have enough points to purchase item, continuing with existing inventory...`);
            return { success: false, reason: 'insufficient_points' };
        }
        throw error;
    }
}

async function useItem(token, itemId, username) {
    try {
        const response = await axios.post(`${BASE_URL}/api/inventory/use/${itemId}`, {}, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`✅ ${username} successfully used item ${itemId}`);
        return response.data;
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.log(`❌ ${username} failed to use item ${itemId}: ${errorMsg}`);
        return { error: errorMsg };
    }
}

async function getCooldowns(token, username) {
    try {
        const response = await axios.get(`${BASE_URL}/api/inventory/cooldowns`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`📊 ${username} cooldowns:`, response.data.length > 0 ? response.data : 'None');
        return response.data;
    } catch (error) {
        console.error(`❌ Failed to get ${username} cooldowns:`, error.response?.data || error.message);
        throw error;
    }
}

async function getUserInfo(token) {
    try {
        const response = await axios.get(`${BASE_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data.user; // Return just the user object
    } catch (error) {
        console.error('❌ Failed to get user info:', error.response?.data || error.message);
        throw error;
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testItemCooldownBehavior() {
    console.log('🧪 Testing Item Cooldown Behavior - Per-User vs Global\n');
    
    try {
        // 1. Register and login test users
        console.log('📝 Step 1: Setting up test users...');
        for (const userData of testUsers) {
            await register(userData);
            const token = await login(userData);
            userTokens[userData.username] = token;
        }
        
        // Get user IDs
        const user1Info = await getUserInfo(userTokens.testuser1);
        const user2Info = await getUserInfo(userTokens.testuser2);
        
        console.log(`ℹ️ User1 ID: ${user1Info.id}, User2 ID: ${user2Info.id}\n`);
        
        // 2. Get available items and find one with cooldown
        console.log('📝 Step 2: Finding item with cooldown...');
        const items = await getItems(userTokens.testuser1);
        const itemWithCooldown = items.find(item => item.cooldown_seconds > 0);
        
        if (!itemWithCooldown) {
            throw new Error('No items with cooldown found');
        }
        
        testItemId = itemWithCooldown.id;
        console.log(`🎯 Testing with item: ${itemWithCooldown.display_name} (${itemWithCooldown.emoji}) - Cooldown: ${itemWithCooldown.cooldown_seconds}s\n`);
        
        // 3. Try to purchase the item for both users (or use existing inventory)
        console.log('📝 Step 3: Trying to get item for both users...');
        await purchaseItem(userTokens.testuser1, testItemId, 1);
        await purchaseItem(userTokens.testuser2, testItemId, 1);
        
        console.log('');
        
        // 4. Test cooldown behavior
        console.log('📝 Step 4: Testing cooldown behavior...\n');
        
        // User1 uses the item first
        console.log('🔥 User1 uses the item:');
        await useItem(userTokens.testuser1, testItemId, 'testuser1');
        
        // Check cooldowns for both users
        console.log('\n📊 Checking cooldowns after User1 used the item:');
        await getCooldowns(userTokens.testuser1, 'testuser1');
        await getCooldowns(userTokens.testuser2, 'testuser2');
        
        console.log('\n⏰ Immediately testing User2 usage (should succeed if cooldowns are per-user):');
        const user2Result = await useItem(userTokens.testuser2, testItemId, 'testuser2');
        
        if (user2Result.error) {
            console.log('❌ FAIL: User2 cannot use item even though only User1 used it - cooldowns appear to be GLOBAL');
            return false;
        } else {
            console.log('✅ PASS: User2 can use item even though User1 just used it - cooldowns are PER-USER');
        }
        
        console.log('\n⏰ Testing User1 immediate reuse (should fail due to cooldown):');
        const user1ReUseResult = await useItem(userTokens.testuser1, testItemId, 'testuser1');
        
        if (user1ReUseResult.error && user1ReUseResult.error.includes('cooldown')) {
            console.log('✅ PASS: User1 cannot immediately reuse item due to personal cooldown');
        } else {
            console.log('❌ FAIL: User1 was able to immediately reuse item');
            return false;
        }
        
        console.log('\n📊 Final cooldown check:');
        await getCooldowns(userTokens.testuser1, 'testuser1');
        await getCooldowns(userTokens.testuser2, 'testuser2');
        
        console.log('\n🎉 CONCLUSION: Item cooldowns are working correctly - they are PER-USER, not global!');
        return true;
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        return false;
    }
}

// Run the test
testItemCooldownBehavior().then(success => {
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