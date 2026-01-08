const io = require('socket.io-client');

// Connect multiple clients to simulate multiple viewers
const clients = [];
const NUM_CLIENTS = 3;

function connectClient(id) {
    return new Promise((resolve) => {
        const socket = io('http://localhost:8080', {
            transports: ['websocket'],
            auth: {
                token: null // Anonymous connection for testing
            }
        });

        socket.on('connect', () => {
            console.log(`✅ Client ${id} connected: ${socket.id}`);
            
            // Listen for sound effects
            socket.on('sound-effect-play', (effect) => {
                console.log(`🔊 Client ${id} received sound effect:`, {
                    type: effect.type,
                    text: effect.text || 'N/A',
                    username: effect.username,
                    timestamp: new Date(effect.timestamp).toLocaleTimeString()
                });
            });

            resolve(socket);
        });

        socket.on('disconnect', () => {
            console.log(`❌ Client ${id} disconnected`);
        });

        socket.on('error', (error) => {
            console.error(`❌ Client ${id} error:`, error);
        });
    });
}

async function testBroadcast() {
    console.log('🧪 Testing TTS Broadcasting System\n');
    console.log('Connecting multiple clients to test broadcast...\n');

    // Connect multiple clients
    for (let i = 1; i <= NUM_CLIENTS; i++) {
        const client = await connectClient(i);
        clients.push(client);
    }

    console.log(`\n✅ All ${NUM_CLIENTS} clients connected`);
    console.log('\n📢 When a TTS message is sent via Megaphone:');
    console.log('   - ALL connected clients should receive the sound-effect-play event');
    console.log('   - Each client should play the TTS audio locally');
    console.log('   - The message should appear in chat for everyone\n');

    console.log('Waiting for TTS events... (Use the Megaphone item in the app to test)\n');

    // Keep the test running to listen for events
    setTimeout(() => {
        console.log('\n⏱️ Test timeout reached. Disconnecting clients...');
        clients.forEach((client, i) => {
            client.disconnect();
        });
        process.exit(0);
    }, 60000); // Run for 60 seconds
}

testBroadcast().catch(console.error);