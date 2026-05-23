const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

// Add 101soundboards item
const add101SoundboardsItem = () => {
    return new Promise((resolve, reject) => {
        const item = {
            name: '101soundboards',
            display_name: '101 Soundboards',
            emoji: '📣',
            description: 'Play any sound from 101soundboards.com',
            item_type: 'utility',
            rarity: 'uncommon',
            base_price: 50,
            cooldown_seconds: 30,
            duration_seconds: 0,
            max_stack: 10,
            effect_data: JSON.stringify({
                type: 'soundboard',
                provider: '101soundboards',
                requiresUrl: true,
                maxDuration: 60
            }),
            is_purchasable: 1,
            is_active: 1,
            stack_behavior: 'replace'
        };

        db.run(`
            INSERT OR REPLACE INTO items (
                name, display_name, emoji, description, item_type, rarity,
                base_price, cooldown_seconds, duration_seconds, max_stack,
                effect_data, is_purchasable, is_active, stack_behavior
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            item.name, item.display_name, item.emoji, item.description,
            item.item_type, item.rarity, item.base_price, item.cooldown_seconds,
            item.duration_seconds, item.max_stack, item.effect_data,
            item.is_purchasable, item.is_active, item.stack_behavior
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                console.log(`✅ Added ${item.display_name} item with ID ${this.lastID}`);
                resolve(this.lastID);
            }
        });
    });
};

// Give some 101soundboards items to test users
const giveTestItems = (itemId) => {
    return new Promise((resolve, reject) => {
        // First get test user IDs
        db.all(`SELECT id, username FROM users WHERE username IN ('admin', 'test', 'user') LIMIT 3`, (err, users) => {
            if (err) {
                reject(err);
                return;
            }

            if (users.length === 0) {
                console.log('No test users found, skipping inventory setup');
                resolve();
                return;
            }

            let completed = 0;
            users.forEach(user => {
                db.run(`
                    INSERT OR REPLACE INTO user_inventory (user_id, item_id, quantity, acquired_at)
                    VALUES (?, ?, ?, datetime('now'))
                `, [user.id, itemId, 5], (err) => {
                    if (err) {
                        console.error(`Failed to give item to ${user.username}:`, err);
                    } else {
                        console.log(`✅ Gave 5 101soundboards items to ${user.username}`);
                    }
                    completed++;
                    if (completed === users.length) {
                        resolve();
                    }
                });
            });
        });
    });
};

// Run the setup
async function setup() {
    try {
        const itemId = await add101SoundboardsItem();
        await giveTestItems(itemId);
        console.log('\n✅ 101soundboards item setup complete!');
    } catch (error) {
        console.error('❌ Error setting up 101soundboards item:', error);
    } finally {
        db.close();
    }
}

setup();