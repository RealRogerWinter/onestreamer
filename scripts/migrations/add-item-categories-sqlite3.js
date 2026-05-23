const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('Adding item categories...');

// Add category column if it doesn't exist
db.get("SELECT COUNT(*) as count FROM pragma_table_info('items') WHERE name='category'", (err, row) => {
    if (err) {
        console.error('Error checking for category column:', err);
        return;
    }
    
    if (row.count === 0) {
        console.log('Adding category column to items table...');
        db.run("ALTER TABLE items ADD COLUMN category TEXT DEFAULT 'general'", (err) => {
            if (err) {
                console.error('Error adding category column:', err);
            } else {
                console.log('Category column added successfully.');
                updateCategories();
            }
        });
    } else {
        console.log('Category column already exists.');
        updateCategories();
    }
});

function updateCategories() {
    // Update existing items with categories
    const updates = [
        // Sound Effects category
        { category: 'sound_effects', names: ['megaphone', '101soundboards'] },
        
        // Visual Effects category
        { category: 'visual_effects', names: ['rainbow_effect', 'disco_ball', 'confetti_cannon', 'smoke_bomb', 'potato', 'freeze_frame'] },
        
        // Drawing Tools category
        { category: 'drawing_tools', names: ['red_marker', 'blue_marker', 'green_marker', 'yellow_marker', 'orange_marker', 'pink_marker', 'black_marker', 'white_marker', 'rainbow_marker'] },
        
        // Power-ups category
        { category: 'powerups', names: ['speed_boost', 'spotlight', 'golden_mic', 'mega_boost'] },
        
        // Debuffs category
        { category: 'debuffs', names: ['slow_mode'] },
        
        // Protection category
        { category: 'protection', names: ['shield', 'reinforced_shield', 'fortress_wall'] },
        
        // Utility category
        { category: 'utility', names: ['tomato', 'kill_switch', 'stream_reducer'] },
        
        // Combat category
        { category: 'combat', names: ['arrow', 'molotov', 'heart_swarm', 'lsd', 'emboss', 'bugs'] },
        
        // Food category
        { category: 'food', names: ['fries'] }
    ];
    
    let updateCount = 0;
    const totalUpdates = updates.reduce((sum, u) => sum + u.names.length, 0);
    
    updates.forEach(update => {
        update.names.forEach(name => {
            db.run('UPDATE items SET category = ? WHERE name = ?', [update.category, name], function(err) {
                updateCount++;
                if (err) {
                    console.error(`Error updating ${name}:`, err);
                } else if (this.changes > 0) {
                    console.log(`Updated ${name} to category: ${update.category}`);
                }
                
                if (updateCount === totalUpdates) {
                    addFartItem();
                }
            });
        });
    });
}

function addFartItem() {
    // Check if fart item exists
    db.get('SELECT id FROM items WHERE name = ?', ['fart'], (err, row) => {
        if (err) {
            console.error('Error checking for fart item:', err);
            listCategories();
            return;
        }
        
        if (!row) {
            console.log('\nAdding new Fart item...');
            const effectData = JSON.stringify({
                effect_type: 'sound_and_visual',
                sound_url: 'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                visual_effect: 'fart_clouds',
                auto_play: true
            });
            
            db.run(`
                INSERT INTO items (
                    name, display_name, emoji, description, item_type, category,
                    rarity, base_price, cooldown_seconds, max_stack, effect_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                'fart',
                'Fart',
                '💨',
                'Release a fart sound with visual effects',
                'utility',
                'sound_effects',
                'common',
                50,
                20,
                0,
                effectData
            ], (err) => {
                if (err) {
                    console.error('Error adding fart item:', err);
                } else {
                    console.log('Fart item added successfully.');
                }
                listCategories();
            });
        } else {
            console.log('\nUpdating existing Fart item...');
            const effectData = JSON.stringify({
                effect_type: 'sound_and_visual',
                sound_url: 'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                visual_effect: 'fart_clouds',
                auto_play: true
            });
            
            db.run(`
                UPDATE items 
                SET category = ?, 
                    description = ?,
                    effect_data = ?,
                    emoji = ?
                WHERE name = ?
            `, [
                'sound_effects',
                'Release a fart sound with visual effects',
                effectData,
                '💨',
                'fart'
            ], (err) => {
                if (err) {
                    console.error('Error updating fart item:', err);
                } else {
                    console.log('Fart item updated successfully.');
                }
                listCategories();
            });
        }
    });
}

function listCategories() {
    console.log('\n=== All items by category ===');
    db.all('SELECT name, display_name, category, emoji FROM items ORDER BY category, name', (err, rows) => {
        if (err) {
            console.error('Error listing items:', err);
        } else {
            const categorized = {};
            
            rows.forEach(item => {
                const cat = item.category || 'general';
                if (!categorized[cat]) categorized[cat] = [];
                categorized[cat].push(`${item.emoji} ${item.display_name}`);
            });
            
            Object.entries(categorized).forEach(([category, items]) => {
                console.log(`\n${category.toUpperCase()}:`);
                items.forEach(item => console.log(`  ${item}`));
            });
        }
        
        db.close();
    });
}