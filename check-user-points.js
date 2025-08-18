const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking points for User ID 3\n');
console.log('=' .repeat(50));

// Check user_stats table
db.get(`
    SELECT 
        user_id,
        total_stream_time,
        total_view_time,
        chat_message_count,
        points,
        (total_stream_time / 60 * 10 + total_view_time / 60 * 2 + chat_message_count * 5) as calculated_points
    FROM user_stats 
    WHERE user_id = 3
`, (err, row) => {
    if (err) {
        console.error('❌ Error querying database:', err);
        db.close();
        return;
    }
    
    if (!row) {
        console.log('❌ No stats found for user ID 3');
        db.close();
        return;
    }
    
    console.log('\n📊 DATABASE VALUES:');
    console.log(`User ID: ${row.user_id}`);
    console.log(`Total Stream Time: ${row.total_stream_time} seconds (${Math.floor(row.total_stream_time / 60)} minutes)`);
    console.log(`Total View Time: ${row.total_view_time} seconds (${Math.floor(row.total_view_time / 60)} minutes)`);
    console.log(`Chat Messages: ${row.chat_message_count}`);
    console.log(`\n💎 POINTS:`);
    console.log(`Stored Points: ${row.points}`);
    console.log(`Calculated Points: ${Math.floor(row.calculated_points)}`);
    
    console.log('\n📝 CALCULATION BREAKDOWN:');
    const streamPoints = Math.floor(row.total_stream_time / 60 * 10);
    const viewPoints = Math.floor(row.total_view_time / 60 * 2);
    const chatPoints = row.chat_message_count * 5;
    
    console.log(`Stream: ${Math.floor(row.total_stream_time / 60)} min × 10 = ${streamPoints} points`);
    console.log(`View: ${Math.floor(row.total_view_time / 60)} min × 2 = ${viewPoints} points`);
    console.log(`Chat: ${row.chat_message_count} messages × 5 = ${chatPoints} points`);
    console.log(`TOTAL: ${streamPoints + viewPoints + chatPoints} points`);
    
    if (row.points !== Math.floor(row.calculated_points)) {
        console.log('\n⚠️ WARNING: Stored points don\'t match calculated points!');
        console.log('This needs to be recalculated.');
    }
    
    // Update points if needed
    if (row.points < 1000000 && row.calculated_points < 1000000) {
        console.log('\n❓ Points are less than 1 million.');
        console.log('If you expect > 1 million, the time values might be incorrect.');
        
        // Calculate what would be needed for 1 million points
        console.log('\n📐 To reach 1 million points, you would need approximately:');
        console.log('- 100,000 minutes of streaming (1,667 hours) OR');
        console.log('- 500,000 minutes of viewing (8,333 hours) OR');
        console.log('- 200,000 chat messages');
    }
    
    db.close();
});