const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db'));

try {
    // Add category column if it doesn't exist
    const columns = db.prepare("PRAGMA table_info(items)").all();
    const hasCategory = columns.some(col => col.name === 'category');
    
    if (!hasCategory) {
        console.log('Adding category column to items table...');
        db.exec(`ALTER TABLE items ADD COLUMN category TEXT DEFAULT 'general'`);
        console.log('Category column added successfully.');
    } else {
        console.log('Category column already exists.');
    }
    
    // Update existing items with categories
    const updates = [
        // Sound Effects category
        { category: 'sound_effects', names: ['megaphone', '101soundboards', 'fart'] },
        
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
        { category: 'food', names: ['fries'] },
        
        // Entertainment category
        { category: 'entertainment', names: ['viewbot_buff', 'viewbot_shield', 'viewbot_kick'] }
    ];
    
    const updateStmt = db.prepare('UPDATE items SET category = ? WHERE name = ?');
    
    for (const update of updates) {
        for (const name of update.names) {
            const result = updateStmt.run(update.category, name);
            if (result.changes > 0) {
                console.log(`Updated ${name} to category: ${update.category}`);
            }
        }
    }
    
    // Add the new Fart item if it doesn't exist
    const fartExists = db.prepare('SELECT id FROM items WHERE name = ?').get('fart');
    
    if (!fartExists) {
        console.log('Adding new Fart item...');
        const insertStmt = db.prepare(`
            INSERT INTO items (
                name, display_name, emoji, description, item_type, category,
                rarity, base_price, cooldown_seconds, max_stack, effect_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        insertStmt.run(
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
            JSON.stringify({
                effect_type: 'sound_and_visual',
                sound_url: 'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                visual_effect: 'fart_clouds',
                auto_play: true
            })
        );
        
        console.log('Fart item added successfully.');
    } else {
        // Update existing fart item
        console.log('Updating existing Fart item...');
        const updateFartStmt = db.prepare(`
            UPDATE items 
            SET category = ?, 
                description = ?,
                effect_data = ?
            WHERE name = ?
        `);
        
        updateFartStmt.run(
            'sound_effects',
            'Release a fart sound with visual effects',
            JSON.stringify({
                effect_type: 'sound_and_visual',
                sound_url: 'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                visual_effect: 'fart_clouds',
                auto_play: true
            }),
            'fart'
        );
        console.log('Fart item updated successfully.');
    }
    
    console.log('\nAll items with categories:');
    const allItems = db.prepare('SELECT name, display_name, category FROM items ORDER BY category, name').all();
    const categorized = {};
    
    for (const item of allItems) {
        const cat = item.category || 'general';
        if (!categorized[cat]) categorized[cat] = [];
        categorized[cat].push(item.display_name);
    }
    
    for (const [category, items] of Object.entries(categorized)) {
        console.log(`\n${category}:`);
        items.forEach(item => console.log(`  - ${item}`));
    }
    
} catch (error) {
    console.error('Error:', error);
} finally {
    db.close();
}