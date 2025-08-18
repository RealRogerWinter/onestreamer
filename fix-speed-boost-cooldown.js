const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔧 Connected to SQLite database for Speed Boost cooldown fix');
    }
});

async function fixSpeedBoostCooldown() {
    return new Promise((resolve, reject) => {
        console.log('🔧 Fixing Speed Boost cooldown entries for user 3 (onestreamer)...');
        
        // First show what we're about to delete
        db.all(
            `SELECT * FROM item_usage_log WHERE user_id = 3 AND item_id = 1 ORDER BY used_at DESC`,
            (err, entries) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                console.log(`📊 Current Speed Boost entries to be removed: ${entries.length}`);
                entries.forEach((entry, index) => {
                    const usedAt = new Date(entry.used_at);
                    const now = new Date();
                    const isFuture = usedAt > now;
                    console.log(`  ${index + 1}. ID: ${entry.id}, Used at: ${entry.used_at} ${isFuture ? '(🚨 FUTURE)' : '(✅ OK)'}`);
                });
                
                // Delete all entries for user 3 and Speed Boost item (ID: 1)
                db.run(
                    `DELETE FROM item_usage_log WHERE user_id = 3 AND item_id = 1`,
                    function(err) {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        console.log(`✅ Deleted ${this.changes} Speed Boost cooldown entries`);
                        
                        // Verify deletion
                        db.all(
                            `SELECT * FROM item_usage_log WHERE user_id = 3 AND item_id = 1`,
                            (err, remainingEntries) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                
                                console.log(`✅ Remaining Speed Boost entries: ${remainingEntries.length}`);
                                
                                if (remainingEntries.length === 0) {
                                    console.log('🎉 All problematic Speed Boost cooldown entries removed!');
                                    console.log('✅ Speed Boost should now be usable immediately');
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

fixSpeedBoostCooldown().then(() => {
    console.log('\n🎉 Speed Boost cooldown fix completed!');
    console.log('✅ User onestreamer should now be able to use Speed Boost without cooldown errors');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Fix failed:', error.message);
    db.close();
    process.exit(1);
});