// Test script to verify visual-effect-applied event flow
const io = require('socket.io-client');

console.log('🧪 Testing Visual Effect Event Flow\n');
console.log('=' .repeat(50));

// Connect to the socket server
const socket = io('http://localhost:8080', {
    transports: ['websocket'],
    reconnection: true
});

let eventsReceived = [];

socket.on('connect', () => {
    console.log('✅ Connected to server');
    console.log('Socket ID:', socket.id);
    console.log('\n📡 Listening for visual effect events...\n');
});

// Listen for visual-effect-applied events
socket.on('visual-effect-applied', (data) => {
    console.log('🎬 RECEIVED: visual-effect-applied');
    console.log('  Data:', JSON.stringify(data, null, 2));
    console.log('  isStreamerPreview:', data.isStreamerPreview);
    console.log('  effectId:', data.effectId);
    console.log('  duration:', data.duration);
    console.log('  streamId:', data.streamId);
    console.log('-'.repeat(50));
    
    eventsReceived.push(data);
});

// Listen for any visual effect related events
socket.onAny((eventName, ...args) => {
    if (eventName.includes('visual')) {
        console.log(`📨 ANY EVENT: ${eventName}`);
        console.log('  Args:', args);
        console.log('-'.repeat(30));
    }
});

// Listen for buff events
socket.on('buff-applied', (data) => {
    console.log('💊 BUFF APPLIED:', data.item_name);
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
});

socket.on('connect_error', (error) => {
    console.error('Connection error:', error.message);
});

// Keep the script running
console.log('\n📋 Instructions:');
console.log('1. Start the server in another terminal: npm run dev');
console.log('2. Start a stream');
console.log('3. Use the Potato item on the stream');
console.log('4. Watch this console for events\n');
console.log('Press Ctrl+C to exit\n');

// Exit handler
process.on('SIGINT', () => {
    console.log('\n\n📊 Summary:');
    console.log(`Total events received: ${eventsReceived.length}`);
    eventsReceived.forEach((event, i) => {
        console.log(`  ${i + 1}. ${event.effectId} - isStreamerPreview: ${event.isStreamerPreview}`);
    });
    process.exit(0);
});