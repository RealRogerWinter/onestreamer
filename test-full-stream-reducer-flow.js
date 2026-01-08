const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const ItemService = require('./server/services/ItemService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');
const CanvasFxService = require('./server/services/CanvasFxService');
const { runAsync, getAsync, allAsync } = require('./server/database/database');

async function testFullStreamReducerFlow() {
    console.log('🧪 FULL STREAM REDUCER FLOW TEST\n');
    console.log('=' .repeat(60));
    
    // Create minimal server
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });
    
    // Initialize services
    const itemService = new ItemService();
    const buffDebuffService = new BuffDebuffService();
    const visualFxService = new VisualFxService();
    const canvasFxService = new CanvasFxService();
    
    // Set up dependencies
    visualFxService.setDependencies(null, buffDebuffService, null, io);
    canvasFxService.io = io;
    
    // Capture ALL socket emissions
    const emittedEvents = [];
    const originalEmit = io.emit;
    io.emit = function(eventName, data) {
        console.log(`📡 EMIT: ${eventName}`, JSON.stringify(data, null, 2));
        emittedEvents.push({ event: eventName, data });
        return originalEmit.call(this, eventName, data);
    };
    
    try {
        console.log('1. Getting Stream Reducer item from database...');
        const streamReducerItem = await itemService.getItemByName('stream_reducer');
        
        if (!streamReducerItem) {
            throw new Error('Stream Reducer item not found in database');
        }
        
        console.log('✅ Stream Reducer item found:');
        console.log(`   ID: ${streamReducerItem.id}`);
        console.log(`   Type: ${streamReducerItem.item_type}`);
        console.log(`   Duration: ${streamReducerItem.duration_seconds}s`);
        
        console.log('\n2. Testing item type detection...');
        const isBuffDebuffItem = itemService.isBuffOrDebuffItem(streamReducerItem);
        console.log(`   Is Buff/Debuff Item: ${isBuffDebuffItem ? '✅ YES' : '❌ NO'}`);
        
        if (!isBuffDebuffItem) {
            // This might be the problem - Stream Reducer is not detected as buff/debuff
            console.log('❌ Stream Reducer is not detected as buff/debuff item!');
            console.log('   This means it will go through the regular item path instead of buff path');
            console.log('   Regular items trigger CanvasFxService, not VisualFxService');
            
            // Let's check what path it would take
            console.log('\n3. Testing CanvasFxService path...');
            try {
                const effect = await canvasFxService.triggerItemEffect(
                    1, // userId
                    streamReducerItem.id,
                    'test_stream_123',
                    { username: 'testuser' }
                );
                
                console.log('✅ CanvasFxService successfully triggered effect:', effect?.type || 'NO EFFECT');
                
                if (effect) {
                    console.log('   Effect Type:', effect.type);
                    console.log('   Effect Config:', JSON.stringify(effect.config, null, 2));
                } else {
                    console.log('❌ No effect was created by CanvasFxService');
                    console.log('   This explains why screen reducer is trying to use default effect type');
                }
            } catch (error) {
                console.error('❌ CanvasFxService error:', error.message);
            }
        } else {
            console.log('\n3. Testing BuffDebuffService path...');
            
            // Test applying the buff
            const buffResult = await itemService.applyBuffDebuffItem(
                1, // userId
                streamReducerItem.id,
                2, // appliedBy
                buffDebuffService,
                true // skip cooldown
            );
            
            console.log('   Buff Result:', buffResult ? '✅ SUCCESS' : '❌ FAILED');
            
            if (buffResult) {
                // This should trigger VisualFxService.handleBuffApplied
                const testBuffData = {
                    item_name: 'stream_reducer',
                    stream_id: 'test_stream_123',
                    user_id: 1,
                    duration_seconds: 60
                };
                
                console.log('\n4. Triggering VisualFxService.handleBuffApplied...');
                await visualFxService.handleBuffApplied(testBuffData);
            }
        }
        
        console.log('\n5. Emitted Events Summary:');
        if (emittedEvents.length === 0) {
            console.log('❌ NO EVENTS WERE EMITTED');
            console.log('   This explains why screen reducer doesn\'t work');
        } else {
            emittedEvents.forEach((emission, index) => {
                console.log(`   Event ${index + 1}:`, emission.event);
                if (emission.event === 'canvas-effect-trigger') {
                    console.log('     Effect Type:', emission.data.type);
                    console.log('     Item Name:', emission.data.itemName);
                } else if (emission.event === 'visual-effect-applied') {
                    console.log('     Effect ID:', emission.data.effectId);
                    console.log('     Effect Config Type:', emission.data.effectConfig?.type);
                }
            });
        }
        
        console.log('\n' + '='.repeat(60));
        console.log('DIAGNOSIS:');
        
        if (emittedEvents.some(e => e.event === 'visual-effect-applied')) {
            console.log('✅ visual-effect-applied event was emitted correctly');
            console.log('   The issue is likely in the client-side handling');
        } else if (emittedEvents.some(e => e.event === 'canvas-effect-trigger')) {
            console.log('⚠️  canvas-effect-trigger was emitted instead of visual-effect-applied');
            console.log('   This means Stream Reducer is being treated as a canvas effect instead of a visual effect');
            console.log('   The canvas effect system doesn\'t know how to handle "resize" type effects');
        } else {
            console.log('❌ NO EFFECTS WERE EMITTED');
            console.log('   Stream Reducer item configuration is broken');
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
    
    server.close();
    console.log('\n✅ Test complete');
}

testFullStreamReducerFlow().then(() => {
    process.exit(0);
}).catch(error => {
    console.error('❌ Failed:', error);
    process.exit(1);
});