const axios = require('axios');

async function testLogin() {
    const testCases = [
        { email: 'user@example.com', password: 'REDACTED-ADMIN-KEY', description: 'Login with email' },
        { email: 'onestreamer', password: 'REDACTED-ADMIN-KEY', description: 'Login with username' },
    ];
    
    for (const test of testCases) {
        console.log(`\n📧 Testing: ${test.description}`);
        console.log(`   Sending: email="${test.email}", password="${test.password}"`);
        
        try {
            const response = await axios.post('https://onestreamer.live/auth/login', {
                email: test.email,
                password: test.password
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            console.log('✅ Success!');
            console.log('   Token:', response.data.token ? 'Received' : 'Missing');
            console.log('   User:', response.data.user);
        } catch (error) {
            console.log('❌ Failed:', error.response?.status);
            console.log('   Error:', error.response?.data);
            
            // Try direct to server
            console.log('\n   Trying direct server connection...');
            try {
                const directResponse = await axios.post('http://localhost:3001/auth/login', {
                    email: test.email,
                    password: test.password
                });
                console.log('   ✅ Direct server login works!');
            } catch (directError) {
                console.log('   ❌ Direct server also fails:', directError.response?.data);
            }
        }
    }
}

testLogin();