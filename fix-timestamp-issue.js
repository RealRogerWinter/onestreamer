const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔧 Connected to SQLite database for timestamp fix');
    }
});

async function fixTimestampIssue() {
    return new Promise((resolve, reject) => {
        const now = new Date();
        console.log(`🕒 Current time: ${now.toISOString()}`);
        
        // First, let's check all usage entries that are in the future
        console.log('\n🔍 Finding all item usage entries with future timestamps...');
        db.all(
            `SELECT * FROM item_usage_log WHERE used_at > datetime('now')`,
            (err, futureEntries) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                console.log(`📊 Found ${futureEntries.length} entries with future timestamps:`);
                
                if (futureEntries.length === 0) {
                    console.log('✅ No future timestamps found');
                    resolve();
                    return;
                }
                
                futureEntries.forEach((entry, index) => {
                    const usedAt = new Date(entry.used_at);
                    console.log(`  ${index + 1}. User ${entry.user_id}, Item ${entry.item_id}: ${usedAt.toISOString()}`);
                });
                
                console.log('\n🔧 Options to fix this:');
                console.log('1. Delete all future timestamp entries (recommended for testing)');
                console.log('2. Adjust timestamps to current time minus reasonable intervals');
                
                // For now, let's delete the problematic entries for the specific user and item
                console.log('\n🔧 Deleting future timestamp entries for user 3 (onestreamer) and fries item...');
                
                db.run(
                    `DELETE FROM item_usage_log 
                     WHERE user_id = 3 AND item_id = 11 AND used_at > datetime('now')`,
                    function(err) {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        console.log(`✅ Deleted ${this.changes} problematic entries for fries item`);
                        
                        // Verify the fix
                        db.all(
                            `SELECT * FROM item_usage_log 
                             WHERE user_id = 3 AND item_id = 11 
                             ORDER BY used_at DESC`,
                            (err, remainingEntries) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                
                                console.log(`\n✅ Remaining entries for user 3, fries item: ${remainingEntries.length}`);
                                remainingEntries.forEach((entry, index) => {
                                    const usedAt = new Date(entry.used_at);
                                    const isInFuture = usedAt > now;
                                    console.log(`  ${index + 1}. ${usedAt.toISOString()} ${isInFuture ? '(⚠️ STILL FUTURE)' : '(✅ OK)'}`);
                                });
                                
                                resolve();
                            }
                        );
                    }
                );
            }
        );
    });
}

fixTimestampIssue().then(() => {
    console.log('\n🎉 Timestamp fix completed!');
    console.log('✅ The fries item should now be usable for the onestreamer user');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Fix failed:', error.message);
    db.close();
    process.exit(1);
});