const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');
const ItemService = require('./server/services/ItemService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');

async function testStreamReducerSync() {
    console.log('🧪 TESTING STREAM REDUCER SYNCHRONIZATION\n');
    console.log('=' .repeat(70));
    
    // Create test server
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
    
    // Set up dependencies
    visualFxService.setDependencies(null, buffDebuffService, null, io);
    
    // Capture socket events
    const clientEvents = {};
    
    // Start server
    await new Promise((resolve) => {
        server.listen(3001, () => {
            console.log('✅ Test server started on port 3001');
            resolve();
        });
    });
    
    // Add socket connection handler with VisualFxService sync
    io.on('connection', (socket) => {
        console.log(`🔌 SERVER: Client ${socket.id} connected`);
        visualFxService.handleClientConnection(socket);
    });
    
    try {
        console.log('\n1. Creating test client (Early Viewer)...');
        const earlyClient = Client('http://localhost:3001');
        
        // Track events received by early client
        clientEvents.early = [];
        earlyClient.onAny((eventName, data) => {
            if (eventName.includes('visual-effect')) {
                console.log(`👁️  EARLY VIEWER: Received ${eventName}`, {
                    effectId: data.effectId,
                    duration: data.duration,
                    applyToAllViewers: data.applyToAllViewers,
                    isSyncEvent: data.isSyncEvent
                });
                clientEvents.early.push({ event: eventName, data });
            }
        });
        
        await new Promise(resolve => {
            earlyClient.on('connect', () => {
                console.log('✅ Early viewer connected');
                resolve();
            });
        });
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('\n2. Applying Stream Reducer effect...');
        const streamReducerItem = await itemService.getItemByName('stream_reducer');
        
        // Apply the buff (this should trigger visual effect)
        const buffResult = await itemService.applyBuffDebuffItem(
            1, // userId
            streamReducerItem.id,
            2, // appliedBy
            buffDebuffService,
            true // skip cooldown
        );
        
        // Manually trigger the visual effect as it would happen in the real app
        const testBuffData = {
            item_name: 'stream_reducer',
            stream_id: 'test_stream_123',
            user_id: 1,
            duration_seconds: 60
        };
        
        await visualFxService.handleBuffApplied(testBuffData);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('\n3. Creating test client (Late Viewer)...');
        const lateClient = Client('http://localhost:3001');
        
        // Track events received by late client
        clientEvents.late = [];
        lateClient.onAny((eventName, data) => {
            if (eventName.includes('visual-effect')) {
                console.log(`👁️  LATE VIEWER: Received ${eventName}`, {
                    effectId: data.effectId,
                    duration: data.duration,
                    applyToAllViewers: data.applyToAllViewers,
                    isSyncEvent: data.isSyncEvent
                });
                clientEvents.late.push({ event: eventName, data });
            }
        });
        
        await new Promise(resolve => {
            lateClient.on('connect', () => {
                console.log('✅ Late viewer connected');
                resolve();
            });
        });
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('\n' + '='.repeat(70));
        console.log('RESULTS ANALYSIS:');
        
        console.log('\n📊 Early Viewer Events:');
        if (clientEvents.early.length > 0) {
            clientEvents.early.forEach((event, i) => {
                console.log(`   ${i + 1}. ${event.event} - effectId: ${event.data.effectId}, sync: ${event.data.isSyncEvent || false}`);
            });
        } else {
            console.log('   ❌ No events received by early viewer');
        }
        
        console.log('\n📊 Late Viewer Events:');
        if (clientEvents.late.length > 0) {
            clientEvents.late.forEach((event, i) => {
                console.log(`   ${i + 1}. ${event.event} - effectId: ${event.data.effectId}, sync: ${event.data.isSyncEvent || false}`);
            });
        } else {
            console.log('   ❌ No events received by late viewer');
        }
        
        console.log('\n🎯 TEST RESULTS:');
        
        const earlyGotEffect = clientEvents.early.some(e => 
            e.event === 'visual-effect-applied' && 
            e.data.effectId === 'stream_resize_half'
        );
        
        const lateGotSyncedEffect = clientEvents.late.some(e => 
            e.event === 'visual-effect-applied' && 
            e.data.effectId === 'stream_resize_half' &&
            e.data.isSyncEvent === true
        );
        
        console.log(`   Early viewer received effect: ${earlyGotEffect ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`   Late viewer received synced effect: ${lateGotSyncedEffect ? '✅ PASS' : '❌ FAIL'}`);
        
        if (earlyGotEffect && lateGotSyncedEffect) {
            console.log('\n🎉 ALL TESTS PASSED! Stream Reducer sync is working correctly.');
            console.log('   Both early and late-joining viewers receive the effect.');
        } else if (earlyGotEffect && !lateGotSyncedEffect) {
            console.log('\n⚠️  PARTIAL PASS: Effect works for early viewers but sync is broken.');
            console.log('   Late-joining viewers won\'t see active effects.');
        } else {
            console.log('\n❌ TESTS FAILED: Stream Reducer is not working properly.');
        }
        
        // Cleanup
        earlyClient.disconnect();
        lateClient.disconnect();
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
    
    server.close();
    console.log('\n✅ Test complete');
}

testStreamReducerSync().then(() => {
    process.exit(0);
}).catch(error => {
    console.error('❌ Failed:', error);
    process.exit(1);
});