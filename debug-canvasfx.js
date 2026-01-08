// Debug script for CanvasFx testing
console.log('🔍 CanvasFx Debug Script Loaded');
console.log('===============================');
console.log('');
console.log('🧰 Available Debug Commands:');
console.log('1. toggleCanvasDebug() - Toggle debug mode');
console.log('2. triggerTestEffect() - Manually trigger a test effect');
console.log('3. checkCanvasFxStatus() - Check system status');
console.log('');

// Add test functions to window
window.triggerTestEffect = function() {
    console.log('🎨 Manually triggering test tomato effect...');
    
    // Simulate a tomato effect trigger via socket
    const socket = window.socket || (window.App && window.App.socket);
    
    if (socket) {
        const testEffect = {
            id: `manual_test_${Date.now()}`,
            userId: 'debug',
            itemId: 'tomato',
            itemName: 'tomato',
            displayName: 'Debug Tomato',
            emoji: '🍅',
            type: 'splat',
            duration: 3000,
            config: {
                color: '#ff4444',
                splashColor: '#cc0000',
                particles: 12,
                size: 'large',
                animation: 'splat',
                drip: true
            },
            startTime: Date.now(),
            position: { 
                x: 0.3 + Math.random() * 0.4, // Center area
                y: 0.3 + Math.random() * 0.4 
            }
        };
        
        // Emit the effect directly to test the client-side rendering
        socket.emit('canvas-effect-trigger', testEffect);
        console.log('✅ Test effect emitted:', testEffect);
    } else {
        console.warn('⚠️ Socket not found. Effect cannot be triggered.');
    }
};

window.checkCanvasFxStatus = function() {
    console.log('📊 CanvasFx System Status:');
    console.log('========================');
    
    // Check if debug functions exist
    console.log('toggleCanvasDebug available:', typeof window.toggleCanvasDebug === 'function');
    
    // Check for canvas elements
    const canvases = document.querySelectorAll('canvas.effect-overlay-canvas');
    console.log('Effect overlay canvases found:', canvases.length);
    
    // Check for debug panels
    const debugPanels = document.querySelectorAll('.canvas-debug-info');
    console.log('Debug panels visible:', debugPanels.length);
    
    // Check socket connection
    const socket = window.socket || (window.App && window.App.socket);
    console.log('Socket connected:', socket && socket.connected);
    
    if (debugPanels.length > 0) {
        console.log('✅ Debug mode is ACTIVE');
    } else {
        console.log('⚠️ Debug mode is INACTIVE');
        console.log('Try: toggleCanvasDebug() or Ctrl+Shift+D');
    }
};

console.log('🎯 Quick Test Instructions:');
console.log('1. Open the OneStreamer app');
console.log('2. Run: toggleCanvasDebug()');
console.log('3. Look for debug panel in top-right');
console.log('4. Click on video area to test effects');
console.log('5. Or run: triggerTestEffect()');
console.log('');
console.log('📋 Troubleshooting:');
console.log('- Run checkCanvasFxStatus() to diagnose issues');
console.log('- Check browser console for error messages');
console.log('- Ensure you are viewing the stream (WebRTCViewer must be active)');

// Auto-run status check
setTimeout(() => {
    if (typeof window.checkCanvasFxStatus === 'function') {
        console.log('');
        window.checkCanvasFxStatus();
    }
}, 2000);