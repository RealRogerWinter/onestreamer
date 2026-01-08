const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking Database Structure\n');
console.log('=' .repeat(50));

// List all tables
db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) {
        console.error('Error listing tables:', err);
        db.close();
        return;
    }
    
    console.log('\n📊 Available tables:');
    tables.forEach(t => console.log(`  - ${t.name}`));
    
    // Check each table for user/points related fields
    console.log('\n🔍 Checking for points-related data...\n');
    
    tables.forEach(table => {
        db.all(`PRAGMA table_info(${table.name})`, (err, columns) => {
            if (!err) {
                const hasPoints = columns.some(col => 
                    col.name.toLowerCase().includes('point') ||
                    col.name.toLowerCase().includes('user') ||
                    col.name.toLowerCase().includes('time') ||
                    col.name.toLowerCase().includes('stream')
                );
                
                if (hasPoints) {
                    console.log(`\n📌 Table: ${table.name}`);
                    columns.forEach(col => {
                        if (col.name.toLowerCase().includes('point') ||
                            col.name.toLowerCase().includes('user') ||
                            col.name.toLowerCase().includes('time') ||
                            col.name.toLowerCase().includes('stream')) {
                            console.log(`  - ${col.name} (${col.type})`);
                        }
                    });
                    
                    // Try to get data for user 3
                    if (columns.some(col => col.name.toLowerCase().includes('user'))) {
                        const userCol = columns.find(col => col.name.toLowerCase().includes('user'))?.name;
                        if (userCol) {
                            db.get(`SELECT * FROM ${table.name} WHERE ${userCol} = 3 OR ${userCol} = '3' LIMIT 1`, (err, row) => {
                                if (!err && row) {
                                    console.log(`\n  ✅ Found data for user 3 in ${table.name}:`);
                                    console.log('  ', JSON.stringify(row, null, 2));
                                }
                            });
                        }
                    }
                }
            }
        });
    });
    
    // Give time for async queries to complete
    setTimeout(() => {
        console.log('\n' + '=' .repeat(50));
        console.log('✅ Database check complete!');
        db.close();
    }, 2000);
});