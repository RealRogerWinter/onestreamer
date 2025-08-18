const axios = require('axios');

async function testTTS() {
    console.log('🔍 Testing TTS message flow...\n');
    
    // Login first to get a fresh token
    try {
        const loginResponse = await axios.post('http://localhost:8080/auth/login', {
            email: 'user@example.com',
            password: '***REMOVED-ADMIN-KEY***'
        });
        
        const token = loginResponse.data.token;
        console.log('✅ Logged in successfully');
        
        // Send TTS message
        console.log('📢 Sending TTS message...');
        const ttsResponse = await axios.post('http://localhost:8080/api/soundfx/tts', {
            text: 'Test TTS message to check for duplicates',
            voiceId: 'alloy'
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        console.log('✅ TTS response:', ttsResponse.data);
        
        console.log('\n⏳ Please check the chat window to see if the TTS message appears once or twice.');
        console.log('   Expected: One message saying "📢 onestreamer TTS: Test TTS message to check for duplicates"');
        console.log('   If you see it twice, there\'s a duplicate issue.\n');
        
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

testTTS();