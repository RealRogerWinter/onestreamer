// Test script to manually trigger visual-effect-applied event
// Run this in browser console to test if the client-side visual effects work

function testVisualEffectEvent() {
    console.log('🧪 Testing visual-effect-applied socket event...');
    
    if (!window.socket) {
        console.error('❌ No socket connection found. Make sure you are connected to the server.');
        return;
    }
    
    // Simulate the visual-effect-applied event
    const testEventData = {
        effectId: 'stream_resize_half',
        duration: 10000, // 10 seconds
        applyToStreamer: true,
        isStreamerPreview: true,
        streamId: 'test_stream_123',
        effectConfig: {
            type: 'resize',
            parameters: {
                scale: 0.5,
                position: 'center'
            }
        }
    };
    
    console.log('🎬 Emitting test visual-effect-applied event:', testEventData);
    
    // Emit the event to test client-side handling
    window.socket.emit('visual-effect-applied', testEventData);
    
    // Also trigger it locally to bypass server
    console.log('🎬 Also triggering local event handler...');
    window.socket.listeners('visual-effect-applied').forEach(listener => {
        try {
            listener(testEventData);
        } catch (error) {
            console.error('❌ Error in event listener:', error);
        }
    });
    
    console.log('✅ Test event triggered. Check for visual effect logs above.');
}

function checkSocketListeners() {
    console.log('🔍 Checking socket event listeners...');
    
    if (!window.socket) {
        console.error('❌ No socket connection found');
        return;
    }
    
    const listeners = window.socket.listeners('visual-effect-applied');
    console.log(`📡 Found ${listeners.length} listeners for 'visual-effect-applied' event`);
    
    if (listeners.length === 0) {
        console.warn('⚠️ No listeners found for visual-effect-applied event!');
        console.log('💡 This means the useVisualFxProcessor hook is not set up correctly');
    } else {
        console.log('✅ Event listeners are set up correctly');
    }
    
    // Check all socket events
    console.log('🔍 All socket event listeners:');
    const eventNames = window.socket.eventNames();
    eventNames.forEach(eventName => {
        const eventListeners = window.socket.listeners(eventName);
        console.log(`   ${eventName}: ${eventListeners.length} listeners`);
    });
}

function findVideoElements() {
    console.log('🎬 Finding video elements on page...');
    
    const videos = document.querySelectorAll('video');
    console.log(`Found ${videos.length} video elements:`);
    
    videos.forEach((video, index) => {
        console.log(`   Video ${index + 1}:`);
        console.log(`     Element:`, video);
        console.log(`     Size: ${video.clientWidth}x${video.clientHeight}`);
        console.log(`     Current transform: "${video.style.transform}"`);
        console.log(`     Computed transform: "${getComputedStyle(video).transform}"`);
        console.log(`     Classes: "${video.className}"`);
        console.log(`     Parent classes: "${video.parentElement?.className}"`);
    });
}

function testDirectTransform() {
    console.log('🎨 Testing direct transform on video elements...');
    
    const videos = document.querySelectorAll('video');
    if (videos.length === 0) {
        console.warn('⚠️ No video elements found');
        return;
    }
    
    videos.forEach((video, index) => {
        console.log(`Applying scale(0.5) to video ${index + 1}`);
        video.style.transform = 'scale(0.5)';
        
        setTimeout(() => {
            console.log(`Removing transform from video ${index + 1}`);
            video.style.transform = '';
        }, 5000);
    });
}

// Export functions to window for easy access
window.testVisualEffectEvent = testVisualEffectEvent;
window.checkSocketListeners = checkSocketListeners;
window.findVideoElements = findVideoElements;
window.testDirectTransform = testDirectTransform;

console.log('🧪 Visual effect test functions loaded!');
console.log('Available functions:');
console.log('  testVisualEffectEvent() - Test the visual-effect-applied event');
console.log('  checkSocketListeners() - Check if socket listeners are set up');
console.log('  findVideoElements() - Find and inspect video elements');
console.log('  testDirectTransform() - Apply direct CSS transform to videos');
console.log('');
console.log('💡 Run checkSocketListeners() first to verify setup');
console.log('💡 Then run testVisualEffectEvent() to test the effect');