const { runAsync, getAsync, allAsync } = require('./server/database/database');

async function testEmbossItem() {
    console.log('🗿 Testing Emboss Item Integration\n');
    console.log('=' .repeat(50));
    
    try {
        // Check emboss item details
        const embossItem = await getAsync('SELECT * FROM items WHERE name = ?', ['emboss']);
        
        if (!embossItem) {
            console.error('❌ Emboss item not found');
            return;
        }
        
        console.log('📋 Emboss Item Details:');
        console.log(`   ID: ${embossItem.id}`);
        console.log(`   Name: ${embossItem.name}`);
        console.log(`   Display Name: ${embossItem.display_name}`);
        console.log(`   Item Type: ${embossItem.item_type}`);
        console.log(`   Duration: ${embossItem.duration_seconds} seconds`);
        console.log(`   Effect Data: ${embossItem.effect_data}`);
        
        const effectData = JSON.parse(embossItem.effect_data);
        console.log('\n🎨 Effect Data Parsed:');
        console.log(`   Effect Type: ${effectData.effect_type}`);
        console.log(`   Visual Effect: ${effectData.visual_effect}`);
        
        // Compare with potato item
        const potatoItem = await getAsync('SELECT * FROM items WHERE name = ?', ['potato']);
        console.log('\n🥔 Potato Item for Comparison:');
        console.log(`   Item Type: ${potatoItem.item_type}`);
        console.log(`   Duration: ${potatoItem.duration_seconds} seconds`);
        console.log(`   Effect Data: ${potatoItem.effect_data}`);
        
        const potatoEffectData = JSON.parse(potatoItem.effect_data);
        console.log('\n🥔 Potato Effect Data Parsed:');
        console.log(`   Effect Type: ${potatoEffectData.effect_type}`);
        console.log(`   Visual Effect: ${potatoEffectData.visual_effect}`);
        
        // Check if both items follow the same structure
        console.log('\n🔍 Structure Comparison:');
        const embossIsValid = embossItem.item_type === 'buff' && 
                              embossItem.duration_seconds > 0 &&
                              effectData.visual_effect === 'emboss';
        const potatoIsValid = potatoItem.item_type === 'debuff' && 
                              potatoItem.duration_seconds > 0 &&
                              potatoEffectData.visual_effect === 'bitrate_potato';
        
        console.log(`   Emboss structure valid: ${embossIsValid}`);
        console.log(`   Potato structure valid: ${potatoIsValid}`);
        
        if (embossIsValid) {
            console.log('\n✅ Emboss item structure matches potato pattern');
            console.log('   - item_type: buff ✅');
            console.log('   - duration_seconds: set ✅');
            console.log('   - effect_data with visual_effect: set ✅');
        } else {
            console.log('\n❌ Emboss item structure differs from potato pattern');
        }
        
        // Check active buffs table for any existing emboss buffs
        const activeEmboss = await allAsync(`
            SELECT ab.*, i.display_name, i.name as item_name
            FROM active_buffs ab
            JOIN items i ON ab.item_id = i.id
            WHERE i.name = 'emboss'
        `);
        
        console.log(`\n📊 Active Emboss Buffs: ${activeEmboss.length}`);
        if (activeEmboss.length > 0) {
            activeEmboss.forEach(buff => {
                console.log(`   User ${buff.user_id}: ${buff.remaining_seconds}s remaining`);
            });
        }
        
    } catch (error) {
        console.error('❌ Error testing emboss item:', error);
    } finally {
        process.exit(0);
    }
}

// Run the test
testEmbossItem();