const { RoomServiceClient } = require('livekit-server-sdk');

async function checkParticipants() {
  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  const host = process.env.LIVEKIT_HOST || 'http://127.0.0.1:7882';

  const roomClient = new RoomServiceClient(host, apiKey, apiSecret);

  try {
    const participants = await roomClient.listParticipants('onestreamer-main');

    console.log(`\n📊 Room: onestreamer-main has ${participants.length} participant(s)\n`);

    for (const participant of participants) {
      console.log(`👤 Participant: ${participant.identity}`);
      console.log(`   Name: ${participant.name}`);
      console.log(`   State: ${participant.state}`);
      console.log(`   Tracks:`);

      for (const track of participant.tracks) {
        console.log(`     - ${track.type}: ${track.name} (${track.source})`);
        console.log(`       Muted: ${track.muted}, Width: ${track.width}, Height: ${track.height}`);
      }
      console.log('');
    }
  } catch (error) {
    console.error('❌ Error checking participants:', error);
  }
}

checkParticipants();
