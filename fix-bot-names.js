const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('🔧 Fixing bot name settings...\n');

db.serialize(() => {
    // Update all bots to have use_assigned_name = 1 where it's NULL
    db.run(`
        UPDATE chatbots 
        SET use_assigned_name = 1 
        WHERE use_assigned_name IS NULL
    `, function(err) {
        if (err) {
            console.error('Error updating bots:', err);
        } else {
            console.log(`✅ Updated ${this.changes} bots to use their assigned names`);
        }
        
        // Show updated bots
        db.all('SELECT id, name, use_assigned_name, is_enabled FROM chatbots', (err, bots) => {
            if (!err) {
                console.log('\n📋 Updated bot settings:');
                bots.forEach(bot => {
                    const nameMode = bot.use_assigned_name ? 'Assigned name' : 'Random name';
                    const status = bot.is_enabled ? 'ON' : 'OFF';
                    console.log(`   Bot "${bot.name}" (ID: ${bot.id}): Uses ${nameMode}, Status: ${status}`);
                });
                
                console.log('\n✨ Fix complete! The bots will now use their assigned names:');
                console.log('   - ChillViewer will appear as "ChillViewer"');
                console.log('   - HypeGamer will appear as "HypeGamer"');
                console.log('   - JokesterBear will appear as "JokesterBear"');
                console.log('\nRestart the server to see the changes.');
            }
            db.close();
        });
    });
});