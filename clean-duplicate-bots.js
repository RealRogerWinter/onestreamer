const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('🧹 Cleaning up duplicate bots...\n');

db.serialize(() => {
    // First, show all bots
    db.all('SELECT * FROM chatbots ORDER BY id', (err, bots) => {
        if (err) {
            console.error('Error fetching bots:', err);
            db.close();
            return;
        }
        
        console.log('📋 All bots in database:');
        bots.forEach(bot => {
            const nameMode = bot.use_assigned_name ? 'Assigned' : (bot.use_assigned_name === null ? 'NULL' : 'Random');
            console.log(`   ID ${bot.id}: "${bot.name}" - use_assigned_name: ${nameMode}, enabled: ${bot.is_enabled}`);
        });
        
        // Keep only the ones with proper use_assigned_name values (IDs 1-3)
        // and delete the duplicates (IDs 7-10)
        console.log('\n🗑️ Removing duplicate bots (keeping IDs 1-3)...');
        
        db.run('DELETE FROM chatbots WHERE id > 3', function(err) {
            if (err) {
                console.error('Error deleting duplicates:', err);
            } else {
                console.log(`✅ Removed ${this.changes} duplicate bots`);
            }
            
            // Show remaining bots
            db.all('SELECT * FROM chatbots', (err, remainingBots) => {
                if (!err) {
                    console.log('\n📋 Remaining bots:');
                    remainingBots.forEach(bot => {
                        const nameMode = bot.use_assigned_name ? 'Assigned name' : 'Random name';
                        console.log(`   "${bot.name}": Uses ${nameMode}`);
                    });
                    
                    console.log('\n✨ Cleanup complete! Restart the server to use the clean bot list.');
                }
                db.close();
            });
        });
    });
});