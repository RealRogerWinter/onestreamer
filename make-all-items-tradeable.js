const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Open database connection
const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
console.log('📂 Opening database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
        process.exit(1);
    }
    console.log('✅ Database opened successfully');
    
    // Run all operations
    checkAndUpdateItems();
});

function checkAndUpdateItems() {
    // First check what tables exist
    db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
        if (err) {
            console.error('❌ Error listing tables:', err);
            db.close();
            return;
        }
        
        console.log('📋 Tables in database:', tables.map(t => t.name).join(', '));
        
        if (!tables.some(t => t.name === 'items')) {
            console.error('❌ Items table does not exist! Make sure the server has been run at least once to initialize the database.');
            db.close();
            return;
        }
        
        // Check if is_tradeable column exists
        db.all("PRAGMA table_info(items)", (err, columns) => {
            if (err) {
                console.error('❌ Error checking columns:', err);
                db.close();
                return;
            }
            
            console.log('📋 Columns in items table:', columns.map(c => c.name).join(', '));
            
            const hasTradeableColumn = columns.some(col => col.name === 'is_tradeable');
            
            if (!hasTradeableColumn) {
                // Add the column if it doesn't exist
                console.log('📝 Adding is_tradeable column...');
                db.run("ALTER TABLE items ADD COLUMN is_tradeable INTEGER DEFAULT 1", (err) => {
                    if (err) {
                        console.error('❌ Error adding column:', err);
                        db.close();
                        return;
                    }
                    console.log('✅ Added is_tradeable column');
                    updateAllItems();
                });
            } else {
                // Column exists, just update all items
                console.log('✅ is_tradeable column already exists');
                updateAllItems();
            }
        });
    });
}

function updateAllItems() {
    // Update all items to be tradeable
    db.run("UPDATE items SET is_tradeable = 1 WHERE is_tradeable IS NULL OR is_tradeable = 0", function(err) {
        if (err) {
            console.error('❌ Error updating items:', err);
            db.close();
            return;
        }
        
        console.log(`✅ Updated ${this.changes} items to be tradeable`);
        
        // Show all items and their tradeable status
        db.all("SELECT id, name, display_name, emoji, is_tradeable FROM items ORDER BY name", (err, rows) => {
            if (err) {
                console.error('❌ Error fetching items:', err);
            } else {
                console.log('\n📦 All items in database:');
                if (rows.length === 0) {
                    console.log('  No items found. The database might need to be initialized.');
                } else {
                    rows.forEach(item => {
                        const tradeable = item.is_tradeable ? '✅' : '❌';
                        console.log(`  ${tradeable} ${item.emoji || '📦'} ${item.display_name || item.name} (ID: ${item.id})`);
                    });
                    console.log(`\n✨ Total: ${rows.length} items`);
                }
            }
            
            db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err);
                } else {
                    console.log('\n✨ Done! All items are now tradeable.');
                }
            });
        });
    });
}