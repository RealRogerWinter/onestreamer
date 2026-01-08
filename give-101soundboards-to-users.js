const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

async function giveItemsToUsers() {
    return new Promise((resolve, reject) => {
        // First get the item ID
        db.get(`SELECT id FROM items WHERE name = '101soundboards'`, (err, item) => {
            if (err || !item) {
                console.log('❌ Could not find 101soundboards item');
                reject(err || new Error('Item not found'));
                return;
            }
            
            console.log(`✅ Found 101soundboards item with ID ${item.id}`);
            
            // Get all users
            db.all(`SELECT id, username FROM users LIMIT 10`, (err, users) => {
                if (err) {
                    console.log('❌ Error fetching users:', err);
                    reject(err);
                    return;
                }
                
                if (users.length === 0) {
                    console.log('⚠️ No users found in database');
                    resolve();
                    return;
                }
                
                console.log(`\nGiving 101soundboards items to ${users.length} users:`);
                
                let completed = 0;
                users.forEach(user => {
                    // Check if user already has the item
                    db.get(`
                        SELECT quantity FROM user_inventory 
                        WHERE user_id = ? AND item_id = ?
                    `, [user.id, item.id], (err, existing) => {
                        if (err) {
                            console.log(`   ❌ Error checking inventory for ${user.username}:`, err);
                            completed++;
                            if (completed === users.length) resolve();
                            return;
                        }
                        
                        if (existing) {
                            // Update quantity
                            const newQuantity = existing.quantity + 3;
                            db.run(`
                                UPDATE user_inventory 
                                SET quantity = ?, acquired_at = datetime('now')
                                WHERE user_id = ? AND item_id = ?
                            `, [newQuantity, user.id, item.id], (err) => {
                                if (err) {
                                    console.log(`   ❌ Error updating inventory for ${user.username}:`, err);
                                } else {
                                    console.log(`   ✅ Updated ${user.username}'s inventory: ${existing.quantity} → ${newQuantity} items`);
                                }
                                completed++;
                                if (completed === users.length) resolve();
                            });
                        } else {
                            // Insert new inventory entry
                            db.run(`
                                INSERT INTO user_inventory (user_id, item_id, quantity, acquired_at)
                                VALUES (?, ?, ?, datetime('now'))
                            `, [user.id, item.id, 3], (err) => {
                                if (err) {
                                    console.log(`   ❌ Error adding to inventory for ${user.username}:`, err);
                                } else {
                                    console.log(`   ✅ Gave 3 101soundboards items to ${user.username}`);
                                }
                                completed++;
                                if (completed === users.length) resolve();
                            });
                        }
                    });
                });
            });
        });
    });
}

// Run the script
giveItemsToUsers()
    .then(() => {
        console.log('\n🎉 Done! Users now have 101soundboards items in their inventory.');
        console.log('   They can click on the 📣 item to play sounds from 101soundboards.com!');
        db.close();
    })
    .catch(error => {
        console.error('❌ Error:', error);
        db.close();
    });