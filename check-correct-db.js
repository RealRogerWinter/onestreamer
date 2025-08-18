const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// This is the CORRECT database path from database.js
const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking CORRECT Database: server/data/onestreamer.db\n');
console.log('=' .repeat(50));

// Check user_stats table for user 3
db.get(`
    SELECT 
        user_id,
        total_stream_time,
        total_view_time,
        chat_message_count,
        points
    FROM user_stats 
    WHERE user_id = 3
`, (err, row) => {
    if (err) {
        console.error('❌ Error:', err.message);
        
        // Try to list tables
        db.all("SELECT name FROM sqlite_master WHERE type='table'", (err2, tables) => {
            if (!err2) {
                console.log('\nAvailable tables:');
                tables.forEach(t => console.log(`  - ${t.name}`));
            }
            db.close();
        });
        return;
    }
    
    if (!row) {
        console.log('❌ No stats found for user ID 3');
        
        // Check if user exists
        db.get('SELECT id, username, email FROM users WHERE id = 3', (err, user) => {
            if (user) {
                console.log('\n👤 User found:', user);
                console.log('But no stats record exists!');
                
                // Create stats record
                console.log('\n📝 Creating stats record for user 3...');
                db.run(`
                    INSERT INTO user_stats (user_id, total_stream_time, total_view_time, chat_message_count, points)
                    VALUES (3, 0, 0, 0, 0)
                `, (err) => {
                    if (err) {
                        console.log('❌ Failed to create stats:', err.message);
                    } else {
                        console.log('✅ Stats record created!');
                    }
                    db.close();
                });
            } else {
                console.log('❌ User ID 3 does not exist');
                db.close();
            }
        });
        return;
    }
    
    console.log('\n📊 DATABASE VALUES FOR USER 3:');
    console.log(`Total Stream Time: ${row.total_stream_time} seconds (${Math.floor(row.total_stream_time / 60)} minutes)`);
    console.log(`Total View Time: ${row.total_view_time} seconds (${Math.floor(row.total_view_time / 60)} minutes)`);
    console.log(`Chat Messages: ${row.chat_message_count}`);
    console.log(`\n💎 STORED POINTS: ${row.points}`);
    
    // Calculate what points SHOULD be
    const streamMinutes = row.total_stream_time / 60;
    const viewMinutes = row.total_view_time / 60;
    const calculatedPoints = Math.floor(
        streamMinutes * 10 + 
        viewMinutes * 2 + 
        row.chat_message_count * 5
    );
    
    console.log(`\n📐 CALCULATED POINTS: ${calculatedPoints}`);
    console.log('\nBREAKDOWN:');
    console.log(`  Stream: ${Math.floor(streamMinutes)} min × 10 = ${Math.floor(streamMinutes * 10)}`);
    console.log(`  View: ${Math.floor(viewMinutes)} min × 2 = ${Math.floor(viewMinutes * 2)}`);
    console.log(`  Chat: ${row.chat_message_count} × 5 = ${row.chat_message_count * 5}`);
    
    if (row.points !== calculatedPoints) {
        console.log('\n⚠️ MISMATCH! Updating points...');
        db.run('UPDATE user_stats SET points = ? WHERE user_id = 3', [calculatedPoints], (err) => {
            if (err) {
                console.log('❌ Failed to update:', err.message);
            } else {
                console.log(`✅ Updated points to ${calculatedPoints}`);
            }
            db.close();
        });
    } else {
        console.log('\n✅ Points are correct!');
        db.close();
    }
});