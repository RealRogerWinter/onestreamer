const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to the database
const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🧪 Manual Buff Test - Creating test buffs in database...\n');

// Insert a test buff directly into the database
const testBuff = {
    user_id: 3, // Assuming user ID 3 exists (from previous server logs)
    item_id: 1, // Speed Boost item (assuming it exists)
    applied_by_user_id: 3,
    buff_type: 'buff',
    duration_seconds: 300,
    remaining_seconds: 240,
    streaming_time_used: 60,
    metadata: JSON.stringify({ effect_type: 'quality_boost', intensity: 1.5 })
};

db.run(`
    INSERT INTO active_buffs (
        user_id, item_id, applied_by_user_id, buff_type,
        duration_seconds, remaining_seconds, streaming_time_used, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, [
    testBuff.user_id,
    testBuff.item_id,
    testBuff.applied_by_user_id,
    testBuff.buff_type,
    testBuff.duration_seconds,
    testBuff.remaining_seconds,
    testBuff.streaming_time_used,
    testBuff.metadata
], function(err) {
    if (err) {
        console.log('❌ Error inserting test buff:', err.message);
    } else {
        console.log('✅ Test buff inserted with ID:', this.lastID);
        
        // Verify the insertion
        db.get(`
            SELECT ab.*, i.display_name, i.emoji 
            FROM active_buffs ab 
            LEFT JOIN items i ON ab.item_id = i.id 
            WHERE ab.id = ?
        `, [this.lastID], (err, row) => {
            if (err) {
                console.log('❌ Error verifying buff:', err.message);
            } else if (row) {
                console.log('✅ Buff verified in database:');
                console.log(`   - ${row.display_name || 'Unknown Item'} ${row.emoji || '⚡'}`);
                console.log(`   - Duration: ${row.remaining_seconds}s remaining out of ${row.duration_seconds}s`);
                console.log(`   - Type: ${row.buff_type}`);
                console.log(`   - User ID: ${row.user_id}`);
                
                console.log('\n📋 Next steps:');
                console.log('1. Refresh the web application');
                console.log('2. Sign in as user ID 3 (if possible)');
                console.log('3. Check if the buff appears in the "My Active Effects" section');
                console.log('4. The buff should also appear in server logs when requested via socket');
            } else {
                console.log('❌ Buff not found after insertion');
            }
            
            db.close();
        });
    }
});

// Also check what items exist
db.all(`SELECT id, name, display_name, emoji, item_type FROM items LIMIT 5`, (err, rows) => {
    if (err) {
        console.log('❌ Error getting items:', err.message);
    } else {
        console.log('\n📦 Available items (first 5):');
        rows.forEach(item => {
            console.log(`   - ID ${item.id}: ${item.display_name} ${item.emoji} (${item.item_type})`);
        });
    }
});