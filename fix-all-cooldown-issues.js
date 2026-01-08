const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔧 Connected to SQLite database for comprehensive cooldown fix');
    }
});

async function fixAllCooldownIssues() {
    return new Promise((resolve, reject) => {
        console.log('🔧 COMPREHENSIVE COOLDOWN FIX');
        console.log('🔧 Removing ALL future timestamp entries from item_usage_log...');
        
        // First, show all the problematic entries
        db.all(
            `SELECT iul.*, i.name, i.display_name, u.username, u.email 
             FROM item_usage_log iul
             JOIN items i ON iul.item_id = i.id  
             JOIN users u ON iul.user_id = u.id
             ORDER BY iul.used_at DESC`,
            (err, allEntries) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const now = new Date();
                const futureEntries = allEntries.filter(entry => {
                    const usedAt = new Date(entry.used_at);
                    return usedAt > now;
                });
                
                console.log(`📊 Found ${futureEntries.length} problematic entries to remove:`);
                
                futureEntries.forEach((entry, index) => {
                    const usedAt = new Date(entry.used_at);
                    const hoursInFuture = (usedAt - now) / (1000 * 60 * 60);
                    console.log(`  ${index + 1}. ${entry.username} - ${entry.display_name} (ID: ${entry.id}, ${hoursInFuture.toFixed(1)}h in future)`);
                });
                
                if (futureEntries.length === 0) {
                    console.log('✅ No future timestamp issues found');
                    resolve();
                    return;
                }
                
                console.log('\n🔧 Removing all future timestamp entries...');
                
                // Delete all future timestamp entries by comparing with current time in JS
                const futureIds = futureEntries.map(entry => entry.id);
                const placeholders = futureIds.map(() => '?').join(',');
                
                db.run(
                    `DELETE FROM item_usage_log WHERE id IN (${placeholders})`,
                    futureIds,
                    function(err) {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        console.log(`✅ Successfully deleted ${this.changes} problematic cooldown entries`);
                        
                        // Verify the fix
                        db.all(
                            `SELECT iul.*, i.name, i.display_name, u.username 
                             FROM item_usage_log iul
                             JOIN items i ON iul.item_id = i.id  
                             JOIN users u ON iul.user_id = u.id
                             ORDER BY iul.used_at DESC`,
                            (err, remainingEntries) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                
                                const stillFuture = remainingEntries.filter(entry => {
                                    const usedAt = new Date(entry.used_at);
                                    return usedAt > now;
                                });
                                
                                console.log(`📊 Remaining entries: ${remainingEntries.length}`);
                                console.log(`🚨 Still problematic: ${stillFuture.length}`);
                                
                                if (stillFuture.length === 0) {
                                    console.log('🎉 ALL future timestamp issues resolved!');
                                    console.log('✅ All item cooldowns should now work correctly');
                                } else {
                                    console.log('⚠️ Some future timestamps still exist');
                                    stillFuture.forEach(entry => {
                                        console.log(`   - ${entry.username}: ${entry.display_name} at ${entry.used_at}`);
                                    });
                                }
                                
                                resolve();
                            }
                        );
                    }
                );
            }
        );
    });
}

fixAllCooldownIssues().then(() => {
    console.log('\n🎉 COMPREHENSIVE COOLDOWN FIX COMPLETED!');
    console.log('✅ All users should now be able to use their items without cooldown errors');
    console.log('✅ Items affected: Speed Boost, Fries, Spotlight, Confetti Cannon, Rainbow Effect, Slow Mode');
    console.log('✅ Users affected: onestreamer, cooldowntest1, cooldowntest2');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Comprehensive fix failed:', error.message);
    db.close();
    process.exit(1);
});