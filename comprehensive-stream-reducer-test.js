const { runAsync, getAsync, allAsync } = require('./server/database/database');
const ItemService = require('./server/services/ItemService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

async function comprehensiveTest() {
    console.log('🧪 COMPREHENSIVE STREAM REDUCER TEST');
    console.log('=' .repeat(60));
    
    let app, server, io, itemService, buffDebuffService, visualFxService;
    let testSocketId = null;
    
    try {
        // 1. Set up minimal server with socket.io
        console.log('\n1. Setting up test server...');
        app = express();
        server = createServer(app);
        io = new Server(server, { cors: { origin: "*" } });
        
        // 2. Initialize services
        console.log('\n2. Initializing services...');
        itemService = new ItemService();
        buffDebuffService = new BuffDebuffService(io, null, null, null);
        visualFxService = new VisualFxService(io);
        
        // Set dependencies (mediasoupService, buffDebuffService, streamService, io, sessionService)
        visualFxService.setDependencies(null, buffDebuffService, null, io, null);
        
        // Wait for services to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 3. Start test server
        const PORT = 9999;
        server.listen(PORT, () => {
            console.log(`✅ Test server running on port ${PORT}`);
        });
        
        // 4. Set up socket event monitoring
        console.log('\n3. Setting up socket event monitoring...');
        const emittedEvents = [];
        
        // Mock io.emit to capture events
        const originalEmit = io.emit.bind(io);
        io.emit = function(eventName, data) {
            emittedEvents.push({ event: eventName, data, timestamp: new Date().toISOString() });
            console.log(`📡 CAPTURED SOCKET EVENT: ${eventName}`, data);
            return originalEmit(eventName, data);
        };
        
        // 5. Check Stream Reducer item exists
        console.log('\n4. Checking Stream Reducer item...');
        const streamReducerItem = await itemService.getItemByName('stream_reducer');
        
        if (!streamReducerItem) {
            throw new Error('Stream Reducer item not found in database');
        }
        
        console.log('✅ Stream Reducer item found:');
        console.log(`   ID: ${streamReducerItem.id}`);
        console.log(`   Type: ${streamReducerItem.item_type}`);
        console.log(`   Duration: ${streamReducerItem.duration_seconds}s`);
        
        const effectData = JSON.parse(streamReducerItem.effect_data);
        console.log(`   Effect Type: ${effectData.effect_type}`);
        console.log(`   Visual Effect: ${effectData.visual_effect}`);
        
        // 6. Test buff/debuff item detection
        console.log('\n5. Testing item type detection...');
        const isBuffDebuffItem = itemService.isBuffOrDebuffItem(streamReducerItem);
        console.log(`   Is Buff/Debuff Item: ${isBuffDebuffItem ? '✅ YES' : '❌ NO'}`);
        
        if (!isBuffDebuffItem) {
            throw new Error('Stream Reducer is not detected as buff/debuff item');
        }
        
        // 7. Test visual effect registration
        console.log('\n6. Testing visual effect registration...');
        const effectRegistry = visualFxService.effectRegistry;
        const resizeEffect = effectRegistry.get('stream_resize_half');
        
        if (resizeEffect) {
            console.log('✅ stream_resize_half effect registered:');
            console.log(`   Type: ${resizeEffect.type}`);
            console.log(`   Parameters:`, resizeEffect.parameters);
            console.log(`   Duration: ${resizeEffect.duration}ms`);
        } else {
            throw new Error('stream_resize_half effect not found in registry');
        }
        
        // 8. Test the complete flow
        console.log('\n7. Testing complete item usage flow...');
        
        const testUserId = 1;
        const testStreamId = 'test_stream_12345';
        const testAppliedBy = 2;
        
        console.log(`   Applying buff to user ${testUserId} with streamId ${testStreamId}`);
        
        // Clear captured events
        emittedEvents.length = 0;
        
        // Apply the buff with stream ID (simulating the fixed route)
        const buffResult = await itemService.applyBuffDebuffItem(
            testUserId,
            streamReducerItem.id,
            testAppliedBy,
            buffDebuffService,
            true, // Skip cooldown validation
            testStreamId // This is the key fix we made
        );
        
        console.log('✅ Buff applied successfully:');
        console.log(`   Buff ID: ${buffResult.id}`);
        console.log(`   Duration: ${buffResult.duration_seconds}s`);
        console.log(`   Remaining: ${buffResult.remaining_seconds}s`);
        
        // 9. Analyze captured socket events
        console.log('\n8. Analyzing emitted socket events...');
        console.log(`   Total events captured: ${emittedEvents.length}`);
        
        emittedEvents.forEach((event, index) => {
            console.log(`   Event ${index + 1}: ${event.event}`);
            if (event.event === 'visual-effect-applied') {
                console.log('   ✅ FOUND visual-effect-applied EVENT!');
                console.log('   Data:', JSON.stringify(event.data, null, 4));
            } else if (event.event === 'buff-applied') {
                console.log('   📢 buff-applied event emitted');
            }
        });
        
        // Check for the visual effect event specifically
        const visualEffectEvent = emittedEvents.find(e => e.event === 'visual-effect-applied');
        
        if (visualEffectEvent) {
            console.log('\n✅ SUCCESS: visual-effect-applied event was emitted!');
            console.log('   Effect ID:', visualEffectEvent.data.effectId);
            console.log('   Duration:', visualEffectEvent.data.duration);
            console.log('   Stream ID:', visualEffectEvent.data.streamId);
            console.log('   Apply to Streamer:', visualEffectEvent.data.applyToStreamer);
        } else {
            console.log('\n❌ PROBLEM: visual-effect-applied event was NOT emitted!');
            
            // Debug why it wasn't emitted
            console.log('\n🔍 Debugging why visual effect wasn\'t triggered...');
            
            // Check if buff-applied event was emitted
            const buffAppliedEvent = emittedEvents.find(e => e.event === 'buff-applied');
            if (!buffAppliedEvent) {
                console.log('❌ buff-applied event was not emitted');
            } else {
                console.log('✅ buff-applied event was emitted');
            }
        }
        
        // 10. Manual visual effect test
        console.log('\n9. Manual visual effect trigger test...');
        
        // Clear events
        emittedEvents.length = 0;
        
        // Manually trigger handleBuffApplied
        const testBuffData = {
            item_name: 'stream_reducer',
            stream_id: testStreamId,
            user_id: testUserId,
            duration_seconds: 60
        };
        
        console.log('   Manually triggering handleBuffApplied...');
        await visualFxService.handleBuffApplied(testBuffData);
        
        const manualVisualEffectEvent = emittedEvents.find(e => e.event === 'visual-effect-applied');
        if (manualVisualEffectEvent) {
            console.log('✅ SUCCESS: Manual trigger worked!');
        } else {
            console.log('❌ PROBLEM: Manual trigger also failed!');
        }
        
        // 11. Summary
        console.log('\n' + '=' .repeat(60));
        console.log('🎯 TEST SUMMARY');
        console.log('=' .repeat(60));
        
        const checks = [
            { name: 'Stream Reducer item exists', passed: !!streamReducerItem },
            { name: 'Item detected as buff/debuff', passed: isBuffDebuffItem },
            { name: 'Visual effect registered', passed: !!resizeEffect },
            { name: 'Buff application succeeded', passed: !!buffResult },
            { name: 'visual-effect-applied event emitted', passed: !!visualEffectEvent },
            { name: 'Manual visual effect trigger worked', passed: !!manualVisualEffectEvent }
        ];
        
        checks.forEach((check, index) => {
            const status = check.passed ? '✅ PASS' : '❌ FAIL';
            console.log(`${index + 1}. ${check.name}: ${status}`);
        });
        
        const allPassed = checks.every(check => check.passed);
        
        if (allPassed) {
            console.log('\n🎉 ALL TESTS PASSED!');
            console.log('The Stream Reducer should work correctly.');
            console.log('If it\'s still not working in the browser, the issue is client-side.');
        } else {
            console.log('\n❌ SOME TESTS FAILED!');
            console.log('The issue is server-side and needs to be fixed.');
        }
        
        // Clean up test buff
        if (buffResult) {
            await buffDebuffService.removeBuff(buffResult.id, 'test_cleanup');
            console.log('🧹 Cleaned up test buff');
        }
        
    } catch (error) {
        console.error('❌ ERROR during comprehensive test:', error);
        console.error('Stack trace:', error.stack);
    } finally {
        // Cleanup
        if (buffDebuffService) {
            buffDebuffService.shutdown();
        }
        if (server) {
            server.close();
        }
        setTimeout(() => process.exit(0), 3000);
    }
}

// Run the comprehensive test
comprehensiveTest();