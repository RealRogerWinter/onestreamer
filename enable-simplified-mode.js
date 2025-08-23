#!/usr/bin/env node

/**
 * Enable simplified streaming mode to bypass media pipeline issues
 * This allows the rotation system to work with probability-based checks
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
  
  // Enable simplified mode
  socket.emit('debug-command', {
    command: 'enable-simplified-mode'
  });
  
  // Request status
  setTimeout(() => {
    socket.emit('debug-command', {
      command: 'rotation-status'
    });
  }, 2000);
  
  // Exit after 5 seconds
  setTimeout(() => {
    console.log('✅ Simplified mode enabled, rotation system should now work');
    process.exit(0);
  }, 5000);
});

socket.on('debug-response', (data) => {
  console.log('Server response:', data);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
  process.exit(1);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});