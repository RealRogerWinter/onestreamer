const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting OneStreamer...\n');

// Start the main server
console.log('📡 Starting backend server...');
const server = spawn('npm', ['run', 'server'], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true
});

// Start the chat service
console.log('💬 Starting chat service...');
const chatService = spawn('npm', ['start'], {
  cwd: path.join(__dirname, 'chat-service'),
  stdio: 'inherit',
  shell: true
});

// Wait a bit for services to start, then start client
setTimeout(() => {
  console.log('\n🌐 Starting React frontend...');
  const client = spawn('npm', ['start'], {
    cwd: path.join(__dirname, 'client'),
    stdio: 'inherit',
    shell: true
  });

  client.on('error', (err) => {
    console.error('Client error:', err);
  });
}, 3000);

server.on('error', (err) => {
  console.error('Server error:', err);
});

chatService.on('error', (err) => {
  console.error('Chat service error:', err);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down OneStreamer...');
  server.kill();
  chatService.kill();
  process.exit(0);
});