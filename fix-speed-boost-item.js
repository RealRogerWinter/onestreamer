const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

async function fixSpeedBoostItem() {
    console.log('🔧 Fixing speed boost item configuration...');
    
    // Update the speed boost item to have proper buff configuration
    db.run(`UPDATE items SET 
        duration_seconds = 300,
        effect_data = ?
        WHERE name = 'speed_boost'`, 
        [JSON.stringify({ effect_type: 'quality_boost', intensity: 1.5 })], 
        function(err) {
        if (err) {
            console.error('Error updating speed boost item:', err);
            db.close();
            return;
        }
        
        console.log(`✅ Updated speed boost item (${this.changes} row(s) affected)`);
        
        // Verify the update
        db.get('SELECT * FROM items WHERE name = ?', ['speed_boost'], (err, item) => {
            if (err) {
                console.error('Error verifying update:', err);
                db.close();
                return;
            }
            
            console.log('\n📋 Updated speed boost item:');
            console.log(`   - Name: ${item.display_name}`);
            console.log(`   - Type: ${item.item_type}`);
            console.log(`   - Duration: ${item.duration_seconds}s`);
            console.log(`   - Cooldown: ${item.cooldown_seconds}s`);
            console.log(`   - Effect Data: ${item.effect_data}`);
            console.log(`   - Stack Behavior: ${item.stack_behavior}`);
            
            console.log('\n✅ Speed boost item configuration fixed!');
            
            db.close();
        });
    });
}

fixSpeedBoostItem();