/**
 * Test script to debug LiveKit transcription issues
 */

const { RoomServiceClient } = require('livekit-server-sdk');

async function testLiveKitTranscription() {
    console.log('🧪 Testing LiveKit Transcription Setup...\n');

    // Load config
    const config = require('./server/config/webrtc.config').livekit;
    console.log('📋 LiveKit Config:');
    console.log(`   Host: ${config.host}`);
    console.log(`   Room: ${config.roomName}`);
    console.log(`   Has API Key: ${!!config.apiKey}`);
    console.log(`   Has API Secret: ${!!config.apiSecret}\n`);

    try {
        // Create room client
        const host = config.host.startsWith('http')
            ? config.host
            : `http://${config.host}`;

        const roomClient = new RoomServiceClient(
            host,
            config.apiKey,
            config.apiSecret
        );

        console.log('🔍 Checking LiveKit room...');

        // List participants
        const participants = await roomClient.listParticipants(config.roomName);
        console.log(`\n✅ Found ${participants.length} participants in room "${config.roomName}":\n`);

        participants.forEach((p, index) => {
            console.log(`${index + 1}. Participant: ${p.identity}`);
            console.log(`   SID: ${p.sid}`);
            console.log(`   State: ${p.state}`);
            console.log(`   Tracks: ${p.tracks?.length || 0}`);

            if (p.tracks && p.tracks.length > 0) {
                p.tracks.forEach((track, tIndex) => {
                    console.log(`     Track ${tIndex + 1}:`);
                    console.log(`       Type: ${track.type}`);
                    console.log(`       SID: ${track.sid}`);
                    console.log(`       Name: ${track.name || '(unnamed)'}`);
                    console.log(`       Muted: ${track.muted}`);
                });
            }
            console.log('');
        });

        // Find audio tracks (LiveKit uses numeric types: AUDIO=0, VIDEO=1, DATA=2)
        const TRACK_TYPE_AUDIO = 0;
        const audioParticipants = participants.filter(p =>
            p.tracks && p.tracks.some(t => t.type === TRACK_TYPE_AUDIO)
        );

        console.log(`\n🎤 Participants with audio: ${audioParticipants.length}`);
        audioParticipants.forEach(p => {
            const audioTracks = p.tracks.filter(t => t.type === TRACK_TYPE_AUDIO);
            console.log(`   ${p.identity}: ${audioTracks.length} audio track(s)`);
            audioTracks.forEach(t => {
                console.log(`     - ${t.sid} (${t.muted ? 'muted' : 'active'})`);
            });
        });

        if (audioParticipants.length === 0) {
            console.log('\n⚠️  WARNING: No participants with audio tracks found!');
            console.log('   Transcription requires an active audio stream.');
        } else {
            console.log('\n✅ Audio tracks available for transcription');
        }

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error('   Stack:', error.stack);
    }
}

// Run the test
testLiveKitTranscription().then(() => {
    console.log('\n✅ Test complete');
    process.exit(0);
}).catch(error => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
});
