const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Debugging Points Value Issue\n');
console.log('=' .repeat(50));

// Check the actual database
db.all(`
    SELECT name FROM sqlite_master WHERE type='table'
`, (err, tables) => {
    if (err) {
        console.error('Error listing tables:', err);
        db.close();
        return;
    }
    
    console.log('\n📊 Available tables:');
    tables.forEach(t => console.log(`  - ${t.name}`));
    
    // Try different table names that might exist
    const possibleTables = ['users', 'user_stats', 'accounts', 'account_stats'];
    
    possibleTables.forEach(tableName => {
        db.all(`SELECT * FROM ${tableName} LIMIT 1`, (err, rows) => {
            if (!err && rows && rows.length > 0) {
                console.log(`\n✅ Found table: ${tableName}`);
                console.log('Sample row:', rows[0]);
                
                // Get all user points
                if (tableName === 'user_stats') {
                    db.all(`
                        SELECT user_id, 
                               total_stream_time, 
                               total_view_time, 
                               chat_message_count,
                               (total_stream_time * 10 + total_view_time * 2 + chat_message_count * 5) as calculated_points
                        FROM ${tableName}
                        ORDER BY calculated_points DESC
                        LIMIT 5
                    `, (err2, pointRows) => {
                        if (!err2) {
                            console.log('\n💎 Top users by points:');
                            pointRows.forEach(row => {
                                console.log(`  User ${row.user_id}: ${row.calculated_points} points`);
                                console.log(`    Stream: ${row.total_stream_time}min, View: ${row.total_view_time}min, Chat: ${row.chat_message_count}`);
                            });
                        }
                    });
                }
            }
        });
    });
    
    setTimeout(() => {
        db.close();
        console.log('\n' + '=' .repeat(50));
        console.log('Debug complete!');
    }, 2000);
});