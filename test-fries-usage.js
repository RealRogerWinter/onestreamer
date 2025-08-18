const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testFriesUsage() {
    console.log('🧪 Testing Fries Item Usage for onestreamer user\n');
    
    try {
        // Login as the onestreamer user
        console.log('📝 Logging in as onestreamer...');
        const loginResponse = await axios.post(`${BASE_URL}/auth/login`, {
            email: 'user@example.com',
            password: '***REMOVED-ADMIN-KEY***er'
        });
        
        const token = loginResponse.data.token;
        console.log('✅ Successfully logged in');
        
        // Get user info
        const userInfo = await axios.get(`${BASE_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`✅ User: ${userInfo.data.user.username} (ID: ${userInfo.data.user.id})`);
        
        // Get items to find fries
        const itemsResponse = await axios.get(`${BASE_URL}/api/items`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const friesItem = itemsResponse.data.find(item => item.name === 'fries' || item.display_name.toLowerCase().includes('fries'));
        if (!friesItem) {
            console.log('❌ Fries item not found');
            return false;
        }
        
        console.log(`🎯 Found fries item: ${friesItem.display_name} (ID: ${friesItem.id}, Cooldown: ${friesItem.cooldown_seconds}s)`);
        
        // Check current inventory
        const inventoryResponse = await axios.get(`${BASE_URL}/api/inventory`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const friesInInventory = inventoryResponse.data.find(item => item.item_id === friesItem.id);
        if (!friesInInventory) {
            console.log('❌ Fries not found in inventory');
            return false;
        }
        
        console.log(`📦 Fries in inventory: ${friesInInventory.quantity}x`);
        
        // Check current cooldowns
        const cooldownsResponse = await axios.get(`${BASE_URL}/api/inventory/cooldowns`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log(`📊 Current cooldowns: ${cooldownsResponse.data.length} items`);
        const friesCooldown = cooldownsResponse.data.find(cd => cd.itemId === friesItem.id);
        if (friesCooldown) {
            console.log(`⏰ Fries cooldown remaining: ${friesCooldown.cooldownRemaining} seconds`);
        } else {
            console.log('✅ No cooldown found for fries - should be usable');
        }
        
        // Try to use the fries item
        console.log('\n🔥 Attempting to use fries item...');
        try {
            const useResponse = await axios.post(`${BASE_URL}/api/inventory/use/${friesItem.id}`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            console.log('🎉 SUCCESS: Fries item used successfully!');
            console.log('✅ No cooldown error encountered');
            
            // Check cooldowns after use
            const newCooldownsResponse = await axios.get(`${BASE_URL}/api/inventory/cooldowns`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            const newFriesCooldown = newCooldownsResponse.data.find(cd => cd.itemId === friesItem.id);
            if (newFriesCooldown) {
                console.log(`📊 New cooldown: ${newFriesCooldown.cooldownRemaining} seconds (should be 0 since fries has 0s cooldown)`);
            } else {
                console.log('✅ No cooldown applied (correct for 0s cooldown item)');
            }
            
            return true;
            
        } catch (error) {
            const errorMsg = error.response?.data?.error || error.message;
            console.log(`❌ FAILED to use fries: ${errorMsg}`);
            
            if (errorMsg.includes('cooldown')) {
                console.log('❌ Still getting cooldown error - issue persists');
                return false;
            }
            
            throw error;
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
testFriesUsage().then(success => {
    if (success) {
        console.log('\n🎉 Fries usage test PASSED - cooldown issue is FIXED!');
        process.exit(0);
    } else {
        console.log('\n❌ Fries usage test FAILED - cooldown issue still exists');
        process.exit(1);
    }
}).catch(error => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
});