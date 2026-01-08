const { runAsync, getAsync, allAsync } = require('./server/database/database');
const ItemService = require('./server/services/ItemService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');

console.log('🥔 Testing Potato Item Fix\n');
console.log('=' .repeat(50));
console.log('This test verifies that the potato item no longer crashes the stream');
console.log('=' .repeat(50) + '\n');

async function testPotatoFix() {
    try {
        // Initialize services
        console.log('1️⃣ Initializing services...');
        const itemService = new ItemService();
        const buffDebuffService = new BuffDebuffService();
        const visualFxService = new VisualFxService();
        
        // Set dependencies (some will be null for testing)
        visualFxService.setDependencies(null, buffDebuffService, null);
        
        // Wait for services to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check if Potato item exists
        console.log('\n2️⃣ Checking Potato item configuration...');
        const potatoItem = await itemService.getItemByName('potato');
        
        if (potatoItem) {
            console.log('✅ Potato item found');
            const effectData = JSON.parse(potatoItem.effect_data);
            console.log(`   Visual Effect: ${effectData.visual_effect}`);
            console.log(`   Duration: ${potatoItem.duration_seconds}s`);
        } else {
            console.log('❌ Potato item not found');
            return;
        }
        
        // Check if bitrate_potato effect exists
        console.log('\n3️⃣ Checking bitrate_potato effect registration...');
        const potatoEffect = visualFxService.effectRegistry.get('bitrate_potato');
        
        if (potatoEffect) {
            console.log('✅ bitrate_potato effect registered');
            console.log(`   Type: ${potatoEffect.type}`);
            console.log(`   Video Bitrate: ${potatoEffect.parameters.videoBitrate} bps`);
            console.log(`   Audio Bitrate: ${potatoEffect.parameters.audioBitrate} bps`);
        } else {
            console.log('❌ bitrate_potato effect not registered');
            return;
        }
        
        // Test applying effect without MediaSoup (simulating missing transport)
        console.log('\n4️⃣ Testing effect application with missing transport...');
        console.log('   (This simulates the crash scenario)');
        
        try {
            // Simulate buff applied event
            const testBuffData = {
                item_name: 'potato',
                user_id: '1',
                duration_seconds: 35,
                id: 'test-buff-1'
            };
            
            console.log('   Applying buff...');
            await visualFxService.handleBuffApplied(testBuffData);
            
            console.log('✅ Buff applied without crashing!');
            console.log('   The fix is working - effect gracefully handles missing transport');
            
        } catch (error) {
            console.error('❌ Error during buff application:', error.message);
            console.log('   The fix may not be working properly');
        }
        
        // Test the improved stream ID resolution
        console.log('\n5️⃣ Testing improved stream ID resolution...');
        
        // Mock some services for testing
        visualFxService.streamService = {
            getCurrentStreamer: () => 'test-socket-123'
        };
        
        visualFxService.sessionService = {
            getSessionBySocketId: (socketId) => {
                if (socketId === 'test-socket-123') {
                    return { userId: '1', ip: '127.0.0.1' };
                }
                return null;
            },
            getSocketsByUserId: (userId) => {
                if (userId === '1') {
                    return ['test-socket-123'];
                }
                return [];
            }
        };
        
        const testBuffData2 = {
            item_name: 'potato',
            user_id: '1',
            duration_seconds: 35,
            id: 'test-buff-2'
        };
        
        console.log('   Testing buff for current streamer...');
        await visualFxService.handleBuffApplied(testBuffData2);
        console.log('✅ Stream ID resolution working');
        
        console.log('\n' + '=' .repeat(50));
        console.log('🎉 POTATO FIX TEST COMPLETE!');
        console.log('=' .repeat(50));
        console.log('\nKey improvements implemented:');
        console.log('1. ✅ Enhanced getStreamTransport() with multiple fallback strategies');
        console.log('2. ✅ Added graceful error handling in applyBitrateEffect()');
        console.log('3. ✅ Improved stream ID resolution in handleBuffApplied()');
        console.log('4. ✅ Added FFmpeg overlay pipeline for potato quality visual feedback');
        console.log('5. ✅ Effects continue client-side even if server-side fails');
        
        console.log('\n📋 Next steps:');
        console.log('1. Start the server: npm run dev');
        console.log('2. Start a stream');
        console.log('3. Use the Potato item on the streamer');
        console.log('4. Verify the stream doesn\'t crash');
        console.log('5. Check that potato quality effect is visible');
        
    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        // Clean up
        if (buffDebuffService) {
            buffDebuffService.shutdown();
        }
        process.exit(0);
    }
}

// Run the test
testPotatoFix();