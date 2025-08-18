/**
 * Test script to verify StreamerViewManager is working
 * This simulates a visual-effect-applied event being sent to test the handler
 */

const io = require('socket.io-client');

async function testStreamerViewManager() {
  console.log('🎬 TEST: Starting StreamerViewManager test...');
  
  // Connect as authenticated client
  const token = process.env.AUTH_TOKEN || 'test-token';
  const socket = io('http://localhost:3000', {
    transports: ['websocket', 'polling'],
    auth: {
      token: token
    }
  });

  socket.on('connect', () => {
    console.log('🔌 TEST: Connected to server, socket ID:', socket.id);
    
    // Wait a moment then emit test event
    setTimeout(() => {
      console.log('🎨 TEST: Emitting test visual-effect-applied event...');
      
      // Emit event that should trigger StreamerViewManager
      socket.emit('visual-effect-applied', {
        effectId: 'resolution_240p',
        effectName: 'Low Resolution (240p)',
        duration: 15000,
        streamId: socket.id,
        applyToStreamer: true,
        isStreamerPreview: true,
        requiresViewSwitch: true
      });
      
      console.log('✅ TEST: Test event sent! Check browser console for StreamerViewManager logs.');
      
      // Disconnect after test
      setTimeout(() => {
        socket.disconnect();
        process.exit(0);
      }, 2000);
      
    }, 1000);
  });

  socket.on('connect_error', (error) => {
    console.error('❌ TEST: Connection failed:', error);
    process.exit(1);
  });

  socket.on('disconnect', () => {
    console.log('🔌 TEST: Disconnected from server');
  });
}

testStreamerViewManager().catch(console.error);