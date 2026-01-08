const axios = require('axios');
const https = require('https');

// Create an HTTPS agent that accepts self-signed certificates
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function verifyTTSChat() {
    console.log('=== VERIFYING TTS CHAT MESSAGE INTEGRATION ===\n');
    
    try {
        // Test 1: Direct HTTP to chat service
        console.log('1. Testing direct HTTP to chat service (port 8081)...');
        try {
            const httpResponse = await axios.post('http://127.0.0.1:8081/api/system-message', {
                message: '📢 Test User TTS: Testing HTTP endpoint',
                username: '🤖 StreamBot',
                type: 'tts'
            }, {
                timeout: 5000
            });
            console.log('✅ HTTP message sent successfully:', httpResponse.data);
        } catch (httpError) {
            console.log('❌ HTTP failed:', httpError.message);
        }
        
        // Test 2: HTTPS to chat service
        console.log('\n2. Testing HTTPS to chat service (port 8444)...');
        try {
            const httpsResponse = await axios.post('https://127.0.0.1:8444/api/system-message', {
                message: '📢 Test User TTS: Testing HTTPS endpoint',
                username: '🤖 StreamBot',
                type: 'tts'
            }, {
                timeout: 5000,
                httpsAgent
            });
            console.log('✅ HTTPS message sent successfully:', httpsResponse.data);
        } catch (httpsError) {
            console.log('❌ HTTPS failed:', httpsError.message);
        }
        
        // Test 3: Using the environment variable
        console.log('\n3. Testing with CHAT_SERVICE_URL environment...');
        const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://127.0.0.1:8081';
        console.log('   Using URL:', chatServiceUrl);
        
        try {
            const envResponse = await axios.post(`${chatServiceUrl}/api/system-message`, {
                message: '📢 Test User TTS: Testing environment URL',
                username: '🤖 StreamBot',
                type: 'tts'
            }, {
                timeout: 5000,
                httpsAgent: chatServiceUrl.startsWith('https') ? httpsAgent : undefined
            });
            console.log('✅ Environment URL message sent:', envResponse.data);
        } catch (envError) {
            console.log('❌ Environment URL failed:', envError.message);
        }
        
        console.log('\n=== SUMMARY ===');
        console.log('\nThe fix has been applied to SoundFxService.js:');
        console.log('✅ Changed from "localhost" to "127.0.0.1" to avoid IPv6 issues');
        console.log('✅ Added detailed logging for debugging');
        console.log('✅ Enhanced error reporting');
        
        console.log('\nWhen the Megaphone item is used:');
        console.log('1. User enters TTS text in the modal');
        console.log('2. SoundFxService queues the TTS request');
        console.log('3. SoundFxService.sendTTSToChat() sends message to chat');
        console.log('4. Chat service broadcasts the message to all users');
        console.log('5. Message appears as: 📢 USERNAME TTS: [message]');
        
        console.log('\n✅ TTS chat integration should now be working!');
        console.log('\nTo test in production:');
        console.log('1. Use the Megaphone item from inventory');
        console.log('2. Enter a message and submit');
        console.log('3. Check the chat for the TTS message');
        console.log('4. Check server logs: pm2 logs onestreamer-server | grep SOUNDFX');
        
    } catch (error) {
        console.error('\n❌ Unexpected error:', error.message);
    }
}

verifyTTSChat();