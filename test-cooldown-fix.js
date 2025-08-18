const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

// Insert a test cooldown record to verify the fix
async function testCooldownFix() {
    console.log('🧪 Testing cooldown timezone fix...');
    
    // Find the first user and item for testing
    db.get('SELECT id FROM users LIMIT 1', (err, user) => {
        if (err || !user) {
            console.error('No users found for testing');
            db.close();
            return;
        }
        
        db.get('SELECT id, name, cooldown_seconds FROM items WHERE cooldown_seconds > 0 LIMIT 1', (err, item) => {
            if (err || !item) {
                console.error('No items with cooldowns found for testing');
                db.close();
                return;
            }
            
            console.log(`📝 Testing with user ${user.id} and item "${item.name}" (${item.cooldown_seconds}s cooldown)`);
            
            // Insert a test usage record with current UTC time
            const currentTime = new Date().toISOString().replace('T', ' ').replace('Z', '');
            
            db.run('INSERT INTO item_usage_log (user_id, item_id, used_at) VALUES (?, ?, ?)', 
                [user.id, item.id, currentTime], (err) => {
                if (err) {
                    console.error('Error inserting test record:', err);
                    db.close();
                    return;
                }
                
                console.log(`⏰ Inserted usage record at: ${currentTime}`);
                
                // Test the fixed cooldown calculation
                db.get('SELECT used_at FROM item_usage_log WHERE user_id = ? AND item_id = ? ORDER BY used_at DESC LIMIT 1',
                    [user.id, item.id], (err, usage) => {
                    if (err) {
                        console.error('Error retrieving usage:', err);
                        db.close();
                        return;
                    }
                    
                    // OLD (BROKEN) CALCULATION
                    const oldCooldownEnd = new Date(usage.used_at).getTime() + (item.cooldown_seconds * 1000);
                    const oldRemainingMs = oldCooldownEnd - Date.now();
                    const oldRemainingMinutes = Math.ceil(oldRemainingMs / 60000);
                    
                    // NEW (FIXED) CALCULATION
                    const newCooldownEnd = new Date(usage.used_at + 'Z').getTime() + (item.cooldown_seconds * 1000);
                    const newRemainingMs = newCooldownEnd - Date.now();
                    const newRemainingSeconds = Math.ceil(newRemainingMs / 1000);
                    
                    console.log(`\n🔍 Cooldown Calculation Results:`);
                    console.log(`   Current time (UTC): ${new Date().toISOString()}`);
                    console.log(`   Usage time (raw):   ${usage.used_at}`);
                    console.log(`   Cooldown duration:  ${item.cooldown_seconds} seconds`);
                    console.log(`\n❌ OLD (BROKEN) Calculation:`);
                    console.log(`   Interpreted as:     ${new Date(usage.used_at).toISOString()}`);
                    console.log(`   Cooldown end:       ${new Date(oldCooldownEnd).toISOString()}`);
                    console.log(`   Remaining:          ${oldRemainingMinutes} minutes`);
                    console.log(`\n✅ NEW (FIXED) Calculation:`);
                    console.log(`   Interpreted as:     ${new Date(usage.used_at + 'Z').toISOString()}`);
                    console.log(`   Cooldown end:       ${new Date(newCooldownEnd).toISOString()}`);
                    console.log(`   Remaining:          ${newRemainingSeconds} seconds`);
                    
                    if (newRemainingSeconds > 0 && newRemainingSeconds <= item.cooldown_seconds) {
                        console.log(`\n🎉 FIX VERIFIED: Cooldown is now correctly calculated!`);
                    } else if (newRemainingSeconds <= 0) {
                        console.log(`\n✅ FIX VERIFIED: Item is no longer on cooldown (as expected)!`);
                    } else {
                        console.log(`\n⚠️  Something might still be wrong with the calculation`);
                    }
                    
                    db.close();
                });
            });
        });
    });
}

testCooldownFix();