const { runAsync, getAsync, allAsync } = require('./server/database/database');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');
const EventEmitter = require('events');

// Create a mock io object
const mockIo = {
    emit: (event, data) => {
        console.log(`📡 Socket.IO emit: ${event}`, JSON.stringify(data, null, 2));
    },
    to: () => mockIo,
    engine: { clientsCount: 1 },
    sockets: true
};

(async () => {
    console.log('🧪 Testing VisualFX Event Chain\n');
    console.log('================================\n');
    
    // Initialize services
    const buffService = new BuffDebuffService();
    const visualFxService = new VisualFxService();
    
    // Set up dependencies
    buffService.setDependencies(mockIo, null, null);
    visualFxService.setDependencies(null, buffService, null, mockIo, null, null);
    
    console.log('✅ Services initialized and dependencies set\n');
    
    // Check if buff-applied listener is registered
    const buffListeners = buffService.listeners('buff-applied');
    console.log(`📊 BuffDebuffService has ${buffListeners.length} listeners for 'buff-applied' event`);
    
    const visualFxListeners = buffService.listeners('buff-applied').filter(
        listener => listener.name && listener.name.includes('bound')
    );
    console.log(`📊 VisualFxService listener registered: ${visualFxListeners.length > 0}\n`);
    
    // Get an emboss item to test with
    const embossItem = await getAsync('SELECT * FROM items WHERE name = ?', ['emboss']);
    if (!embossItem) {
        console.error('❌ Emboss item not found in database');
        process.exit(1);
    }
    
    console.log(`🎨 Found item: ${embossItem.display_name} (${embossItem.name})`);
    console.log(`   Type: ${embossItem.item_type}`);
    console.log(`   Effect data: ${embossItem.effect_data}\n`);
    
    // Set up event listener to verify the chain
    let eventReceived = false;
    visualFxService.on('effect-applied', (data) => {
        console.log('✅ VisualFxService emitted effect-applied event:', data);
        eventReceived = true;
    });
    
    // Test 1: Direct event emission
    console.log('📝 Test 1: Direct event emission from BuffDebuffService\n');
    
    const testBuffData = {
        id: 999,
        user_id: 1,
        item_id: embossItem.id,
        item_name: embossItem.name,
        display_name: embossItem.display_name,
        emoji: embossItem.emoji,
        buff_type: embossItem.item_type,
        duration_seconds: embossItem.duration_seconds || 30,
        remaining_seconds: embossItem.duration_seconds || 30,
        effect_data: embossItem.effect_data,
        stream_id: 'test-stream-123'
    };
    
    console.log('🔥 Emitting buff-applied event with data:', {
        item_name: testBuffData.item_name,
        user_id: testBuffData.user_id,
        stream_id: testBuffData.stream_id
    });
    
    // Emit the event directly
    buffService.emit('buff-applied', testBuffData);
    
    // Give it a moment to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (eventReceived) {
        console.log('\n✅ SUCCESS: Event chain is working!\n');
    } else {
        console.log('\n❌ FAILURE: Event was not received by VisualFxService\n');
    }
    
    // Test 2: Check handleBuffApplied directly
    console.log('📝 Test 2: Call handleBuffApplied directly\n');
    
    try {
        await visualFxService.handleBuffApplied(testBuffData);
        console.log('✅ handleBuffApplied executed successfully\n');
    } catch (error) {
        console.error('❌ handleBuffApplied failed:', error.message);
    }
    
    // Check active effects
    const activeEffects = visualFxService.getActiveEffects();
    console.log(`📊 Active effects in VisualFxService: ${activeEffects.length}`);
    activeEffects.forEach(effect => {
        console.log(`   - ${effect.effectId} on stream ${effect.streamId}`);
    });
    
    process.exit(0);
})();