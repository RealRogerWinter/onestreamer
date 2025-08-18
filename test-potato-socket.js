const io = require('socket.io-client');

// Connect to the server
const socket = io('http://localhost:8080');

socket.on('connect', () => {
    console.log('✅ Connected to server');
    
    // Listen for visual effect events
    socket.on('visual-effect-applied', (data) => {
        console.log('📡 Received visual-effect-applied:', data);
    });
    
    socket.on('visual-effect-removed', (data) => {
        console.log('📡 Received visual-effect-removed:', data);
    });
    
    // Simulate applying Potato effect
    setTimeout(() => {
        console.log('🥔 Simulating Potato effect application...');
        
        // This would normally be triggered by using the item
        // For testing, we'll emit a test event
        socket.emit('test-visual-effect', {
            effectId: 'bitrate_potato',
            duration: 5000
        });
    }, 2000);
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
});

socket.on('error', (error) => {
    console.error('Socket error:', error);
});

// Keep the script running
setTimeout(() => {
    console.log('Test complete');
    process.exit(0);
}, 10000);