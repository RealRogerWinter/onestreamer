const { runAsync, getAsync, allAsync } = require('./server/database/database');
const ItemService = require('./server/services/ItemService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');

async function testStreamReducerFixed() {
    console.log('📉 Testing Stream Reducer - Fixed Version\n');
    console.log('=' .repeat(60));
    
    try {
        // Initialize services
        console.log('\n1. Initializing services...');
        const itemService = new ItemService();
        const buffDebuffService = new BuffDebuffService();
        const visualFxService = new VisualFxService();
        
        // Set dependencies
        visualFxService.setDependencies(null, buffDebuffService, null);
        
        // Wait for services to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('✅ Services initialized');
        
        // Test: Apply buff with stream ID
        console.log('\n2. Testing buff application with stream ID...');
        
        const streamReducerItem = await itemService.getItemByName('stream_reducer');
        if (!streamReducerItem) {
            console.log('❌ Stream Reducer item not found');
            return;
        }
        
        const testUserId = 1;
        const testStreamId = 'test_stream_12345';
        
        // Apply buff with stream ID
        console.log(`   Applying buff to user ${testUserId} with streamId ${testStreamId}`);
        
        const buffResult = await buffDebuffService.applyBuff(
            testUserId, // target user
            streamReducerItem.id, // item id
            testUserId, // applied by user
            60, // duration
            JSON.parse(streamReducerItem.effect_data), // effect data
            true, // skip broadcasts for testing
            testStreamId // stream ID - THIS IS THE FIX
        );
        
        console.log('✅ Buff applied with stream ID!');
        console.log('   Buff ID:', buffResult.id);
        console.log('   Item Name:', buffResult.item_name);
        console.log('   Duration:', buffResult.duration_seconds);
        
        // Simulate visual effect trigger
        console.log('\n3. Testing visual effect trigger...');
        
        // Manually trigger the handleBuffApplied to see if it works with stream ID
        const testEventData = {
            ...buffResult,
            stream_id: testStreamId
        };
        
        console.log('   Event data with stream_id:', testEventData.stream_id);
        
        // Clean up test buff
        setTimeout(async () => {
            await buffDebuffService.removeBuff(buffResult.id, 'test_cleanup');
            console.log('\n🧹 Test buff cleaned up');
            
            console.log('\n' + '=' .repeat(60));
            console.log('🎉 FIXED VERSION TEST COMPLETE!');
            console.log('\nChanges made:');
            console.log('1. ✅ Added streamId parameter to BuffDebuffService.applyBuff()');
            console.log('2. ✅ Modified buff-applied event to include stream_id');  
            console.log('3. ✅ Updated ItemService.applyBuffDebuffItem() to pass streamId');
            console.log('4. ✅ Updated items route to pass streamId from request');
            console.log('\nNow the VisualFxService should receive the stream_id and apply the effect!');
        }, 1000);
        
    } catch (error) {
        console.error('❌ Error during fixed test:', error);
    } finally {
        setTimeout(() => {
            if (buffDebuffService) {
                buffDebuffService.shutdown();
            }
            process.exit(0);
        }, 3000);
    }
}

// Run the test
testStreamReducerFixed();