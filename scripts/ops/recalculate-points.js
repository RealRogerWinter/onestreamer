const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔄 RECALCULATING POINTS WITH CORRECT MULTIPLIERS\n');
console.log('=' .repeat(50));

// Get all users with stats
db.all(`
    SELECT 
        user_id,
        total_stream_time,
        total_view_time,
        chat_message_count,
        points as old_points
    FROM user_stats
`, (err, rows) => {
    if (err) {
        console.error('Error:', err);
        db.close();
        return;
    }
    
    console.log(`\n📊 Found ${rows.length} users to recalculate\n`);
    
    rows.forEach(row => {
        // Calculate with NEW multipliers
        const streamMinutes = row.total_stream_time / 60;
        const viewMinutes = row.total_view_time / 60;
        
        const STREAM_MULTIPLIER = 1200;  // 500 points per 25 seconds
        const VIEW_MULTIPLIER = 480;     // 200 points per 25 seconds
        const CHAT_MULTIPLIER = 50;      // 50 points per chat message
        
        const newPoints = Math.floor(
            streamMinutes * STREAM_MULTIPLIER + 
            viewMinutes * VIEW_MULTIPLIER + 
            (row.chat_message_count || 0) * CHAT_MULTIPLIER
        );
        
        console.log(`User ${row.user_id}:`);
        console.log(`  Stream: ${Math.floor(streamMinutes)} min × 1200 = ${Math.floor(streamMinutes * STREAM_MULTIPLIER)}`);
        console.log(`  View: ${Math.floor(viewMinutes)} min × 480 = ${Math.floor(viewMinutes * VIEW_MULTIPLIER)}`);
        console.log(`  Chat: ${row.chat_message_count} × 50 = ${(row.chat_message_count || 0) * CHAT_MULTIPLIER}`);
        console.log(`  Old Points: ${row.old_points}`);
        console.log(`  NEW POINTS: ${newPoints} (${newPoints > row.old_points ? '+' : ''}${newPoints - row.old_points})`);
        console.log('');
        
        // Update the database
        db.run('UPDATE user_stats SET points = ? WHERE user_id = ?', [newPoints, row.user_id], (err) => {
            if (err) {
                console.error(`  ❌ Failed to update user ${row.user_id}:`, err);
            }
        });
    });
    
    setTimeout(() => {
        // Verify user 3
        db.get('SELECT * FROM user_stats WHERE user_id = 3', (err, row) => {
            if (row) {
                console.log('=' .repeat(50));
                console.log('\n✅ USER 3 FINAL POINTS: ' + row.points);
                console.log('\nBreakdown:');
                console.log(`  ${Math.floor(row.total_stream_time/60)} min streaming = ${Math.floor(row.total_stream_time/60 * 1200)} points`);
                console.log(`  ${Math.floor(row.total_view_time/60)} min viewing = ${Math.floor(row.total_view_time/60 * 480)} points`);
                console.log(`  ${row.chat_message_count} chat messages = ${row.chat_message_count * 50} points`);
            }
            db.close();
        });
    }, 1000);
});