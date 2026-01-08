#!/usr/bin/env node

/**
 * Enable ViewBot rotation system
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
  
  // Enable rotation
  socket.emit('debug-command', {
    command: 'toggle-rotation',
    enabled: true
  });
  
  console.log('📤 Sent command to enable rotation');
  
  // Exit after 2 seconds
  setTimeout(() => {
    console.log('✅ Rotation should now be enabled');
    process.exit(0);
  }, 2000);
});

socket.on('debug-response', (data) => {
  console.log('📥 Server response:', data);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
  process.exit(1);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});