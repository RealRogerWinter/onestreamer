const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('📋 Checking available users and inventory...\n');

db.all('SELECT id, username, email FROM users ORDER BY id', (err, users) => {
    if (err) {
        console.error('Error:', err);
        db.close();
        return;
    }
    
    console.log('👥 Available users:');
    users.forEach(user => {
        console.log(`   - ID: ${user.id}, Username: ${user.username}, Email: ${user.email}`);
    });
    
    // Check if users have speed_boost items
    db.all(`SELECT ui.user_id, ui.quantity, i.name, i.display_name 
             FROM user_inventory ui 
             JOIN items i ON ui.item_id = i.id 
             WHERE i.name = 'speed_boost' AND ui.quantity > 0`, (err, inventory) => {
        if (err) {
            console.error('Inventory error:', err);
        } else {
            console.log('\n📦 Users with speed_boost items:');
            if (inventory.length === 0) {
                console.log('   - No users have speed_boost items');
            } else {
                inventory.forEach(inv => {
                    console.log(`   - User ${inv.user_id}: ${inv.quantity} x ${inv.display_name}`);
                });
            }
        }
        
        // Grant speed boost to user 8 if they don't have any
        const userId = 8;
        const speedBoostItemId = 1;
        
        db.get('SELECT * FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, speedBoostItemId], (err, existing) => {
            if (err) {
                console.error('Check existing error:', err);
                db.close();
                return;
            }
            
            if (!existing) {
                console.log(`\n🎁 Granting speed_boost to user ${userId}...`);
                db.run('INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)', 
                    [userId, speedBoostItemId, 5], (err) => {
                    if (err) {
                        console.error('Grant error:', err);
                    } else {
                        console.log('✅ Speed boost granted!');
                    }
                    db.close();
                });
            } else {
                console.log(`\n✅ User ${userId} already has ${existing.quantity} speed_boost items`);
                db.close();
            }
        });
    });
});