const axios = require('axios');

// You'll need to get a real auth token from localStorage after logging in
// For now, let's try to create a test scenario
async function triggerTestTTS() {
    try {
        console.log('🎤 Triggering test TTS via API...\n');
        
        // Get a token - you'd normally get this from the browser's localStorage
        // For testing, let's try the system message directly to see if the broadcasting works
        
        console.log('Step 1: Testing direct TTS queue via SoundFx service...');
        
        // This would normally be done through the authenticated route
        // For testing purposes, let's make a direct axios call to trigger the TTS system
        const response = await axios.post('http://localhost:8081/api/system-message', {
            message: '📢 SYSTEM TTS: Testing broadcast message',
            username: '🔊 TTS Test'
        });
        
        console.log('✅ System message sent to chat');
        
        console.log('\nTo properly test the TTS broadcasting:');
        console.log('1. Open http://localhost:3000 in your browser');
        console.log('2. Login with your account');
        console.log('3. Open the inventory panel (💼 icon)');
        console.log('4. Find and click the Megaphone item (📢)');
        console.log('5. Enter a test message like "Hello everyone!"');
        console.log('6. Select a voice and submit');
        console.log('7. Check both the console output and the test clients\n');
        
        console.log('Expected results:');
        console.log('- Message appears in chat as "📢 USERNAME TTS: [message]"');
        console.log('- All connected clients receive sound-effect-play event');
        console.log('- TTS audio plays on all clients including sender');
        console.log('- Test clients show the received event in console');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

triggerTestTTS();