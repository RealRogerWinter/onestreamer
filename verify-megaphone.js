const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

db.get("SELECT * FROM items WHERE name = 'megaphone'", (err, row) => {
    if (err) {
        console.error('Error:', err);
    } else if (row) {
        console.log('✅ Megaphone item found in database:');
        console.log(`   ID: ${row.id}`);
        console.log(`   Name: ${row.display_name}`);
        console.log(`   Emoji: ${row.emoji}`);
        console.log(`   Description: ${row.description}`);
        console.log(`   Price: ${row.base_price} points`);
        console.log(`   Cooldown: ${row.cooldown_seconds} seconds`);
        console.log(`   Type: ${row.item_type}`);
        console.log(`   Active: ${row.is_active ? 'Yes' : 'No'}`);
        console.log(`   Purchasable: ${row.is_purchasable ? 'Yes' : 'No'}`);
    } else {
        console.log('❌ Megaphone item not found');
    }
    db.close();
});