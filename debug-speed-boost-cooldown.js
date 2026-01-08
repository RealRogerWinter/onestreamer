const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔍 Connected to SQLite database for Speed Boost debugging');
    }
});

async function debugSpeedBoostCooldown() {
    return new Promise((resolve, reject) => {
        // Find the Speed Boost item
        console.log('🔍 Looking for Speed Boost item...');
        db.get('SELECT * FROM items WHERE name = ? OR display_name LIKE ?', ['speed_boost', '%Speed Boost%'], (err, item) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!item) {
                console.log('❌ Speed Boost item not found');
                reject(new Error('Speed Boost item not found'));
                return;
            }
            
            console.log(`✅ Found Speed Boost item: ${item.display_name} (ID: ${item.id}, Cooldown: ${item.cooldown_seconds}s)`);
            
            // Check usage history for user 3 (onestreamer)
            console.log(`\n🔍 Checking Speed Boost usage history for user 3 (onestreamer)...`);
            
            db.all(
                `SELECT * FROM item_usage_log 
                 WHERE user_id = 3 AND item_id = ? 
                 ORDER BY used_at DESC LIMIT 10`,
                [item.id],
                (err, usageLog) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    console.log(`📊 Found ${usageLog.length} usage entries:`);
                    
                    if (usageLog.length === 0) {
                        console.log('  ℹ️ No usage history found - item should be available');
                    } else {
                        const now = new Date();
                        console.log(`🕒 Current time: ${now.toISOString()}`);
                        console.log('');
                        
                        usageLog.forEach((usage, index) => {
                            const usedAt = new Date(usage.used_at);
                            const cooldownEndTime = new Date(usedAt.getTime() + (item.cooldown_seconds * 1000));
                            const isStillOnCooldown = now < cooldownEndTime;
                            const remainingMs = cooldownEndTime - now;
                            const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
                            
                            console.log(`  ${index + 1}. ID: ${usage.id}`);
                            console.log(`     Used at: ${usedAt.toISOString()}`);
                            console.log(`     Cooldown ends: ${cooldownEndTime.toISOString()}`);
                            console.log(`     Currently on cooldown: ${isStillOnCooldown}`);
                            if (isStillOnCooldown) {
                                console.log(`     Remaining: ${remainingSeconds} seconds`);
                            }
                            
                            // Check if this is a future timestamp (the problem we had with fries)
                            if (usedAt > now) {
                                console.log(`     ⚠️ PROBLEM: This timestamp is in the FUTURE!`);
                            }
                            console.log('');
                        });
                        
                        // Summary of the most recent entry
                        const mostRecent = usageLog[0];
                        const usedAt = new Date(mostRecent.used_at);
                        const cooldownEndTime = new Date(usedAt.getTime() + (item.cooldown_seconds * 1000));
                        const isStillOnCooldown = now < cooldownEndTime;
                        
                        if (isStillOnCooldown) {
                            const remainingSeconds = Math.ceil((cooldownEndTime - now) / 1000);
                            console.log(`⏰ COOLDOWN ACTIVE: ${remainingSeconds} seconds remaining`);
                            if (usedAt > now) {
                                console.log(`❌ ROOT CAUSE: Usage timestamp is in the future!`);
                            }
                        } else {
                            console.log(`✅ COOLDOWN EXPIRED: Item should be usable`);
                        }
                    }
                    
                    // Check user's inventory for Speed Boost
                    console.log(`\n🔍 Checking user's inventory for Speed Boost...`);
                    db.get('SELECT * FROM user_inventory WHERE user_id = 3 AND item_id = ?', [item.id], (err, inventoryItem) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        if (!inventoryItem) {
                            console.log('❌ User does not have Speed Boost in inventory');
                        } else {
                            console.log(`✅ User has ${inventoryItem.quantity}x Speed Boost in inventory`);
                            console.log(`   Last used: ${inventoryItem.last_used_at || 'Never'}`);
                        }
                        
                        resolve({ item, usageLog, inventoryItem });
                    });
                }
            );
        });
    });
}

debugSpeedBoostCooldown().then((result) => {
    console.log('\n🔍 Speed Boost debug analysis complete');
    db.close();
    
    if (result.usageLog && result.usageLog.length > 0) {
        const now = new Date();
        const hasFutureTimestamps = result.usageLog.some(entry => new Date(entry.used_at) > now);
        
        if (hasFutureTimestamps) {
            console.log('\n❌ CONFIRMED: Speed Boost has the same future timestamp issue as Fries');
            console.log('🔧 Run the fix script to clean up these entries');
            process.exit(1);
        } else {
            console.log('\n✅ No future timestamp issues found');
            process.exit(0);
        }
    } else {
        console.log('\n✅ No usage history found - item should work fine');
        process.exit(0);
    }
}).catch(error => {
    console.error('❌ Debug failed:', error.message);
    db.close();
    process.exit(1);
});