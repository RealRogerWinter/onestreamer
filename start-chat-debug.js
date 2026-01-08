#!/usr/bin/env node

/**
 * Start chat service with debug logging
 * Run this in addition to the main server to see chat message tracking logs
 */

console.log('🚀 Starting chat service with debug logging...');
console.log('💡 Make sure the main server is also running on port 8080');

// Change to chat-service directory and start the service
const { spawn } = require('child_process');
const path = require('path');

const chatServiceDir = path.join(__dirname, 'chat-service');

const chatProcess = spawn('node', ['index.js'], {
  cwd: chatServiceDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development'
  }
});

chatProcess.on('error', (error) => {
  console.error('❌ Failed to start chat service:', error);
  process.exit(1);
});

chatProcess.on('exit', (code) => {
  console.log(`💬 Chat service exited with code ${code}`);
  process.exit(code);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down chat service...');
  chatProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down chat service...');
  chatProcess.kill('SIGTERM');
});