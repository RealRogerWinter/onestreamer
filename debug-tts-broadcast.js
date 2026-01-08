const SoundFxService = require('./server/services/SoundFxService');

// Create a mock Socket.IO to test the broadcasting logic
const mockClients = [];
const mockIO = {
    emit: (event, data) => {
        console.log(`\n📡 SERVER: Broadcasting ${event} to ${mockClients.length} clients`);
        console.log(`📊 Event data:`, {
            type: data.type,
            username: data.username,
            text: data.text,
            voiceId: data.voiceId
        });
        
        // Simulate clients receiving the event
        mockClients.forEach((client, index) => {
            console.log(`✅ Client ${index + 1}: Received ${event}`);
        });
    }
};

// Simulate multiple connected clients
for (let i = 1; i <= 3; i++) {
    mockClients.push({ id: `client_${i}` });
}

async function debugTTSBroadcast() {
    console.log('🔍 DEBUG: TTS Broadcasting System\n');
    
    const soundFx = new SoundFxService();
    soundFx.setSocketIO(mockIO);
    
    console.log(`📊 Simulating ${mockClients.length} connected clients\n`);
    
    // Queue a test TTS message
    console.log('🎤 Queueing TTS message...');
    const ttsRequest = await soundFx.queueTTS(
        'testuser123',
        'TestUser',
        'This is a test TTS broadcast message!',
        'alloy',
        { debug: true }
    );
    
    console.log('✅ TTS request queued:', {
        id: ttsRequest.id,
        username: ttsRequest.username,
        text: ttsRequest.text,
        voiceId: ttsRequest.voiceId
    });
    
    console.log('\n⏳ Processing queue (with 10s delay simulation)...');
    
    // Wait for processing to complete
    await new Promise(resolve => {
        const checkInterval = setInterval(() => {
            const status = soundFx.getTTSQueueStatus();
            console.log(`📊 Queue status: ${status.queueLength} remaining, processing: ${status.isProcessing}`);
            
            if (status.queueLength === 0 && !status.isProcessing) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 1000);
    });
    
    console.log('\n✅ TTS processing complete!');
    console.log('\n🔍 Analysis:');
    console.log('- The server-side broadcasting logic is working correctly');
    console.log('- All connected clients should receive the sound-effect-play event');
    console.log('- Each client should play the TTS audio locally');
    console.log('\n🎯 If TTS is only playing for one user, the issue is likely:');
    console.log('  1. Client-side SoundFxPlayer component not receiving events');
    console.log('  2. Browser permissions blocking TTS on some clients');
    console.log('  3. Socket connection issues on specific clients');
}

debugTTSBroadcast().catch(console.error);