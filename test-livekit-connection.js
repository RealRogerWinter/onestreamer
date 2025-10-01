const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');

async function testLiveKit() {
    const host = 'http://localhost:7881';
    const apiKey = 'devkey';
    const apiSecret = 'secretsecretsecretsecretsecretsecret';
    
    console.log('Testing LiveKit connection...');
    console.log('Host:', host);
    console.log('API Key:', apiKey);
    
    try {
        // Create client
        const client = new RoomServiceClient(host, apiKey, apiSecret);
        
        // Test listing rooms
        console.log('\nListing rooms...');
        const rooms = await client.listRooms();
        console.log('Rooms found:', rooms.length);
        rooms.forEach(room => {
            console.log(`- ${room.name} (${room.numParticipants} participants)`);
        });
        
        // Test creating a token
        console.log('\nCreating access token...');
        const token = new AccessToken(apiKey, apiSecret, {
            identity: 'test-user',
            ttl: '10m'
        });
        token.addGrant({ roomJoin: true, room: 'test-room' });
        const jwt = await token.toJwt();
        console.log('Token created successfully (length:', jwt.length, ')');
        
        console.log('\n✅ LiveKit is working correctly!');
        console.log('WebSocket URL for clients: wss://onestreamer.live:7880');
        
    } catch (error) {
        console.error('\n❌ LiveKit test failed:', error.message);
        if (error.code) {
            console.error('Error code:', error.code);
        }
        process.exit(1);
    }
}

testLiveKit();