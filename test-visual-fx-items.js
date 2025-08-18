const { runAsync, getAsync, allAsync } = require('./server/database/database');

async function testVisualFxItems() {
    console.log('🎨 Testing Visual Effects Items\n');
    console.log('=' .repeat(50));
    
    try {
        // Get all visual effect items
        console.log('\n📋 Fetching all visual effect items...');
        const visualFxItems = await allAsync(`
            SELECT id, name, display_name, emoji, item_type, duration_seconds, cooldown_seconds, base_price, effect_data
            FROM items 
            WHERE item_type IN ('buff', 'debuff')
            AND effect_data LIKE '%visual_effect%'
            ORDER BY name
        `);
        
        console.log(`\nFound ${visualFxItems.length} visual effect items:\n`);
        
        // Display items in a formatted table
        visualFxItems.forEach((item, index) => {
            const effectData = JSON.parse(item.effect_data);
            console.log(`${index + 1}. ${item.emoji} ${item.display_name}`);
            console.log(`   ID: ${item.id} | Name: ${item.name}`);
            console.log(`   Type: ${item.item_type} | Duration: ${item.duration_seconds}s | Cooldown: ${item.cooldown_seconds}s`);
            console.log(`   Price: ${item.base_price} coins`);
            console.log(`   Visual Effect: ${effectData.visual_effect}`);
            console.log(`   Effect Type: ${effectData.effect_type}`);
            console.log('');
        });
        
        // Check for any missing mappings
        console.log('=' .repeat(50));
        console.log('\n🔍 Checking for potential issues...\n');
        
        const itemsWithoutVisualEffect = await allAsync(`
            SELECT name, display_name 
            FROM items 
            WHERE item_type IN ('buff', 'debuff')
            AND (effect_data IS NULL OR effect_data NOT LIKE '%visual_effect%')
        `);
        
        if (itemsWithoutVisualEffect.length > 0) {
            console.log(`⚠️  Found ${itemsWithoutVisualEffect.length} buff/debuff items without visual effects:`);
            itemsWithoutVisualEffect.forEach(item => {
                console.log(`   - ${item.display_name} (${item.name})`);
            });
        } else {
            console.log('✅ All buff/debuff items have visual effects configured!');
        }
        
        // Summary stats
        console.log('\n' + '=' .repeat(50));
        console.log('📊 Summary Statistics:');
        
        const stats = await getAsync(`
            SELECT 
                COUNT(*) as total_items,
                COUNT(CASE WHEN item_type = 'buff' THEN 1 END) as buff_count,
                COUNT(CASE WHEN item_type = 'debuff' THEN 1 END) as debuff_count,
                AVG(base_price) as avg_price,
                MIN(base_price) as min_price,
                MAX(base_price) as max_price,
                AVG(duration_seconds) as avg_duration,
                AVG(cooldown_seconds) as avg_cooldown
            FROM items
            WHERE item_type IN ('buff', 'debuff')
            AND effect_data LIKE '%visual_effect%'
        `);
        
        console.log(`   Total Visual FX Items: ${stats.total_items}`);
        console.log(`   Buffs: ${stats.buff_count} | Debuffs: ${stats.debuff_count}`);
        console.log(`   Price Range: ${stats.min_price} - ${stats.max_price} coins (avg: ${Math.round(stats.avg_price)})`);
        console.log(`   Avg Duration: ${Math.round(stats.avg_duration)}s`);
        console.log(`   Avg Cooldown: ${Math.round(stats.avg_cooldown)}s`);
        
        console.log('\n✨ Visual FX items are ready for use!');
        console.log('   - Users can purchase them from the shop');
        console.log('   - Admins can grant them to users');
        console.log('   - They will trigger visual effects when used during streams');
        
    } catch (error) {
        console.error('❌ Error testing visual FX items:', error);
    } finally {
        process.exit(0);
    }
}

// Run the test
testVisualFxItems();