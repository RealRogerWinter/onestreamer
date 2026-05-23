const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

async function resetAllCooldowns() {
    console.log('🔄 Resetting all item cooldown timers...');
    
    // First, check how many cooldown records exist
    db.get('SELECT COUNT(*) as count FROM item_usage_log', (err, result) => {
        if (err) {
            console.error('Error counting cooldown records:', err);
            db.close();
            return;
        }
        
        console.log(`📊 Found ${result.count} cooldown records to reset`);
        
        // Clear all item usage logs (this resets all cooldowns)
        db.run('DELETE FROM item_usage_log', (err) => {
            if (err) {
                console.error('Error clearing cooldown records:', err);
                db.close();
                return;
            }
            
            console.log('✅ All item cooldown timers have been reset successfully!');
            console.log('📋 All users can now use items without cooldown restrictions.');
            
            db.close();
        });
    });
}

resetAllCooldowns();