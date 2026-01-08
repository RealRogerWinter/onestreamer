const axios = require('axios');

async function testMegaphoneFlow() {
    console.log('Testing Megaphone TTS Flow...\n');
    
    try {
        // Step 1: Check if chat service is running
        console.log('1. Checking chat service...');
        const healthCheck = await axios.get('http://localhost:8081/health');
        console.log('✅ Chat service is running:', healthCheck.data);
        
        // Step 2: Test direct message to chat
        console.log('\n2. Testing direct message to chat...');
        const directMsg = await axios.post('http://localhost:8081/api/system-message', {
            message: '📢 TestUser TTS: Testing megaphone integration',
            username: '🤖 StreamBot',
            type: 'tts'
        });
        console.log('✅ Direct message sent:', directMsg.data);
        
        // Step 3: Check CHAT_SERVICE_URL environment variable
        console.log('\n3. Checking environment configuration...');
        const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:8081';
        console.log('CHAT_SERVICE_URL:', chatServiceUrl);
        
        // Step 4: Test the URL that SoundFxService would use
        console.log('\n4. Testing SoundFxService URL...');
        const soundFxUrl = `${chatServiceUrl}/api/system-message`;
        console.log('Testing URL:', soundFxUrl);
        
        const soundFxMsg = await axios.post(soundFxUrl, {
            message: '📢 SoundFx Test TTS: This simulates what SoundFxService sends',
            username: '🤖 StreamBot',
            type: 'tts'
        }, {
            timeout: 5000
        });
        console.log('✅ SoundFx-style message sent:', soundFxMsg.data);
        
        // Step 5: Check if there's an HTTPS issue
        console.log('\n5. Testing HTTPS endpoint...');
        try {
            const httpsMsg = await axios.post('https://127.0.0.1:8444/api/system-message', {
                message: '📢 HTTPS Test TTS: Testing secure endpoint',
                username: '🤖 StreamBot',
                type: 'tts'
            }, {
                timeout: 5000,
                httpsAgent: new (require('https').Agent)({
                    rejectUnauthorized: false
                })
            });
            console.log('✅ HTTPS message sent:', httpsMsg.data);
        } catch (httpsError) {
            console.log('⚠️ HTTPS endpoint issue:', httpsError.message);
        }
        
        console.log('\n=== DIAGNOSIS ===');
        console.log('Chat service is running and accepting messages.');
        console.log('Direct API calls work correctly.');
        console.log('\nPossible issues to check:');
        console.log('1. SoundFxService might not be initialized properly');
        console.log('2. Error handling might be suppressing the actual error');
        console.log('3. The TTS queue processing might have an issue');
        console.log('\nRecommended fix:');
        console.log('Add more detailed logging to SoundFxService.sendTTSToChat()');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

testMegaphoneFlow();