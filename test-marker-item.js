const { runAsync, getAsync, allAsync } = require('./server/database/database');

async function testMarkerItem() {
    try {
        console.log('🔍 Testing Marker item...\n');
        
        // Check if marker item exists
        const marker = await getAsync(
            'SELECT * FROM items WHERE name = ?',
            ['marker']
        );
        
        if (marker) {
            console.log('✅ Marker item found in database!');
            console.log('Item details:');
            console.log('  - ID:', marker.id);
            console.log('  - Name:', marker.name);
            console.log('  - Display Name:', marker.display_name);
            console.log('  - Emoji:', marker.emoji);
            console.log('  - Description:', marker.description);
            console.log('  - Type:', marker.item_type);
            console.log('  - Rarity:', marker.rarity);
            console.log('  - Price:', marker.base_price);
            console.log('  - Cooldown:', marker.cooldown_seconds, 'seconds');
            console.log('  - Effect Data:', marker.effect_data);
            
            const effectData = JSON.parse(marker.effect_data || '{}');
            console.log('\n📊 Effect Configuration:');
            console.log('  - Effect Type:', effectData.effect_type);
            console.log('  - Interactive:', effectData.interactive);
            console.log('  - Draw Duration:', effectData.draw_duration, 'ms');
            console.log('  - Display Duration:', effectData.display_duration, 'ms');
            console.log('  - Line Width:', effectData.line_width);
            console.log('  - Default Color:', effectData.default_color);
        } else {
            console.log('❌ Marker item not found in database');
            console.log('Creating marker item...');
            
            // Add the marker item
            await runAsync(
                `INSERT INTO items (
                    name, display_name, emoji, description, item_type, 
                    rarity, base_price, is_purchasable, is_active, 
                    cooldown_seconds, max_stack, effect_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    'marker', 'Marker', '✏️', 'Draw on the stream for 10 seconds',
                    'utility', 'common', 200, 1, 1, 30, 0,
                    JSON.stringify({ 
                        effect_type: 'drawing',
                        interactive: true,
                        draw_duration: 10000,
                        display_duration: 10000,
                        line_width: 3,
                        default_color: '#FF0000'
                    })
                ]
            );
            console.log('✅ Marker item created successfully!');
        }
        
        // List all utility items
        console.log('\n📋 All utility items in database:');
        const utilityItems = await allAsync(
            'SELECT name, display_name, emoji, base_price FROM items WHERE item_type = ? ORDER BY name',
            ['utility']
        );
        
        utilityItems.forEach(item => {
            console.log(`  ${item.emoji} ${item.display_name} (${item.name}) - ${item.base_price} credits`);
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
    }
    
    process.exit(0);
}

testMarkerItem();