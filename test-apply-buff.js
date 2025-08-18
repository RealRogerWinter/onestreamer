const axios = require('axios');

async function testApplyBuff() {
    console.log('🧪 Testing Buff Application...\n');

    const baseURL = 'http://localhost:8080';
    let authToken = null;
    
    try {
        // Step 1: Register and login to get auth token
        console.log('Step 1: Creating test account...');
        try {
            // Try to register first
            try {
                await axios.post(`${baseURL}/auth/register`, {
                    username: 'testuser',
                    email: 'test@example.com',
                    password: 'password123'
                });
                console.log('✅ Test account created');
            } catch (regError) {
                console.log('⚠️  Account might already exist, continuing with login...');
            }
            
            // Now try to login
            const loginResponse = await axios.post(`${baseURL}/auth/login`, {
                email: 'test@example.com',
                password: 'password123'
            });
            
            authToken = loginResponse.data.token;
            console.log('✅ Login successful, got auth token');
            
        } catch (error) {
            console.log('❌ Login failed:', error.response?.data || error.message);
            console.log('   Trying with existing account credentials...');
            
            // Try with a different common account
            try {
                const altLogin = await axios.post(`${baseURL}/auth/login`, {
                    email: 'admin@example.com',
                    password: 'REDACTED-ADMIN-KEY'
                });
                authToken = altLogin.data.token;
                console.log('✅ Login successful with admin account');
            } catch (altError) {
                console.log('❌ All login attempts failed');
                return;
            }
        }

        // Step 2: Get user's current inventory
        console.log('\nStep 2: Checking inventory...');
        try {
            const inventoryResponse = await axios.get(`${baseURL}/api/inventory`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            console.log('✅ Inventory retrieved:', inventoryResponse.data.inventory.length, 'items');
            
            // Look for buff/debuff items
            const buffItems = inventoryResponse.data.inventory.filter(item => 
                ['buff', 'debuff'].includes(item.item_type)
            );
            console.log('   Buff/Debuff items:', buffItems.length);
            
            if (buffItems.length === 0) {
                console.log('⚠️  No buff items in inventory, trying to purchase one...');
                
                // Get available items from shop
                const shopResponse = await axios.get(`${baseURL}/api/shop/items`, {
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });
                
                const buffItemInShop = shopResponse.data.items.find(item => 
                    item.item_type === 'buff' || item.item_type === 'debuff'
                );
                
                if (buffItemInShop) {
                    console.log(`   Found ${buffItemInShop.display_name} in shop, purchasing...`);
                    await axios.post(`${baseURL}/api/shop/purchase`, {
                        itemId: buffItemInShop.id,
                        quantity: 1
                    }, {
                        headers: { 'Authorization': `Bearer ${authToken}` }
                    });
                    console.log('✅ Purchased buff item');
                } else {
                    console.log('❌ No buff items available in shop');
                    return;
                }
            }
            
        } catch (error) {
            console.log('❌ Inventory check failed:', error.response?.data || error.message);
            return;
        }

        // Step 3: Get updated inventory with buff items
        console.log('\nStep 3: Getting updated inventory...');
        const updatedInventory = await axios.get(`${baseURL}/api/inventory`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const buffItems = updatedInventory.data.inventory.filter(item => 
            ['buff', 'debuff'].includes(item.item_type) && item.quantity > 0
        );
        
        if (buffItems.length === 0) {
            console.log('❌ Still no buff items available');
            return;
        }
        
        const testItem = buffItems[0];
        console.log(`✅ Using ${testItem.display_name} for test`);

        // Step 4: Apply buff to self (we need to know our user ID)
        console.log('\nStep 4: Getting user profile...');
        const profileResponse = await axios.get(`${baseURL}/api/profile`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const userId = profileResponse.data.user.id;
        console.log(`✅ Got user ID: ${userId}`);

        // Step 5: Apply the buff
        console.log(`\nStep 5: Applying ${testItem.display_name} to user ${userId}...`);
        try {
            const applyResponse = await axios.post(`${baseURL}/api/buffs/apply`, {
                targetUserId: userId,
                itemId: testItem.item_id
            }, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            
            console.log('✅ Buff applied successfully!');
            console.log('   Buff details:', {
                id: applyResponse.data.buff.id,
                displayName: applyResponse.data.buff.displayName,
                remainingSeconds: applyResponse.data.buff.remainingSeconds,
                buffType: applyResponse.data.buff.buffType
            });
            
        } catch (error) {
            console.log('❌ Buff application failed:', error.response?.data || error.message);
            return;
        }

        // Step 6: Verify buff is active
        console.log('\nStep 6: Verifying buff is active...');
        try {
            const activeBuffsResponse = await axios.get(`${baseURL}/api/buffs/user/${userId}`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            
            console.log(`✅ Active buffs retrieved: ${activeBuffsResponse.data.count} buffs`);
            activeBuffsResponse.data.buffs.forEach(buff => {
                console.log(`   - ${buff.displayName} ${buff.emoji}: ${buff.remainingSeconds}s remaining`);
            });
            
        } catch (error) {
            console.log('❌ Failed to verify active buffs:', error.response?.data || error.message);
        }

        console.log('\n🎯 Buff Application Test Complete!');
        console.log('✅ Successfully applied a buff to a user');
        console.log('📋 Next steps:');
        console.log('   1. Check the UI to see if the buff appears in real-time');
        console.log('   2. Start streaming to test duration countdown');
        console.log('   3. Try applying buffs between different users');

    } catch (error) {
        console.log('❌ Test failed with error:', error.message);
    }
}

testApplyBuff();