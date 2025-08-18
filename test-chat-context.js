const { io: ioClient } = require('socket.io-client');

async function testChatContext() {
    console.log('🧪 Testing MovieBot Chat Context...\n');
    console.log('=' .repeat(70));
    
    // Connect to chat service
    const chatSocket = ioClient('http://localhost:8081', {
        transports: ['websocket']
    });
    
    chatSocket.on('connect', () => {
        console.log('✅ Connected to chat service\n');
        
        // Join chat
        chatSocket.emit('join-chat', {
            username: 'MovieFan123',
            color: '#FF6B6B'
        });
        
        // Send test messages about the movie
        const testMessages = [
            "wow this movie is intense!",
            "I love the cinematography in this scene",
            "that actor is really good",
            "anyone know what year this was made?",
            "the soundtrack is amazing"
        ];
        
        let messageIndex = 0;
        const sendMessage = () => {
            if (messageIndex < testMessages.length) {
                const message = testMessages[messageIndex];
                console.log(`📤 Sending: "${message}"`);
                chatSocket.emit('chat-message', { message });
                messageIndex++;
                setTimeout(sendMessage, 2000); // Send every 2 seconds
            } else {
                console.log('\n✅ All test messages sent');
                console.log('⏱️ Waiting for MovieBot to process next cycle...');
                // Keep connection open to see responses
            }
        };
        
        // Start sending messages after a short delay
        setTimeout(sendMessage, 1000);
        
        // Listen for bot responses
        chatSocket.on('new-message', (msg) => {
            if (msg.username && msg.username.includes('🤖')) {
                console.log(`\n🤖 Bot Response: ${msg.username}: "${msg.message}"`);
                
                // Check if the bot is referencing our chat messages
                const ourKeywords = ['cinematography', 'soundtrack', 'intense', 'year', 'actor'];
                const referenced = ourKeywords.some(keyword => 
                    msg.message.toLowerCase().includes(keyword)
                );
                
                if (referenced) {
                    console.log('   ✅ Bot referenced our chat context!');
                }
            }
        });
    });
    
    chatSocket.on('connect_error', (error) => {
        console.error('❌ Failed to connect:', error.message);
        process.exit(1);
    });
}

testChatContext().catch(console.error);