const fetch = require('node-fetch');
require('dotenv').config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const ADMIN_KEY = process.env.ADMIN_KEY || '***REMOVED-ADMIN-KEY***';

async function testConnections() {
    console.log('🔍 Simple connections test...\n');
    
    // First login to get auth token
    const loginResponse = await fetch(`${SERVER_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: 'user@example.com',
            password: '***REMOVED-ADMIN-KEY***'
        })
    });
    
    const loginData = await loginResponse.json();
    const authToken = loginData.token;
    console.log('✅ Logged in successfully\n');
    
    // Now fetch connections with JWT token
    const response = await fetch(`${SERVER_URL}/admin/connections`, {
        headers: {
            'Authorization': `Bearer ${authToken}`
        }
    });
    
    if (!response.ok) {
        console.log('❌ Failed:', response.status);
        return;
    }
    
    const data = await response.json();
    
    console.log('Sessions with positive user IDs:');
    data.sessions
        .filter(s => s.userId && s.userId > 0)
        .forEach(s => {
            console.log(`\nSocket: ${s.socketId}`);
            console.log(`  User ID: ${s.userId}`);
            console.log(`  Authenticated User: ${JSON.stringify(s.authenticatedUser)}`);
        });
}

testConnections().catch(console.error);