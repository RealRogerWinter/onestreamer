const axios = require('axios');

async function getFreshToken() {
    console.log('🔑 Getting fresh authentication token...\n');
    
    const email = 'user@example.com';
    const password = process.argv[2];
    
    if (!password) {
        console.log('Please provide your password as an argument:');
        console.log('node get-fresh-token.js YOUR_PASSWORD');
        return;
    }
    
    try {
        const response = await axios.post('http://localhost:8080/auth/login', {
            email,
            password
        });
        
        const data = response.data;
        
        console.log('✅ Login successful!');
        console.log('\n📋 User details:');
        console.log('  ID:', data.user.id);
        console.log('  Username:', data.user.username);
        console.log('  Email:', data.user.email);
        console.log('  Is Admin:', data.user.is_admin ? '✅ YES' : '❌ NO');
        
        console.log('\n🔑 Your fresh token:');
        console.log('━'.repeat(50));
        console.log(data.token);
        console.log('━'.repeat(50));
        
        console.log('\n📝 Next steps:');
        console.log('1. Copy the token above');
        console.log('2. Open browser DevTools (F12)');
        console.log('3. Go to Application → Local Storage → localhost:3000');
        console.log('4. Update the "token" value with the new token');
        console.log('5. Refresh the page');
        console.log('6. Try accessing ChatBots tab again');
        
    } catch (error) {
        if (error.response) {
            console.error('❌ Login failed:', error.response.data.error || 'Unknown error');
        } else {
            console.error('❌ Error:', error.message);
        }
    }
}

getFreshToken();