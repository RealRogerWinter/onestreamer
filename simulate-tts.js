const SoundFxService = require('./server/services/SoundFxService');
const io = require('socket.io-client');

async function simulateTTS() {
    // Create a mock Socket.IO server instance
    const mockIO = {
        emit: (event, data) => {
            console.log(`📢 Broadcasting ${event}:`, data);
            
            // Connect to the actual server and emit the event
            const socket = io('http://localhost:8080', {
                transports: ['websocket']
            });
            
            socket.on('connect', () => {
                console.log('Connected to server, emitting sound effect...');
                socket.emit('admin-broadcast-sound', data);
                
                // Actually emit through the server's io instance would require server access
                // For now, we'll create a direct test
                setTimeout(() => {
                    socket.disconnect();
                    process.exit(0);
                }, 1000);
            });
        }
    };

    const soundFx = new SoundFxService();
    soundFx.setSocketIO(mockIO);

    console.log('🎤 Simulating TTS message...\n');

    // Queue a test TTS message
    const ttsRequest = await soundFx.queueTTS(
        'test-user-123',
        'TestUser',
        'Hello everyone! This is a test TTS message.',
        'alloy',
        { test: true }
    );

    console.log('✅ TTS queued:', ttsRequest);
    console.log('\n⏳ Processing TTS queue...');

    // Wait for processing
    setTimeout(() => {
        console.log('\n✅ Test complete');
    }, 5000);
}

simulateTTS().catch(console.error);