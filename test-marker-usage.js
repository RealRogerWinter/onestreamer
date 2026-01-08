const io = require('socket.io-client');
const { getAsync } = require('./server/database/database');

async function testMarkerUsage() {
    try {
        console.log('🎨 Testing Marker item usage...\n');
        
        // Get marker item details
        const marker = await getAsync(
            'SELECT * FROM items WHERE name = ?',
            ['marker']
        );
        
        if (!marker) {
            console.log('❌ Marker item not found in database');
            process.exit(1);
        }
        
        console.log('✅ Found Marker item:', marker.display_name, marker.emoji);
        console.log('  Item ID:', marker.id);
        
        // Connect to server
        const socket = io('http://localhost:8080', {
            auth: {
                token: '***REMOVED-JWT***'
            }
        });
        
        socket.on('connect', () => {
            console.log('📡 Connected to server:', socket.id);
            
            // Use the marker item
            console.log('\n🎯 Using Marker item...');
            socket.emit('use-item', {
                itemId: marker.id,
                targetUserId: 3 // Target self for testing
            });
        });
        
        socket.on('item-used', (data) => {
            console.log('✅ Item used successfully:', data);
        });
        
        socket.on('item-use-error', (error) => {
            console.log('❌ Item use error:', error);
        });
        
        socket.on('canvas-effect-trigger', (effect) => {
            console.log('🎨 Canvas effect triggered:', {
                id: effect.id,
                type: effect.type,
                itemName: effect.itemName,
                phaseName: effect.config?.phaseName,
                duration: effect.duration,
                position: effect.position
            });
        });
        
        socket.on('canvas-effect-mode', (data) => {
            console.log('🖱️ Canvas interaction mode:', data);
        });
        
        socket.on('interactive-mode', (data) => {
            console.log('🎮 Interactive mode activated:', data);
        });
        
        socket.on('error', (error) => {
            console.error('❌ Socket error:', error);
        });
        
        // Keep script running for 5 seconds to see the effects
        setTimeout(() => {
            console.log('\n✅ Test completed');
            socket.disconnect();
            process.exit(0);
        }, 5000);
        
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

testMarkerUsage();