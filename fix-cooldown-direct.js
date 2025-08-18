const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔧 Connected to SQLite database for direct fix');
    }
});

async function fixCooldownDirect() {
    return new Promise((resolve, reject) => {
        console.log('🔧 Directly removing problematic cooldown entries for user 3 (onestreamer) and fries item (ID: 11)...');
        
        // First show what we're about to delete
        db.all(
            `SELECT * FROM item_usage_log WHERE user_id = 3 AND item_id = 11 ORDER BY used_at DESC`,
            (err, entries) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                console.log(`📊 Current entries to be removed: ${entries.length}`);
                entries.forEach((entry, index) => {
                    console.log(`  ${index + 1}. ID: ${entry.id}, Used at: ${entry.used_at}`);
                });
                
                // Delete all entries for this user and item
                db.run(
                    `DELETE FROM item_usage_log WHERE user_id = 3 AND item_id = 11`,
                    function(err) {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        console.log(`✅ Deleted ${this.changes} entries`);
                        
                        // Verify deletion
                        db.all(
                            `SELECT * FROM item_usage_log WHERE user_id = 3 AND item_id = 11`,
                            (err, remainingEntries) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                
                                console.log(`✅ Remaining entries: ${remainingEntries.length}`);
                                
                                if (remainingEntries.length === 0) {
                                    console.log('🎉 All problematic cooldown entries removed!');
                                    console.log('✅ The fries item should now be usable immediately');
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

fixCooldownDirect().then(() => {
    console.log('\n🎉 Direct cooldown fix completed!');
    console.log('✅ User onestreamer should now be able to use the fries item');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Fix failed:', error.message);
    db.close();
    process.exit(1);
});