const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

async function debugUserCooldown() {
    console.log('🔍 Debugging cooldown issue for user onestreamer (user@example.com)...\n');
    
    // First, find the user
    db.get('SELECT * FROM users WHERE email = ?', ['user@example.com'], (err, user) => {
        if (err) {
            console.error('Error finding user:', err);
            db.close();
            return;
        }
        
        if (!user) {
            console.log('❌ User not found with email user@example.com');
            db.close();
            return;
        }
        
        console.log(`✅ Found user: ${user.username} (ID: ${user.id})`);
        const userId = user.id;
        
        // Find speed boost item
        db.get('SELECT * FROM items WHERE name = ?', ['speed_boost'], (err, item) => {
            if (err) {
                console.error('Error finding item:', err);
                db.close();
                return;
            }
            
            if (!item) {
                console.log('❌ Speed boost item not found');
                db.close();
                return;
            }
            
            console.log(`🎯 Speed boost item: ID ${item.id}, Cooldown: ${item.cooldown_seconds}s`);
            const itemId = item.id;
            
            // Check current time
            const now = new Date();
            console.log(`⏰ Current time: ${now.toISOString()} (${now.toString()})`);
            
            // Check all usage logs for this user and item
            db.all(`SELECT * FROM item_usage_log 
                    WHERE user_id = ? AND item_id = ? 
                    ORDER BY used_at DESC`, [userId, itemId], (err, usageLogs) => {
                if (err) {
                    console.error('Error getting usage logs:', err);
                    db.close();
                    return;
                }
                
                console.log(`\n📋 Usage history for user ${userId} and speed_boost:`);
                if (usageLogs.length === 0) {
                    console.log('   - No usage records found');
                } else {
                    usageLogs.forEach((log, index) => {
                        console.log(`   ${index + 1}. Used at: ${log.used_at}`);
                        
                        // Calculate cooldown with both methods
                        const usedAtOld = new Date(log.used_at);
                        const usedAtFixed = new Date(log.used_at + 'Z');
                        const cooldownEndOld = new Date(usedAtOld.getTime() + (item.cooldown_seconds * 1000));
                        const cooldownEndFixed = new Date(usedAtFixed.getTime() + (item.cooldown_seconds * 1000));
                        
                        console.log(`      Old method - Used: ${usedAtOld.toISOString()}, Cooldown end: ${cooldownEndOld.toISOString()}`);
                        console.log(`      Fixed method - Used: ${usedAtFixed.toISOString()}, Cooldown end: ${cooldownEndFixed.toISOString()}`);
                        
                        const isOnCooldownOld = now < cooldownEndOld;
                        const isOnCooldownFixed = now < cooldownEndFixed;
                        
                        console.log(`      On cooldown (old): ${isOnCooldownOld}`);
                        console.log(`      On cooldown (fixed): ${isOnCooldownFixed}`);
                        
                        if (index === 0) { // Most recent usage
                            if (isOnCooldownOld && !isOnCooldownFixed) {
                                console.log(`      🐛 BUG CONFIRMED: Old method shows cooldown, fixed method doesn't`);
                            }
                        }
                    });
                }
                
                // Check inventory
                db.get(`SELECT * FROM user_inventory WHERE user_id = ? AND item_id = ?`, 
                    [userId, itemId], (err, inventory) => {
                    if (err) {
                        console.error('Error checking inventory:', err);
                        db.close();
                        return;
                    }
                    
                    console.log(`\n📦 Inventory status:`);
                    if (inventory) {
                        console.log(`   - User has ${inventory.quantity} speed boost items`);
                        console.log(`   - Last used: ${inventory.last_used_at || 'Never'}`);
                    } else {
                        console.log('   - User has no speed boost items');
                    }
                    
                    db.close();
                });
            });
        });
    });
}

debugUserCooldown();