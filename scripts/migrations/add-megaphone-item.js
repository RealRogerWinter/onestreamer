const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

async function addMegaphoneItem() {
    return new Promise((resolve, reject) => {
        // First check if the megaphone item already exists
        db.get("SELECT * FROM items WHERE name = 'megaphone'", (err, row) => {
            if (err) {
                console.error('Error checking for megaphone item:', err);
                reject(err);
                return;
            }

            if (row) {
                console.log('✅ Megaphone item already exists:', row);
                resolve(row);
                return;
            }

            // If it doesn't exist, create it
            const insertQuery = `
                INSERT INTO items (
                    name, display_name, emoji, description, item_type, 
                    rarity, base_price, is_purchasable, is_active, 
                    cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const params = [
                'megaphone',
                'Megaphone',
                '📢',
                'Broadcast a text-to-speech message to everyone watching',
                'utility',
                'common',
                150,
                1, // is_purchasable
                1, // is_active
                30, // cooldown_seconds
                0, // max_stack (unlimited)
                0, // duration_seconds (not applicable)
                JSON.stringify({ 
                    effect_type: 'tts',
                    requires_input: true,
                    max_length: 200
                }),
                'replace' // stack_behavior
            ];

            db.run(insertQuery, params, function(err) {
                if (err) {
                    console.error('Error creating megaphone item:', err);
                    reject(err);
                    return;
                }

                console.log('✅ Successfully created Megaphone item with ID:', this.lastID);
                
                // Also add it to the shop
                const shopInsertQuery = `
                    INSERT INTO shop_items (item_id, stock_quantity, price_override, discount_percentage, is_featured, is_available)
                    VALUES (?, ?, ?, ?, ?, ?)
                `;
                
                db.run(shopInsertQuery, [this.lastID, 0, null, 0, 0, 1], function(shopErr) {
                    if (shopErr && !shopErr.message.includes('UNIQUE constraint failed')) {
                        console.error('Error adding megaphone to shop:', shopErr);
                    } else {
                        console.log('✅ Megaphone added to shop');
                    }
                    resolve({ id: this.lastID });
                });
            });
        });
    });
}

// Run the script
addMegaphoneItem()
    .then(() => {
        console.log('✅ Megaphone item setup complete');
        db.close();
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Failed to add megaphone item:', err);
        db.close();
        process.exit(1);
    });