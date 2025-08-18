const axios = require('axios');
const io = require('socket.io-client');

// Configuration
const MAIN_SERVER_URL = 'http://localhost:8080';
const CHAT_SERVICE_URL = 'http://localhost:8081';
const AUTH_TOKEN = '***REMOVED-JWT***';

let chatMessages = [];

async function connectToChatAndMonitor() {
    return new Promise((resolve) => {
        const chatSocket = io(CHAT_SERVICE_URL, {
            transports: ['websocket'],
            auth: { token: AUTH_TOKEN }
        });

        chatSocket.on('connect', () => {
            console.log('✅ Connected to chat service');
        });

        chatSocket.on('new-message', (message) => {
            if (message.message && message.message.includes('TTS')) {
                console.log(`📨 CHAT MESSAGE: [${new Date().toISOString()}] ${message.username}: ${message.message}`);
                chatMessages.push({
                    timestamp: new Date().toISOString(),
                    username: message.username,
                    message: message.message
                });
            }
        });

        setTimeout(resolve, 1000); // Give time to connect
    });
}

async function sendTTSViaAdmin() {
    console.log('\n🎯 TEST 1: Sending TTS via /tts admin command...');
    chatMessages = [];
    
    try {
        await axios.post(`${MAIN_SERVER_URL}/api/soundfx/tts`, {
            text: 'Test TTS from admin command',
            voiceId: 'alloy'
        }, {
            headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
        });
        
        console.log('✅ TTS request sent via admin command');
    } catch (error) {
        console.error('❌ Failed to send TTS:', error.message);
    }
    
    // Wait to collect messages
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`\n📊 Messages received in chat: ${chatMessages.length}`);
    chatMessages.forEach((msg, i) => {
        console.log(`  ${i + 1}. ${msg.message}`);
    });
    
    if (chatMessages.length > 1) {
        console.log('⚠️ DUPLICATE DETECTED: Multiple TTS messages in chat!');
    }
}

async function sendTTSViaMegaphone() {
    console.log('\n🎯 TEST 2: Sending TTS via megaphone item...');
    chatMessages = [];
    
    try {
        // First get the megaphone item ID
        const itemsResponse = await axios.get(`${MAIN_SERVER_URL}/api/items`, {
            headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
        });
        
        const megaphone = itemsResponse.data.find(item => item.name === 'megaphone');
        if (!megaphone) {
            console.log('❌ Megaphone item not found');
            return;
        }
        
        // Use the megaphone item
        await axios.post(`${MAIN_SERVER_URL}/api/soundfx/item/tts`, {
            itemId: megaphone.id,
            text: 'Test TTS from megaphone item',
            voiceId: 'alloy'
        }, {
            headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
        });
        
        console.log('✅ TTS request sent via megaphone item');
    } catch (error) {
        console.error('❌ Failed to send TTS via megaphone:', error.message);
    }
    
    // Wait to collect messages
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`\n📊 Messages received in chat: ${chatMessages.length}`);
    chatMessages.forEach((msg, i) => {
        console.log(`  ${i + 1}. ${msg.message}`);
    });
    
    if (chatMessages.length > 1) {
        console.log('⚠️ DUPLICATE DETECTED: Multiple TTS messages in chat!');
    }
}

async function main() {
    console.log('🔍 TTS Duplicate Detection Test');
    console.log('================================\n');
    
    // Connect to chat service
    await connectToChatAndMonitor();
    
    // Test admin command
    await sendTTSViaAdmin();
    
    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 12000)); // Wait for TTS cooldown
    
    // Test megaphone item
    await sendTTSViaMegaphone();
    
    console.log('\n✅ Test complete');
    process.exit(0);
}

main().catch(console.error);