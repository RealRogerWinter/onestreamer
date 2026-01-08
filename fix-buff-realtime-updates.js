const { runAsync, getAsync, allAsync } = require('./server/database/database');

async function analyzeBuffRealtimeIssue() {
    console.log('🔍 Analyzing Buff Real-time Update Issue\n');
    console.log('=' .repeat(50));
    
    try {
        // Check if there are any active buffs right now
        console.log('1. Checking current active buffs...');
        const activeBuffs = await allAsync(`
            SELECT ab.*, i.display_name, i.name as item_name
            FROM active_buffs ab
            JOIN items i ON ab.item_id = i.id
            WHERE ab.is_active = 1 AND ab.remaining_seconds > 0
            ORDER BY ab.applied_at DESC
            LIMIT 10
        `);
        
        console.log(`   Found ${activeBuffs.length} active buffs`);
        activeBuffs.forEach(buff => {
            console.log(`   - User ${buff.user_id}: ${buff.display_name} (${buff.remaining_seconds}s remaining)`);
        });
        
        // Check the structure of visual FX items
        console.log('\n2. Checking visual FX items structure...');
        const vfxItems = await allAsync(`
            SELECT id, name, display_name, item_type, effect_data
            FROM items
            WHERE effect_data LIKE '%visual_effect%'
            LIMIT 5
        `);
        
        console.log(`   Sample visual FX items:`);
        vfxItems.forEach(item => {
            const effectData = JSON.parse(item.effect_data);
            console.log(`   - ${item.display_name}: type=${item.item_type}, visual_effect=${effectData.visual_effect}`);
        });
        
        console.log('\n' + '=' .repeat(50));
        console.log('📊 Analysis Summary:\n');
        
        console.log('The issue is that BuffDisplay component only requests buffs on mount.');
        console.log('When a new buff is applied, the server emits:');
        console.log('  1. buff-applied (individual buff)');
        console.log('  2. user-buff-update (all buffs for user)');
        console.log('  3. my-buffs-update (to user\'s sockets)');
        console.log('  4. streamer-buffs-update (if user is streaming)');
        console.log('\nThe BuffDisplay listens for these events but may not be receiving them properly.');
        
        console.log('\n💡 Potential fixes:');
        console.log('  1. Ensure BuffDisplay is listening to ALL relevant events');
        console.log('  2. Make sure the server is emitting to the correct sockets');
        console.log('  3. Check if showPersonalBuffs/showStreamerBuffs props are set correctly');
        console.log('  4. Verify socket connection is established before events are emitted');
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        process.exit(0);
    }
}

analyzeBuffRealtimeIssue();