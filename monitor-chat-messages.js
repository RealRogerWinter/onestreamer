const io = require('socket.io-client');

const CHAT_SERVICE_URL = 'http://localhost:8081';

console.log('📡 Connecting to chat service to monitor messages...\n');

const chatSocket = io(CHAT_SERVICE_URL, {
    transports: ['websocket']
});

let messageCount = 0;
let ttsMessages = [];

chatSocket.on('connect', () => {
    console.log('✅ Connected to chat service\n');
    console.log('Monitoring for TTS messages...\n');
});

chatSocket.on('new-message', (message) => {
    messageCount++;
    
    // Check if it's a TTS message
    if (message.message && message.message.includes('TTS')) {
        ttsMessages.push(message);
        console.log(`📨 TTS MESSAGE #${ttsMessages.length}:`);
        console.log(`   Time: ${new Date().toISOString()}`);
        console.log(`   From: ${message.username}`);
        console.log(`   Text: ${message.message}`);
        console.log(`   Message ID: ${message.id}`);
        console.log('');
        
        // Check for duplicates
        const duplicates = ttsMessages.filter(m => 
            m.message === message.message && 
            m.id !== message.id
        );
        
        if (duplicates.length > 0) {
            console.log('⚠️  DUPLICATE DETECTED! Same message content with different IDs');
            console.log(`   Original ID: ${duplicates[0].id}`);
            console.log(`   Duplicate ID: ${message.id}`);
            console.log('');
        }
    }
});

chatSocket.on('disconnect', () => {
    console.log('❌ Disconnected from chat service');
});

chatSocket.on('error', (error) => {
    console.error('Error:', error);
});

// Keep the script running
console.log('Press Ctrl+C to stop monitoring\n');