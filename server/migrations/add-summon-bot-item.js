const { runAsync } = require('../database/database');

async function addSummonBotItem() {
    console.log('🤖 Adding Summon Bot item to database...');
    
    try {
        // Check if the item already exists
        const existing = await runAsync(
            "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='items'"
        );
        
        // Insert the summon bot item
        await runAsync(
            `INSERT OR IGNORE INTO items (
                name, display_name, emoji, description, item_type, category,
                rarity, base_price, is_purchasable, is_active, 
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'summon_bot',
                'Summon Bot',
                '🤖',
                'Summon a custom AI bot to chat for 1 hour',
                'utility',
                'misc',
                'epic',
                800,
                true,
                true,
                3600,
                0,
                0,
                JSON.stringify({
                    effect_type: 'summon_bot',
                    requires_input: true,
                    bot_duration: 3600,
                    max_name_length: 30,
                    max_prompt_length: 200
                }),
                'replace'
            ]
        );
        
        console.log('✅ Summon Bot item added successfully');
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            console.log('⚠️ Summon Bot item already exists');
        } else {
            console.error('❌ Failed to add Summon Bot item:', error);
            throw error;
        }
    }
}

// Run if called directly
if (require.main === module) {
    addSummonBotItem().then(() => {
        console.log('Migration complete');
        process.exit(0);
    }).catch(error => {
        console.error('Migration failed:', error);
        process.exit(1);
    });
}

module.exports = addSummonBotItem;