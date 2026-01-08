const io = require('socket.io-client');
const axios = require('axios');

const CHAT_SERVICE_URL = 'http://localhost:8081';

async function testAdminTTS() {
    // First login to get token
    const loginResponse = await axios.post('http://localhost:8080/auth/login', {
        email: 'user@example.com',
        password: '***REMOVED-ADMIN-KEY***'
    });
    
    const token = loginResponse.data.token;
    console.log('✅ Logged in successfully\n');
    
    return new Promise((resolve) => {
        const chatSocket = io(CHAT_SERVICE_URL, {
            transports: ['websocket'],
            auth: { token }
        });

        chatSocket.on('connect', () => {
            console.log('✅ Connected to chat service');
            console.log('📢 Sending /tts command...\n');
            
            // Send the /tts command
            chatSocket.emit('admin-command', {
                command: 'tts',
                args: ['Testing', 'admin', 'TTS', 'command', 'for', 'duplicates']
            });
        });

        chatSocket.on('new-message', (message) => {
            if (message.message && message.message.includes('TTS')) {
                console.log(`📨 Received: ${message.username}: ${message.message}`);
                console.log(`   ID: ${message.id}\n`);
            }
            
            // Admin response message
            if (message.message && message.message.includes('TTS message sent')) {
                console.log(`📨 Admin Response: ${message.message}\n`);
                setTimeout(() => {
                    chatSocket.disconnect();
                    resolve();
                }, 2000);
            }
        });

        chatSocket.on('error', (error) => {
            console.error('Error:', error);
        });
    });
}

testAdminTTS()
    .then(() => {
        console.log('✅ Test complete');
        process.exit(0);
    })
    .catch(console.error);