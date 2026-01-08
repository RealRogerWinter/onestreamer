const axios = require('axios');
const { io: ioClient } = require('socket.io-client');

async function testChatConnection() {
    console.log('🔍 Testing Chat Service Connection...\n');
    
    const CHAT_URL = 'http://localhost:8081';
    
    // Step 1: Check if chat service is running
    console.log('1️⃣ Checking if chat service is running...');
    try {
        const response = await axios.get(`${CHAT_URL}/health`);
        console.log(`✅ Chat service is running: ${response.data.status}`);
    } catch (error) {
        console.error('❌ Chat service is NOT running on port 8081');
        console.error('   Please start it with: cd chat-service && node index.js');
        return;
    }
    
    // Step 2: Test socket connection
    console.log('\n2️⃣ Testing socket connection...');
    const socket = ioClient(CHAT_URL, {
        transports: ['websocket'],
        query: {
            isBot: true,
            botId: 'test'
        }
    });
    
    socket.on('connect', () => {
        console.log('✅ Successfully connected to chat service via WebSocket');
        console.log(`   Socket ID: ${socket.id}`);
        
        // Test joining chat
        console.log('\n3️⃣ Testing chat join...');
        socket.emit('join-chat', {
            username: '🤖 TestBot',
            color: '#FF6B6B',
            isBot: true
        });
    });
    
    socket.on('user-joined', (data) => {
        console.log('✅ Successfully joined chat');
        console.log(`   Assigned username: ${data.username}`);
        console.log(`   Color: ${data.color}`);
        
        // Test sending a message
        console.log('\n4️⃣ Sending test message...');
        socket.emit('send-message', {
            message: 'Hello from test bot! 👋'
        });
    });
    
    socket.on('new-message', (message) => {
        if (message.username === '🤖 TestBot' || message.username.includes('TestBot')) {
            console.log('✅ Message sent and received successfully!');
            console.log(`   Message: "${message.message}"`);
            console.log('\n✨ All tests passed! Chat service is working correctly.');
            
            // Disconnect
            socket.disconnect();
            process.exit(0);
        }
    });
    
    socket.on('connect_error', (error) => {
        console.error('❌ Failed to connect to chat service');
        console.error(`   Error: ${error.message}`);
        console.error('   Make sure:');
        console.error('   1. Chat service is running: cd chat-service && node index.js');
        console.error('   2. It\'s running on port 8081');
        console.error('   3. No firewall is blocking the connection');
        process.exit(1);
    });
    
    socket.on('error', (error) => {
        console.error('❌ Socket error:', error);
    });
    
    // Timeout after 5 seconds
    setTimeout(() => {
        console.error('\n⏱️ Test timed out after 5 seconds');
        console.error('   The chat service might be running but not responding correctly');
        socket.disconnect();
        process.exit(1);
    }, 5000);
}

testChatConnection();