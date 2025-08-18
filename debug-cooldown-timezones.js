const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

console.log('🔍 Current system time:', new Date().toISOString());
console.log('🔍 Current system time (local):', new Date().toString());

// Check recent item usage logs with timestamps
db.all(`SELECT 
    iul.user_id, 
    iul.item_id, 
    iul.used_at,
    datetime(iul.used_at) as used_at_parsed,
    datetime('now') as current_time_db,
    i.name, 
    i.cooldown_seconds,
    datetime(iul.used_at, '+' || i.cooldown_seconds || ' seconds') as cooldown_end_db
FROM item_usage_log iul 
JOIN items i ON iul.item_id = i.id 
ORDER BY iul.used_at DESC 
LIMIT 10`, (err, rows) => {
    if (err) {
        console.error('Error:', err);
        db.close();
        return;
    }
    
    console.log('\n📋 Recent item usage with cooldown analysis:');
    rows.forEach((row, index) => {
        console.log(`${index + 1}. ${row.name} (ID: ${row.item_id}) - User: ${row.user_id}`);
        console.log(`   Used at (raw): ${row.used_at}`);
        console.log(`   Used at (parsed): ${row.used_at_parsed}`);
        console.log(`   Current DB time: ${row.current_time_db}`);
        console.log(`   Cooldown end (DB): ${row.cooldown_end_db}`);
        console.log(`   Cooldown seconds: ${row.cooldown_seconds}`);
        
        // Manual JS calculation
        const jsUsedAt = new Date(row.used_at);
        const jsCooldownEnd = new Date(jsUsedAt.getTime() + (row.cooldown_seconds * 1000));
        const jsNow = new Date();
        
        console.log(`   JS Used at: ${jsUsedAt.toISOString()}`);
        console.log(`   JS Cooldown end: ${jsCooldownEnd.toISOString()}`);
        console.log(`   JS Current time: ${jsNow.toISOString()}`);
        
        const remainingMs = jsCooldownEnd.getTime() - jsNow.getTime();
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        
        console.log(`   Time difference: ${remainingMinutes} minutes remaining`);
        console.log('');
    });
    
    db.close();
});