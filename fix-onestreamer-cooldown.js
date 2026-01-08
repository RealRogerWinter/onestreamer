const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

async function fixOnestreamanCooldown() {
    console.log('🔧 Fixing cooldown issue for user onestreamer...');
    
    // First, find the user
    db.get('SELECT * FROM users WHERE email = ?', ['user@example.com'], (err, user) => {
        if (err) {
            console.error('Error finding user:', err);
            db.close();
            return;
        }
        
        if (!user) {
            console.log('❌ User not found');
            db.close();
            return;
        }
        
        console.log(`✅ Found user: ${user.username} (ID: ${user.id})`);
        
        // Get speed boost item ID
        db.get('SELECT id FROM items WHERE name = ?', ['speed_boost'], (err, item) => {
            if (err) {
                console.error('Error finding item:', err);
                db.close();
                return;
            }
            
            console.log(`🎯 Speed boost item ID: ${item.id}`);
            
            // Clear the user's speed boost cooldown records
            db.run('DELETE FROM item_usage_log WHERE user_id = ? AND item_id = ?', 
                [user.id, item.id], function(err) {
                if (err) {
                    console.error('Error clearing cooldown:', err);
                    db.close();
                    return;
                }
                
                console.log(`✅ Cleared ${this.changes} cooldown records for speed boost`);
                
                // Also update the last_used_at in inventory to NULL
                db.run('UPDATE user_inventory SET last_used_at = NULL WHERE user_id = ? AND item_id = ?',
                    [user.id, item.id], function(err) {
                    if (err) {
                        console.error('Error updating inventory:', err);
                    } else {
                        console.log('✅ Reset last_used_at in inventory');
                    }
                    
                    console.log('\n🎉 Fixed! User onestreamer should now be able to use speed boost items.');
                    console.log('💡 The server needs to be restarted to use the updated timezone fix.');
                    
                    db.close();
                });
            });
        });
    });
}

fixOnestreamanCooldown();