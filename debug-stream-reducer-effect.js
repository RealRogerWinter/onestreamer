const VisualFxService = require('./server/services/VisualFxService');

async function debugStreamReducerEffect() {
    console.log('🔍 DEBUG: Stream Reducer Effect Configuration\n');
    
    // Initialize VisualFxService
    const visualFxService = new VisualFxService();
    
    // Check if stream_resize_half effect is registered
    const effectRegistry = visualFxService.getEffectRegistry();
    const resizeEffect = effectRegistry.find(effect => effect.id === 'stream_resize_half');
    
    console.log('1. Effect Registry Check:');
    if (resizeEffect) {
        console.log('✅ stream_resize_half effect found in registry');
        console.log('   ID:', resizeEffect.id);
        console.log('   Type:', resizeEffect.type);
        console.log('   Duration:', resizeEffect.duration);
        console.log('   Parameters:', resizeEffect.parameters);
    } else {
        console.log('❌ stream_resize_half effect NOT found in registry');
    }
    
    // Check mapping
    console.log('\n2. Effect Mapping Check:');
    console.log('   stream_reducer should map to stream_resize_half');
    
    // Try to trigger the handleBuffApplied logic
    console.log('\n3. Simulating handleBuffApplied...');
    const testBuffData = {
        item_name: 'stream_reducer',
        stream_id: 'test_stream_123',
        user_id: 1,
        duration_seconds: 60
    };
    
    // Check mapping logic
    const effectMapping = {
        'lag_spike': 'packet_loss_severe',
        'potato_mode': 'resolution_240p',
        'potato': 'bitrate_potato',
        'stream_reducer': 'stream_resize_half',
        'slow_motion': 'framerate_slideshow',
        'glitch_bomb': 'glitch',
        'static_storm': 'static_noise',
        'voice_modulator': 'audio_pitch_high',
        'freeze_ray': 'freeze_frame'
    };
    
    const effectId = effectMapping[testBuffData.item_name];
    console.log(`   Mapped effectId: ${effectId}`);
    
    if (effectId) {
        const mappedEffect = effectRegistry.find(effect => effect.id === effectId);
        if (mappedEffect) {
            console.log('✅ Mapped effect found in registry');
            console.log('   Effect will be applied with type:', mappedEffect.type);
        } else {
            console.log('❌ Mapped effect NOT found in registry');
        }
    }
    
    console.log('\n4. All registered effects:');
    effectRegistry.forEach(effect => {
        console.log(`   - ${effect.id} (${effect.type})`);
    });
    
    console.log('\n' + '='.repeat(50));
    console.log('SUMMARY:');
    console.log(`Effect Registry Size: ${effectRegistry.length}`);
    console.log(`Resize Effect Found: ${!!resizeEffect}`);
    console.log(`Mapping Found: ${!!effectId}`);
    console.log(`Complete Chain: ${!!(resizeEffect && effectId)}`);
}

debugStreamReducerEffect().then(() => {
    console.log('\n✅ Debug complete');
    process.exit(0);
}).catch(error => {
    console.error('❌ Debug failed:', error);
    process.exit(1);
});