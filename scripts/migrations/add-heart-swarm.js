const { runAsync, getAsync } = require('../../server/database/database');

async function addHeartSwarmItem() {
    console.log('💕 Adding Heart Swarm item to database...\n');
    
    try {
        // Check if it already exists
        const existing = await getAsync(
            'SELECT * FROM items WHERE name = ?',
            ['heart_swarm']
        );
        
        if (existing) {
            console.log('⚠️ Heart Swarm item already exists');
            console.log('Item ID:', existing.id);
            return;
        }
        
        // Insert the heart swarm item
        const result = await runAsync(
            `INSERT INTO items (
                name, display_name, emoji, description, item_type, 
                rarity, base_price, is_purchasable, is_active, 
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'heart_swarm',           // name
                'Heart Swarm',           // display_name
                '💕',                    // emoji
                'Releases a swarm of floating hearts across the stream', // description
                'utility',               // item_type
                'common',               // rarity
                100,                    // base_price
                true,                   // is_purchasable
                true,                   // is_active
                30,                     // cooldown_seconds
                0,                      // max_stack
                0,                      // duration_seconds
                null,                   // effect_data
                'replace'               // stack_behavior
            ]
        );
        
        console.log('✅ Heart Swarm item successfully added!');
        console.log('Item ID:', result.lastID);
        console.log('\n📝 Item Details:');
        console.log('   Name: heart_swarm');
        console.log('   Display Name: Heart Swarm');
        console.log('   Emoji: 💕');
        console.log('   Type: utility');
        console.log('   Price: 100 points');
        console.log('   Cooldown: 30 seconds');
        
        console.log('\n🎮 How to Use:');
        console.log('   1. Purchase from the shop');
        console.log('   2. Start or watch a stream');
        console.log('   3. Use item from inventory');
        console.log('   4. Click on the stream to release hearts!');
        
    } catch (error) {
        console.error('❌ Error adding Heart Swarm item:', error);
    }
    
    process.exit(0);
}

addHeartSwarmItem();