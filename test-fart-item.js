const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🧪 Testing Fart Item Integration\n');

// Test 1: Check if fart item exists
db.get(`SELECT * FROM items WHERE name = 'fart'`, (err, row) => {
    if (err) {
        console.error('❌ Error checking for fart item:', err);
        return;
    }
    
    if (row) {
        console.log('✅ Fart item found in database:');
        console.log(`   Name: ${row.display_name}`);
        console.log(`   Category: ${row.category}`);
        console.log(`   Description: ${row.description}`);
        console.log(`   Emoji: ${row.emoji}`);
        console.log(`   Price: ${row.base_price} points`);
        console.log(`   Cooldown: ${row.cooldown_seconds} seconds`);
        
        // Parse and display effect data
        try {
            const effectData = JSON.parse(row.effect_data);
            console.log('\n   Effect Data:');
            console.log(`   - Type: ${effectData.effect_type}`);
            console.log(`   - Sound URL: ${effectData.sound_url}`);
            console.log(`   - Visual Effect: ${effectData.visual_effect}`);
            console.log(`   - Auto Play: ${effectData.auto_play}`);
        } catch (e) {
            console.log('   Effect Data: Unable to parse');
        }
    } else {
        console.log('❌ Fart item not found in database');
    }
    
    // Test 2: Check Sound Effects category
    console.log('\n📁 Checking Sound Effects category:');
    db.all(`SELECT name, display_name, emoji FROM items WHERE category = 'sound_effects' ORDER BY display_name`, (err, rows) => {
        if (err) {
            console.error('❌ Error checking sound effects category:', err);
        } else {
            console.log(`✅ Found ${rows.length} items in Sound Effects category:`);
            rows.forEach(item => {
                console.log(`   ${item.emoji} ${item.display_name} (${item.name})`);
            });
        }
        
        // Test 3: Check all categories
        console.log('\n📊 All categories summary:');
        db.all(`SELECT category, COUNT(*) as count FROM items WHERE category IS NOT NULL GROUP BY category ORDER BY category`, (err, rows) => {
            if (err) {
                console.error('❌ Error checking categories:', err);
            } else {
                rows.forEach(cat => {
                    const label = cat.category.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                    console.log(`   ${label}: ${cat.count} items`);
                });
            }
            
            console.log('\n✨ Tests completed!');
            console.log('\nTo fully test the fart item:');
            console.log('1. Start the server: pm2 restart server');
            console.log('2. Login to the web interface');
            console.log('3. Go to the Shop and look for the "Sound Effects" category');
            console.log('4. Purchase the Fart item (50 points)');
            console.log('5. Go to Inventory and use the item');
            console.log('6. You should hear the fart sound and see fart clouds animation!');
            
            db.close();
        });
    });
});