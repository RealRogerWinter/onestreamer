const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔍 Connected to SQLite database for debugging');
    }
});

async function debugFriesCooldown() {
    return new Promise((resolve, reject) => {
        // First, find the user
        console.log('🔍 Looking for user with email user@example.com...');
        db.get('SELECT * FROM users WHERE email = ?', ['user@example.com'], (err, user) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!user) {
                console.log('❌ User not found with email user@example.com');
                reject(new Error('User not found'));
                return;
            }
            
            console.log(`✅ Found user: ${user.username} (ID: ${user.id}, Email: ${user.email})`);
            
            // Find Fries item
            console.log('\n🔍 Looking for Fries item...');
            db.get('SELECT * FROM items WHERE name LIKE "%fries%" OR display_name LIKE "%fries%" OR display_name LIKE "%Fries%"', (err, item) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                if (!item) {
                    console.log('❌ Fries item not found. Let me check all available items...');
                    db.all('SELECT id, name, display_name, emoji, cooldown_seconds FROM items ORDER BY display_name', (err, allItems) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        console.log('\n📋 All available items:');
                        allItems.forEach(item => {
                            console.log(`  ${item.id}: ${item.display_name} (${item.emoji}) - ${item.name} - Cooldown: ${item.cooldown_seconds}s`);
                        });
                        
                        // Look for anything that might be "fries"
                        const possibleFries = allItems.find(item => 
                            item.name.toLowerCase().includes('fries') || 
                            item.display_name.toLowerCase().includes('fries')
                        );
                        
                        if (possibleFries) {
                            console.log(`\n✅ Found possible Fries item: ${possibleFries.display_name} (ID: ${possibleFries.id})`);
                            checkItemUsage(user.id, possibleFries.id, possibleFries);
                        } else {
                            console.log('\n❌ No Fries-like item found');
                            resolve();
                        }
                    });
                    return;
                }
                
                console.log(`✅ Found Fries item: ${item.display_name} (ID: ${item.id}, Cooldown: ${item.cooldown_seconds}s)`);
                checkItemUsage(user.id, item.id, item);
            });
        });
        
        function checkItemUsage(userId, itemId, item) {
            console.log(`\n🔍 Checking item usage history for user ${userId} and item ${itemId}...`);
            
            // Check recent usage
            db.all(
                `SELECT * FROM item_usage_log 
                 WHERE user_id = ? AND item_id = ? 
                 ORDER BY used_at DESC LIMIT 10`,
                [userId, itemId],
                (err, usageLog) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    console.log(`📊 Found ${usageLog.length} usage entries:`);
                    
                    if (usageLog.length === 0) {
                        console.log('  ℹ️ No usage history found - item should be available');
                    } else {
                        usageLog.forEach((usage, index) => {
                            const usedAt = new Date(usage.used_at);
                            const cooldownEndTime = new Date(usedAt.getTime() + (item.cooldown_seconds * 1000));
                            const now = new Date();
                            const isStillOnCooldown = now < cooldownEndTime;
                            const remainingMs = cooldownEndTime - now;
                            const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
                            
                            console.log(`  ${index + 1}. Used at: ${usedAt.toISOString()}`);
                            console.log(`     Cooldown ends: ${cooldownEndTime.toISOString()}`);
                            console.log(`     Currently on cooldown: ${isStillOnCooldown}`);
                            if (isStillOnCooldown) {
                                console.log(`     Remaining: ${remainingSeconds} seconds`);
                            }
                            console.log('');
                        });
                        
                        // Check the most recent usage
                        const mostRecent = usageLog[0];
                        const usedAt = new Date(mostRecent.used_at);
                        const cooldownEndTime = new Date(usedAt.getTime() + (item.cooldown_seconds * 1000));
                        const now = new Date();
                        const isStillOnCooldown = now < cooldownEndTime;
                        
                        console.log(`🕒 Current time: ${now.toISOString()}`);
                        console.log(`🕒 Most recent use: ${usedAt.toISOString()}`);
                        console.log(`🕒 Cooldown should end: ${cooldownEndTime.toISOString()}`);
                        console.log(`🕒 Should be on cooldown: ${isStillOnCooldown}`);
                        
                        if (isStillOnCooldown) {
                            const remainingSeconds = Math.ceil((cooldownEndTime - now) / 1000);
                            console.log(`⏰ COOLDOWN ACTIVE: ${remainingSeconds} seconds remaining`);
                        } else {
                            console.log(`✅ COOLDOWN EXPIRED: Item should be usable`);
                        }
                    }
                    
                    // Check user's inventory
                    console.log(`\n🔍 Checking user's inventory for this item...`);
                    db.get('SELECT * FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId], (err, inventoryItem) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        if (!inventoryItem) {
                            console.log('❌ User does not have this item in inventory');
                        } else {
                            console.log(`✅ User has ${inventoryItem.quantity}x of this item in inventory`);
                            console.log(`   Last used: ${inventoryItem.last_used_at || 'Never'}`);
                        }
                        
                        resolve();
                    });
                }
            );
        }
    });
}

debugFriesCooldown().then(() => {
    console.log('\n🔍 Debug analysis complete');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Debug failed:', error.message);
    db.close();
    process.exit(1);
});