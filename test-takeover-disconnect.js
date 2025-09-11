#!/usr/bin/env node

/**
 * Test script to verify takeover behavior
 * 
 * Expected behavior:
 * 1. User1 starts streaming
 * 2. User2 takes over
 * 3. User1 should be completely disconnected (socket closed)
 * 4. When User2 stops, User1 should NOT automatically resume
 */

const io = require('socket.io-client');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

// Create two test clients
let user1Socket = null;
let user2Socket = null;

function connectUser1() {
  console.log('🔵 Connecting User1...');
  user1Socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: true,  // Allow reconnection to test if it happens
    reconnectionAttempts: 3,
    reconnectionDelay: 1000
  });

  user1Socket.on('connect', () => {
    console.log('✅ User1 connected:', user1Socket.id);
    
    // Start streaming as User1
    console.log('🎥 User1 attempting to start stream...');
    user1Socket.emit('request-stream', { streamType: 'webrtc' });
  });

  user1Socket.on('streaming-approved', () => {
    console.log('✅ User1 streaming approved');
    console.log('⏰ Waiting 3 seconds before User2 takeover...');
    
    // After 3 seconds, have User2 take over
    setTimeout(() => {
      connectUser2();
    }, 3000);
  });

  user1Socket.on('stream-takeover', (data) => {
    console.log('⚠️ User1 received takeover notification:', data);
  });

  user1Socket.on('force-disconnect', (data) => {
    console.log('🔴 User1 received force-disconnect:', data);
  });

  user1Socket.on('disconnect', (reason) => {
    console.log('❌ User1 disconnected. Reason:', reason);
    console.log('   Socket connected:', user1Socket.connected);
  });

  user1Socket.on('error', (error) => {
    console.log('❌ User1 socket error:', error);
  });

  user1Socket.on('stream-ended', (data) => {
    console.log('📺 User1 received stream-ended:', data);
  });

  // Monitor reconnection attempts
  user1Socket.on('reconnect_attempt', (attemptNumber) => {
    console.log(`🔄 User1 reconnection attempt #${attemptNumber}`);
  });

  user1Socket.on('reconnect', (attemptNumber) => {
    console.log(`✅ User1 reconnected after ${attemptNumber} attempts`);
    console.log('⚠️ WARNING: User1 should NOT reconnect after takeover!');
  });

  user1Socket.on('reconnect_failed', () => {
    console.log('❌ User1 reconnection failed (expected behavior)');
  });
}

function connectUser2() {
  console.log('\n🟢 Connecting User2...');
  user2Socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: false
  });

  user2Socket.on('connect', () => {
    console.log('✅ User2 connected:', user2Socket.id);
    
    // Request takeover as User2
    console.log('🎬 User2 requesting takeover...');
    user2Socket.emit('request-takeover', { streamType: 'webrtc' });
  });

  user2Socket.on('takeover-approved', () => {
    console.log('✅ User2 takeover approved');
    
    // Check User1's connection status
    setTimeout(() => {
      console.log('\n📊 Connection Status Check:');
      console.log('   User1 connected:', user1Socket.connected);
      console.log('   User2 connected:', user2Socket.connected);
      
      if (user1Socket.connected) {
        console.log('❌ ERROR: User1 is still connected after takeover!');
      } else {
        console.log('✅ PASS: User1 properly disconnected after takeover');
      }
      
      // After 3 seconds, disconnect User2
      console.log('\n⏰ Waiting 3 seconds before User2 stops streaming...');
      setTimeout(() => {
        console.log('🛑 User2 stopping stream...');
        user2Socket.emit('stop-streaming');
        
        // Wait and check if User1 auto-reconnects
        setTimeout(() => {
          console.log('\n📊 Final Status Check:');
          console.log('   User1 connected:', user1Socket.connected);
          console.log('   User2 connected:', user2Socket.connected);
          
          if (user1Socket.connected) {
            console.log('❌ FAIL: User1 reconnected after User2 stopped!');
          } else {
            console.log('✅ PASS: User1 remained disconnected (expected)');
          }
          
          // Clean up
          setTimeout(() => {
            console.log('\n🧹 Cleaning up...');
            if (user1Socket.connected) user1Socket.disconnect();
            if (user2Socket.connected) user2Socket.disconnect();
            process.exit(0);
          }, 2000);
        }, 3000);
      }, 3000);
    }, 1000);
  });

  user2Socket.on('takeover-denied', (data) => {
    console.log('❌ User2 takeover denied:', data);
  });

  user2Socket.on('disconnect', (reason) => {
    console.log('❌ User2 disconnected. Reason:', reason);
  });
}

// Start the test
console.log('🧪 Starting Takeover Disconnect Test');
console.log('   Server:', SERVER_URL);
console.log('');

connectUser1();

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted, cleaning up...');
  if (user1Socket) user1Socket.disconnect();
  if (user2Socket) user2Socket.disconnect();
  process.exit(0);
});