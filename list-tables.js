const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('Listing all tables in database...\n');

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) {
        console.error('Error listing tables:', err);
    } else {
        console.log('📋 Tables found:');
        tables.forEach(table => {
            console.log(`   - ${table.name}`);
        });
    }
    db.close();
});