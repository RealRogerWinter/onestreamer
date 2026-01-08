const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('Adding use_assigned_name field to chatbots table...');

db.serialize(() => {
    // Add the use_assigned_name column to chatbots table
    db.run(`
        ALTER TABLE chatbots 
        ADD COLUMN use_assigned_name BOOLEAN DEFAULT 1
    `, (err) => {
        if (err) {
            if (err.message.includes('duplicate column name')) {
                console.log('✓ Column use_assigned_name already exists');
            } else {
                console.error('Error adding column:', err);
            }
        } else {
            console.log('✅ Added use_assigned_name column to chatbots table');
        }
        
        // Set all existing bots to use their assigned names by default
        db.run(`
            UPDATE chatbots 
            SET use_assigned_name = 1 
            WHERE use_assigned_name IS NULL
        `, (err) => {
            if (!err) {
                console.log('✅ Set all existing bots to use assigned names');
            }
            
            // Verify the changes
            db.all('SELECT id, name, use_assigned_name FROM chatbots', (err, rows) => {
                if (!err && rows.length > 0) {
                    console.log('\n📋 Current bot name settings:');
                    rows.forEach(row => {
                        console.log(`   Bot "${row.name}": ${row.use_assigned_name ? 'Uses assigned name' : 'Uses random name'}`);
                    });
                }
                
                db.close();
                console.log('\n✨ Migration complete! Restart the server to use the new feature.');
            });
        });
    });
});