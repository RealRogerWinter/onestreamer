#!/usr/bin/env node

/**
 * Test ViewBot rotation trigger
 */

const io = require('socket.io-client');

// Connect to the server
const socket = io('http://localhost:8080', {
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});

socket.on('connect', () => {
  console.log('✅ Connected to server');
  
  // Send admin command to trigger rotation
  socket.emit('admin-command', {
    command: 'force-viewbot-rotation',
    key: 'REDACTED-ADMIN-KEY' // You may need to update this key
  });
  
  console.log('📤 Sent command to force rotation');
  
  // Also listen for any admin responses
  socket.on('admin-response', (data) => {
    console.log('📥 Server response:', JSON.stringify(data, null, 2));
  });
  
  // Also listen for errors
  socket.on('admin-error', (data) => {
    console.error('❌ Admin error:', data);
  });
  
  // Exit after 5 seconds
  setTimeout(() => {
    console.log('✅ Test complete');
    process.exit(0);
  }, 5000);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
  // Try to reconnect
  setTimeout(() => {
    console.log('🔄 Retrying connection...');
    socket.connect();
  }, 1000);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});