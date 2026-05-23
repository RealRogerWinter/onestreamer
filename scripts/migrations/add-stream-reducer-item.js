const { runAsync, getAsync, allAsync } = require('../../server/database/database');

async function addStreamReducerItem() {
    console.log('📉 Adding Stream Reducer Item\n');
    console.log('=' .repeat(50));
    
    try {
        // Check if Stream Reducer item already exists
        console.log('\n1. Checking for existing Stream Reducer item...');
        const existingItem = await getAsync('SELECT * FROM items WHERE name = ?', ['stream_reducer']);
        
        if (existingItem) {
            console.log('✅ Stream Reducer item already exists!');
            console.log('   Name:', existingItem.display_name);
            console.log('   Emoji:', existingItem.emoji);
            console.log('   Type:', existingItem.item_type);
            console.log('   Description:', existingItem.description);
            console.log('   Duration:', existingItem.duration_seconds, 'seconds');
            console.log('   Price:', existingItem.base_price);
            console.log('   Cooldown:', existingItem.cooldown_seconds, 'seconds');
            console.log('\n📉 Stream Reducer is ready to use!');
            return;
        }
        
        console.log('📉 Stream Reducer not found - creating it now...');
        
        // Create the Stream Reducer item
        const result = await runAsync(`
            INSERT INTO items (
                name, display_name, emoji, description, item_type, 
                rarity, base_price, is_purchasable, is_active, 
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            'stream_reducer',
            'Stream Reducer',
            '📉',
            'Cuts the stream size in half for 1 minute',
            'debuff',
            'uncommon',
            200,
            true,
            true,
            90,
            0,
            60,
            JSON.stringify({
                effect_type: 'stream_size_reduction',
                visual_effect: 'stream_resize_half'
            }),
            'replace'
        ]);
        
        console.log('✅ Stream Reducer item created successfully!');
        console.log('   Item ID:', result.id);
        
        // Verify the item was created
        const createdItem = await getAsync('SELECT * FROM items WHERE id = ?', [result.id]);
        if (createdItem) {
            console.log('\n📋 Item Details:');
            console.log('   Name:', createdItem.display_name);
            console.log('   Emoji:', createdItem.emoji);
            console.log('   Type:', createdItem.item_type);
            console.log('   Rarity:', createdItem.rarity);
            console.log('   Description:', createdItem.description);
            console.log('   Duration:', createdItem.duration_seconds, 'seconds');
            console.log('   Price:', createdItem.base_price, 'coins');
            console.log('   Cooldown:', createdItem.cooldown_seconds, 'seconds');
            
            const effectData = JSON.parse(createdItem.effect_data);
            console.log('   Effect Type:', effectData.effect_type);
            console.log('   Visual Effect:', effectData.visual_effect);
        }
        
        console.log('\n' + '=' .repeat(50));
        console.log('📉 Stream Reducer Item Added Successfully!');
        console.log('\nThe item is now available in:');
        console.log('1. The shop (can be purchased for 200 coins)');
        console.log('2. User inventories (if given via admin)');
        console.log('\nHow to use:');
        console.log('1. Purchase or receive the Stream Reducer item');
        console.log('2. Use it while someone is streaming');
        console.log('3. The streamer\'s video will shrink to half size for 60 seconds');
        console.log('4. 90-second cooldown before it can be used again');
        
    } catch (error) {
        console.error('❌ Error adding Stream Reducer item:', error);
    } finally {
        process.exit(0);
    }
}

// Run the script
addStreamReducerItem();