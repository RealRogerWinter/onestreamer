const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('Checking chatbots table structure...');

db.serialize(() => {
    // First check if the table exists and show its structure
    db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='chatbots'", (err, rows) => {
        if (err) {
            console.error('Error checking table:', err);
            db.close();
            return;
        }
        
        if (rows.length === 0) {
            console.log('❌ Table "chatbots" does not exist');
            db.close();
            return;
        }
        
        console.log('✅ Found chatbots table');
        console.log('Table structure:', rows[0].sql);
        
        // Check if column already exists
        db.all("PRAGMA table_info(chatbots)", (err, columns) => {
            if (err) {
                console.error('Error checking columns:', err);
                db.close();
                return;
            }
            
            const hasColumn = columns.some(col => col.name === 'use_assigned_name');
            
            if (hasColumn) {
                console.log('✅ Column use_assigned_name already exists');
                db.close();
            } else {
                console.log('➕ Adding use_assigned_name column...');
                
                db.run(`ALTER TABLE chatbots ADD COLUMN use_assigned_name BOOLEAN DEFAULT 1`, (err) => {
                    if (err) {
                        console.error('Error adding column:', err);
                    } else {
                        console.log('✅ Successfully added use_assigned_name column');
                        
                        // Update existing rows
                        db.run(`UPDATE chatbots SET use_assigned_name = 1 WHERE use_assigned_name IS NULL`, (err) => {
                            if (!err) {
                                console.log('✅ Set all existing bots to use assigned names by default');
                            }
                            
                            // Show current bots
                            db.all('SELECT id, name, use_assigned_name FROM chatbots', (err, bots) => {
                                if (!err && bots.length > 0) {
                                    console.log('\n📋 Current bots:');
                                    bots.forEach(bot => {
                                        console.log(`   Bot "${bot.name}" (ID: ${bot.id}): ${bot.use_assigned_name ? 'Uses assigned name' : 'Uses random name'}`);
                                    });
                                }
                                db.close();
                            });
                        });
                    }
                });
            }
        });
    });
});