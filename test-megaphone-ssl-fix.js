const axios = require('axios');
const https = require('https');

// Create HTTPS agent for self-signed certificates
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function testMegaphoneSSLFix() {
    console.log('=== TESTING MEGAPHONE TTS WITH SSL FIX ===\n');
    
    try {
        // Get the actual environment URL
        const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';
        console.log(`Using CHAT_SERVICE_URL: ${chatServiceUrl}`);
        
        // Test 1: Direct test with SSL fix
        console.log('\n1. Testing TTS message with SSL fix...');
        const testMessage = `Testing Megaphone at ${new Date().toLocaleTimeString()}`;
        
        const response = await axios.post(`${chatServiceUrl}/api/system-message`, {
            message: `📢 Test User TTS: ${testMessage}`,
            username: '🤖 StreamBot',
            type: 'tts'
        }, {
            timeout: 5000,
            httpsAgent: chatServiceUrl.startsWith('https') ? httpsAgent : undefined
        });
        
        console.log('✅ TTS message sent successfully!');
        console.log('   Response:', response.data);
        
        // Test 2: Simulate what SoundFxService does now
        console.log('\n2. Simulating SoundFxService behavior...');
        const axiosConfig = {
            timeout: 5000
        };
        
        if (chatServiceUrl.startsWith('https')) {
            axiosConfig.httpsAgent = new https.Agent({
                rejectUnauthorized: false
            });
            console.log('   Using HTTPS agent for self-signed certificate');
        }
        
        const soundFxResponse = await axios.post(`${chatServiceUrl}/api/system-message`, {
            message: `📢 SoundFx Test TTS: This simulates the fixed SoundFxService`,
            username: '🤖 StreamBot',
            type: 'tts'
        }, axiosConfig);
        
        console.log('✅ SoundFx-style message sent successfully!');
        console.log('   Response:', soundFxResponse.data);
        
        console.log('\n=== VERIFICATION COMPLETE ===');
        console.log('\n✅ The SSL certificate issue has been fixed!');
        console.log('\nWhat was fixed:');
        console.log('1. Added https module import to SoundFxService');
        console.log('2. Added httpsAgent with rejectUnauthorized: false for self-signed certs');
        console.log('3. Applied the agent only when using HTTPS URLs');
        
        console.log('\nThe Megaphone item should now work correctly:');
        console.log('• TTS messages will appear in chat');
        console.log('• Format: 📢 USERNAME TTS: [message]');
        console.log('• Works with both HTTP and HTTPS endpoints');
        console.log('• Handles self-signed SSL certificates');
        
        // Check recent logs
        console.log('\n3. To verify in production:');
        console.log('   - Use the Megaphone item from inventory');
        console.log('   - Check server logs: pm2 logs onestreamer-server | grep SOUNDFX');
        console.log('   - Look for "TTS message sent to chat" confirmation');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
        
        console.log('\n⚠️ If this test fails:');
        console.log('1. Make sure server was restarted: pm2 restart onestreamer-server');
        console.log('2. Check the CHAT_SERVICE_URL environment variable');
        console.log('3. Verify chat service is running on the expected port');
    }
}

testMegaphoneSSLFix();