const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('Connected to SQLite database');
    }
});

async function setupTestUsers() {
    return new Promise(async (resolve, reject) => {
        try {
            // Find the confetti cannon item
            db.get('SELECT * FROM items WHERE name = ?', ['confetti_cannon'], async (err, item) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                if (!item) {
                    reject(new Error('Confetti cannon item not found'));
                    return;
                }
                
                console.log(`Found item: ${item.display_name} (ID: ${item.id})`);
                
                // Find our test users
                db.all('SELECT * FROM users WHERE username IN (?, ?)', ['cooldowntest1', 'cooldowntest2'], (err, users) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    if (users.length !== 2) {
                        reject(new Error(`Expected 2 test users, found ${users.length}. Run the test script first to create them.`));
                        return;
                    }
                    
                    console.log(`Found ${users.length} test users`);
                    
                    // Give both users some points
                    const updateUserPoints = (userId, callback) => {
                        db.run('UPDATE user_stats SET points = ? WHERE user_id = ?', [10000, userId], function(err) {
                            if (err) {
                                // If user_stats doesn't exist, create it
                                db.run('INSERT OR REPLACE INTO user_stats (user_id, points) VALUES (?, ?)', [userId, 10000], callback);
                            } else {
                                callback(null);
                            }
                        });
                    };
                    
                    // Give both users the confetti cannon item
                    const giveItemToUser = (userId, itemId, callback) => {
                        db.run('INSERT OR REPLACE INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)', 
                               [userId, itemId, 5], callback);
                    };
                    
                    let completed = 0;
                    const totalOperations = users.length * 2; // points + item for each user
                    
                    users.forEach(user => {
                        updateUserPoints(user.id, (err) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            console.log(`✅ Gave 10000 points to user ${user.username} (ID: ${user.id})`);
                            completed++;
                            
                            giveItemToUser(user.id, item.id, (err) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                console.log(`✅ Gave 5x ${item.display_name} to user ${user.username} (ID: ${user.id})`);
                                completed++;
                                
                                if (completed === totalOperations) {
                                    resolve();
                                }
                            });
                        });
                    });
                });
            });
            
        } catch (error) {
            reject(error);
        }
    });
}

setupTestUsers().then(() => {
    console.log('\n🎉 Test users setup completed successfully!');
    console.log('✅ Users now have points and confetti cannon items');
    console.log('🔄 You can now run the cooldown test');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Setup failed:', error.message);
    db.close();
    process.exit(1);
});