const { runAsync, getAsync } = require('../database/database');

async function migrate() {
    console.log('Adding Summon Lesser Bot item...');
    
    try {
        // Check if item already exists
        const existing = await getAsync(
            'SELECT * FROM items WHERE name = ?',
            ['summon_lesser_bot']
        );
        
        if (existing) {
            console.log('Summon Lesser Bot item already exists, skipping...');
            return;
        }
        
        // Add the new item
        await runAsync(
            `INSERT INTO items (
                name, display_name, emoji, description, item_type, category,
                rarity, base_price, is_purchasable, is_active, 
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'summon_lesser_bot',
                'Summon Lesser Bot',
                '🤖',
                'Summon a custom AI bot to chat for 15 minutes',
                'utility',
                'misc',
                'uncommon',
                300,
                true,
                true,
                900,
                0,
                0,
                JSON.stringify({
                    effect_type: 'summon_bot',
                    requires_input: true,
                    bot_duration: 900,
                    max_name_length: 30,
                    max_prompt_length: 200
                }),
                'replace'
            ]
        );
        
        console.log('✅ Summon Lesser Bot item added successfully');
    } catch (error) {
        console.error('❌ Error adding Summon Lesser Bot item:', error);
        throw error;
    }
}

module.exports = migrate;