const fetch = require('node-fetch');

const SERVER_URL = process.env.SERVER_URL || 'https://onestreamer.live';

async function testPointsAPI() {
    console.log('🔍 Testing Points API\n');
    console.log('=' .repeat(60));
    
    // First, we need to login to get a token
    console.log('\n1️⃣ Logging in as onestreamer...');
    try {
        const loginResponse = await fetch(`${SERVER_URL}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: 'user@example.com',
                password: 'REDACTED-ADMIN-KEY'  // You'll need to provide the correct password
            })
        });
        
        if (!loginResponse.ok) {
            console.log('❌ Login failed. Please update the password in the script.');
            console.log('   You can also test the endpoint directly in the browser if you\'re logged in.');
            return;
        }
        
        const loginData = await loginResponse.json();
        const token = loginData.token;
        console.log('✅ Logged in successfully');
        console.log(`   Token: ${token.substring(0, 20)}...`);
        
        // Now test the /api/auth/me endpoint
        console.log('\n2️⃣ Testing /api/auth/me endpoint...');
        const meResponse = await fetch(`${SERVER_URL}/api/auth/me`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!meResponse.ok) {
            console.log(`❌ /api/auth/me failed with status ${meResponse.status}`);
            const error = await meResponse.text();
            console.log(`   Error: ${error}`);
            return;
        }
        
        const userData = await meResponse.json();
        console.log('✅ /api/auth/me returned data:');
        console.log(`   User: ${userData.user?.username} (ID: ${userData.user?.id})`);
        console.log(`   Email: ${userData.user?.email}`);
        console.log(`   Points Balance: ${userData.stats?.points_balance}`);
        console.log(`   Points (legacy): ${userData.stats?.points}`);
        
        // Also test the /auth/me endpoint
        console.log('\n3️⃣ Testing /auth/me endpoint...');
        const authMeResponse = await fetch(`${SERVER_URL}/auth/me`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!authMeResponse.ok) {
            console.log(`❌ /auth/me failed with status ${authMeResponse.status}`);
        } else {
            const authData = await authMeResponse.json();
            console.log('✅ /auth/me returned data:');
            console.log(`   Points Balance: ${authData.stats?.points_balance}`);
            console.log(`   Points (legacy): ${authData.stats?.points}`);
        }
        
        console.log('\n✅ API Test Complete!');
        console.log('   If points show as 0 or undefined, check the database directly.');
        
    } catch (error) {
        console.error('❌ Error testing API:', error.message);
    }
}

// Note: You need to provide the correct password
console.log('⚠️  NOTE: This test requires the correct password for onestreamer account.');
console.log('   Edit the script to add the correct password, or test manually in browser.\n');

// Uncomment and set the password to run the test
// testPointsAPI();

console.log('Manual testing instructions:');
console.log('1. Open browser and go to https://onestreamer.live');
console.log('2. Login with your account');
console.log('3. Open browser console (F12)');
console.log('4. Run this command:');
console.log(`   fetch('${SERVER_URL}/api/auth/me', {headers: {'Authorization': 'Bearer ' + localStorage.getItem('token')}}).then(r => r.json()).then(console.log)`);
console.log('5. Check if stats.points_balance shows the correct value');