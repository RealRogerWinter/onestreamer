const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🎁 Connected to SQLite database to give fries item');
    }
});

async function giveFriesItem() {
    return new Promise((resolve, reject) => {
        console.log('🎁 Adding fries item to onestreamer user inventory...');
        
        // Insert or update the inventory item
        db.run(
            `INSERT OR REPLACE INTO user_inventory (user_id, item_id, quantity, acquired_at) 
             VALUES (3, 11, 5, datetime('now'))`,
            function(err) {
                if (err) {
                    reject(err);
                    return;
                }
                
                console.log('✅ Successfully added 5x fries to user inventory');
                
                // Also give user some points if they don't have enough
                db.run(
                    `INSERT OR REPLACE INTO user_stats (user_id, points, total_stream_time, total_view_time, stream_count, chat_message_count) 
                     VALUES (3, 10000, 0, 0, 0, 0)`,
                    function(err) {
                        if (err) {
                            console.log('⚠️ Could not update user points, but inventory was updated');
                        } else {
                            console.log('✅ Also gave user 10000 points');
                        }
                        
                        // Verify the changes
                        db.get('SELECT * FROM user_inventory WHERE user_id = 3 AND item_id = 11', (err, inventoryItem) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            
                            if (inventoryItem) {
                                console.log(`✅ Verified: User now has ${inventoryItem.quantity}x fries in inventory`);
                            }
                            
                            resolve();
                        });
                    }
                );
            }
        );
    });
}

giveFriesItem().then(() => {
    console.log('\n🎉 Fries item successfully added to user inventory!');
    console.log('✅ User onestreamer (user@example.com) can now use the fries item');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Failed to give fries item:', error.message);
    db.close();
    process.exit(1);
});