const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');

async function testLiveKit() {
    const host = 'http://127.0.0.1:7881';
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
        
        // Check if main room exists
        const mainRoom = rooms.find(r => r.name === 'onestreamer-main');
        if (mainRoom) {
            console.log('\n✅ Main room exists:', mainRoom.name);
            console.log('   Created:', new Date(mainRoom.creationTime * 1000).toISOString());
            console.log('   Participants:', mainRoom.numParticipants);
        }
        
        // Test creating a token
        console.log('\nCreating access token for streaming...');
        const token = new AccessToken(apiKey, apiSecret, {
            identity: 'test-streamer',
            ttl: '10m'
        });
        token.addGrant({ 
            roomJoin: true, 
            room: 'onestreamer-main',
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        });
        const jwt = await token.toJwt();
        console.log('Token created successfully!');
        console.log('Token (first 50 chars):', jwt.substring(0, 50) + '...');
        
        console.log('\n✅ LiveKit is working correctly!');
        console.log('\nConnection details:');
        console.log('- API endpoint:', host);
        console.log('- WebSocket URL for clients: wss://onestreamer.live:7880');
        console.log('- Room name: onestreamer-main');
        
    } catch (error) {
        console.error('\n❌ LiveKit test failed:', error.message);
        if (error.code) {
            console.error('Error code:', error.code);
        }
        if (error.stack) {
            console.error('Stack:', error.stack);
        }
        process.exit(1);
    }
}

testLiveKit();