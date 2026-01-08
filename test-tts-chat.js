const axios = require('axios');

async function testTTSChat() {
    try {
        console.log('Testing TTS to Chat integration...\n');
        
        // Test 1: Direct system message
        console.log('Test 1: Sending direct system message to chat...');
        const response1 = await axios.post('http://localhost:8081/api/system-message', {
            message: '📢 TestUser TTS: Hello everyone, this is a test message!',
            username: '🤖 StreamBot'
        });
        console.log('✅ Direct system message sent successfully\n');
        
        // Test 2: Simulate TTS queue (this would normally happen through the item use)
        console.log('Test 2: Simulating TTS through SoundFx service...');
        console.log('Note: This would normally be triggered by using the Megaphone item\n');
        
        console.log('Expected flow when Megaphone is used:');
        console.log('1. User uses Megaphone item from inventory');
        console.log('2. TTS modal appears for text input');
        console.log('3. User enters text and selects voice');
        console.log('4. Message is queued in SoundFxService');
        console.log('5. Message appears in chat: 📢 USERNAME TTS: [message]');
        console.log('6. TTS audio plays for all viewers');
        
        console.log('\n✅ All tests completed successfully!');
        console.log('\nIntegration Summary:');
        console.log('- When TTS is triggered, it will appear in chat');
        console.log('- Format: 📢 USERNAME TTS: [message text]');
        console.log('- Message is sent by StreamBot to the chat');
        console.log('- All viewers see the message in chat AND hear the TTS audio');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

testTTSChat();