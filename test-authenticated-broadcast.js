const io = require('socket.io-client');

// Test with a fake token to simulate authentication
const testToken = '***REMOVED-JWT***.invalid';

function connectAuthenticatedClient(id) {
    return new Promise((resolve) => {
        console.log(`🔗 Connecting client ${id}...`);
        
        const socket = io('http://localhost:8080', {
            transports: ['websocket'],
            auth: {
                token: null // We'll test both authenticated and non-authenticated
            }
        });

        socket.on('connect', () => {
            console.log(`✅ Client ${id} connected: ${socket.id}`);
            
            // Join as viewer to ensure we get all broadcasts
            socket.emit('join-as-viewer');
            
            // Listen for sound effects
            socket.on('sound-effect-play', (effect) => {
                console.log(`🔊 Client ${id} received sound effect:`, {
                    type: effect.type,
                    text: effect.text || 'N/A',
                    username: effect.username,
                    voiceId: effect.voiceId,
                    timestamp: new Date(effect.timestamp).toLocaleTimeString()
                });
            });

            // Listen for other relevant events
            socket.on('item-used', (data) => {
                if (data.ttsData) {
                    console.log(`🎯 Client ${id} received item-used with TTS:`, {
                        username: data.username,
                        itemName: data.item?.displayName,
                        ttsText: data.ttsData.text,
                        voiceId: data.ttsData.voiceId
                    });
                }
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

async function testAuthenticatedBroadcast() {
    console.log('🧪 Testing TTS Broadcasting with Authenticated Clients\n');
    
    const clients = [];
    const NUM_CLIENTS = 2;

    // Connect clients
    for (let i = 1; i <= NUM_CLIENTS; i++) {
        const client = await connectAuthenticatedClient(i);
        clients.push(client);
        // Small delay between connections
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n✅ All ${NUM_CLIENTS} clients connected and joined as viewers`);
    console.log('\n📢 Test Instructions:');
    console.log('1. Go to http://localhost:3000');
    console.log('2. Login (or use existing session)');
    console.log('3. Open inventory and use the Megaphone item');
    console.log('4. Enter a TTS message and submit');
    console.log('5. Watch the console for broadcast events\n');

    console.log('Expected behavior:');
    console.log('- All clients should receive sound-effect-play events');
    console.log('- Each client should show the TTS message details');
    console.log('- The TTS should play on all connected clients\n');

    console.log('Listening for events...\n');

    // Keep test running
    setTimeout(() => {
        console.log('\n⏱️ Test completed. Disconnecting clients...');
        clients.forEach(client => client.disconnect());
        process.exit(0);
    }, 120000); // Run for 2 minutes
}

testAuthenticatedBroadcast().catch(console.error);