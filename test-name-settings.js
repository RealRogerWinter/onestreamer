const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Testing bot name settings...\n');

db.serialize(() => {
    // Show current bot settings
    db.all('SELECT id, name, use_assigned_name, is_enabled FROM chatbots', (err, bots) => {
        if (err) {
            console.error('Error fetching bots:', err);
            db.close();
            return;
        }
        
        console.log('📋 Current bot settings:');
        bots.forEach(bot => {
            const nameMode = bot.use_assigned_name ? 'Uses assigned name' : 'Uses random name';
            const status = bot.is_enabled ? 'ON' : 'OFF';
            console.log(`   Bot "${bot.name}" (ID: ${bot.id}): ${nameMode}, Status: ${status}`);
        });
        
        // Update ChillViewer to use assigned name
        console.log('\n🔄 Updating ChillViewer to use assigned name...');
        db.run('UPDATE chatbots SET use_assigned_name = 1 WHERE name = "ChillViewer"', (err) => {
            if (err) {
                console.error('Error updating bot:', err);
            } else {
                console.log('✅ Updated ChillViewer to use assigned name');
            }
            
            // Show updated settings
            db.all('SELECT id, name, use_assigned_name FROM chatbots WHERE name = "ChillViewer"', (err, bots) => {
                if (!err && bots.length > 0) {
                    console.log(`   ChillViewer will now appear as: "${bots[0].name}" in chat`);
                }
                
                console.log('\n✨ Test complete! Restart the server to see the changes.');
                db.close();
            });
        });
    });
});