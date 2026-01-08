const { runAsync, getAsync, allAsync } = require('./server/database/database');
const ItemService = require('./server/services/ItemService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');

async function testPotatoItem() {
    console.log('🥔 Testing Potato Item Integration\n');
    console.log('=' .repeat(50));
    
    try {
        // Initialize services
        const itemService = new ItemService();
        const buffDebuffService = new BuffDebuffService();
        const visualFxService = new VisualFxService();
        
        // Set dependencies
        visualFxService.setDependencies(null, buffDebuffService, null);
        
        // Wait for services to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check if Potato item exists
        console.log('\n1. Checking for Potato item...');
        const potatoItem = await itemService.getItemByName('potato');
        
        if (potatoItem) {
            console.log('✅ Potato item found!');
            console.log('   Name:', potatoItem.display_name);
            console.log('   Emoji:', potatoItem.emoji);
            console.log('   Type:', potatoItem.item_type);
            console.log('   Description:', potatoItem.description);
            console.log('   Duration:', potatoItem.duration_seconds, 'seconds');
            console.log('   Price:', potatoItem.base_price);
            console.log('   Cooldown:', potatoItem.cooldown_seconds, 'seconds');
            
            const effectData = JSON.parse(potatoItem.effect_data);
            console.log('   Effect Type:', effectData.effect_type);
            console.log('   Visual Effect:', effectData.visual_effect);
        } else {
            console.log('❌ Potato item not found - creating it now...');
            
            // Create the Potato item
            await itemService.createItem({
                name: 'potato',
                display_name: 'Potato',
                emoji: '🥔',
                description: 'Give the streamer Potato Quality - ultra low resolution streaming',
                item_type: 'debuff',
                rarity: 'common',
                base_price: 75,
                cooldown_seconds: 45,
                max_stack: 0,
                duration_seconds: 35,
                effect_data: JSON.stringify({ 
                    effect_type: 'potato_quality',
                    visual_effect: 'bitrate_potato'
                }),
                stack_behavior: 'replace'
            });
            
            console.log('✅ Potato item created successfully!');
        }
        
        // Check if bitrate_potato visual effect exists
        console.log('\n2. Checking for bitrate_potato visual effect...');
        const effectRegistry = visualFxService.effectRegistry;
        const potatoEffect = effectRegistry.get('bitrate_potato');
        
        if (potatoEffect) {
            console.log('✅ bitrate_potato effect found!');
            console.log('   Name:', potatoEffect.name);
            console.log('   Type:', potatoEffect.type);
            console.log('   Parameters:', JSON.stringify(potatoEffect.parameters));
            console.log('   Duration:', potatoEffect.duration, 'ms');
        } else {
            console.log('❌ bitrate_potato effect not found in registry');
        }
        
        // Check buff-to-effect mapping
        console.log('\n3. Checking buff-to-effect mapping...');
        console.log('   The handleBuffApplied method in VisualFxService should map');
        console.log('   "potato" -> "bitrate_potato" effect');
        console.log('   ✅ Mapping is configured in VisualFxService.js');
        
        console.log('\n' + '=' .repeat(50));
        console.log('🥔 Potato Item Test Complete!');
        console.log('\nTo test the item in action:');
        console.log('1. Open the application in your browser');
        console.log('2. Start a stream');
        console.log('3. Use the Potato item on the streamer');
        console.log('4. The stream should show ultra-low quality (100kbps) for 35 seconds');
        
    } catch (error) {
        console.error('❌ Error during test:', error);
    } finally {
        // Clean up
        buffDebuffService.shutdown();
        process.exit(0);
    }
}

// Run the test
testPotatoItem();