const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const VisualFxService = require('./server/services/VisualFxService');

async function testSocketEmission() {
    console.log('🧪 Testing Socket Emission for Stream Reducer\n');
    
    // Create minimal server
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });
    
    // Initialize VisualFxService with mock socket
    const visualFxService = new VisualFxService();
    visualFxService.setDependencies(null, null, null, io);
    
    // Capture socket emissions
    const emittedEvents = [];
    const originalEmit = io.emit;
    io.emit = function(eventName, data) {
        console.log(`📡 EMIT: ${eventName}`, JSON.stringify(data, null, 2));
        emittedEvents.push({ event: eventName, data });
        return originalEmit.call(this, eventName, data);
    };
    
    try {
        console.log('1. Testing applyEffect for stream_resize_half...');
        
        const effect = await visualFxService.applyEffect('test_stream_123', 'stream_resize_half', {
            duration: 60000,
            triggeredByBuff: true
        });
        
        console.log('\n2. Effect returned:', effect ? 'SUCCESS' : 'FAILED');
        if (effect) {
            console.log('   Effect ID:', effect.id);
            console.log('   Effect Type:', effect.config.type);
            console.log('   Effect Duration:', effect.duration);
        }
        
        console.log('\n3. Emitted Events:');
        emittedEvents.forEach((emission, index) => {
            console.log(`   Event ${index + 1}:`, emission.event);
            console.log('   Data:', JSON.stringify(emission.data, null, 4));
        });
        
        // Specifically check for the visual-effect-applied event
        const visualEffectEvent = emittedEvents.find(e => e.event === 'visual-effect-applied');
        
        console.log('\n4. Analysis:');
        if (visualEffectEvent) {
            console.log('✅ visual-effect-applied event found');
            console.log('   effectId:', visualEffectEvent.data.effectId);
            console.log('   effectConfig type:', visualEffectEvent.data.effectConfig?.type);
            console.log('   applyToAllViewers:', visualEffectEvent.data.applyToAllViewers);
            console.log('   applyToStreamer:', visualEffectEvent.data.applyToStreamer);
            console.log('   isStreamerPreview:', visualEffectEvent.data.isStreamerPreview);
            
            if (visualEffectEvent.data.effectConfig?.type === 'resize') {
                console.log('✅ Effect type is correct (resize)');
            } else {
                console.log('❌ Effect type is wrong:', visualEffectEvent.data.effectConfig?.type);
            }
        } else {
            console.log('❌ visual-effect-applied event NOT found');
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
    
    server.close();
    console.log('\n✅ Test complete');
}

testSocketEmission().then(() => {
    process.exit(0);
}).catch(error => {
    console.error('❌ Failed:', error);
    process.exit(1);
});