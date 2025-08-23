/**
 * Simple test to monitor stream events
 */

const io = require('socket.io-client');

const SERVER_URL = 'https://127.0.0.1:8443';
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

console.log('🎯 Stream Events Monitor\n');

const socket = io(SERVER_URL, {
  transports: ['websocket'],
  rejectUnauthorized: false
});

socket.on('connect', () => {
  console.log('✅ Connected to server\n');
  console.log('📡 Listening for events...\n');
});

// Monitor all stream-related events
socket.on('stream-ready', (data) => {
  console.log('🎬 STREAM-READY:', JSON.stringify(data, null, 2));
});

socket.on('stream-ending', (data) => {
  console.log('🛑 STREAM-ENDING:', JSON.stringify(data, null, 2));
});

socket.on('stream-ended', (data) => {
  console.log('⏹️ STREAM-ENDED:', JSON.stringify(data, null, 2));
});

socket.on('new-streamer', (data) => {
  console.log('🆕 NEW-STREAMER:', JSON.stringify(data, null, 2));
});

socket.on('viewbot-streaming', (data) => {
  console.log('🤖 VIEWBOT-STREAMING:', JSON.stringify(data, null, 2));
});

socket.on('viewbot-stopped', (data) => {
  console.log('🤖 VIEWBOT-STOPPED:', JSON.stringify(data, null, 2));
});

socket.on('error', (error) => {
  console.error('❌ Socket error:', error);
});

// Keep running
setInterval(() => {
  process.stdout.write('.');
}, 5000);

console.log('Press Ctrl+C to exit\n');