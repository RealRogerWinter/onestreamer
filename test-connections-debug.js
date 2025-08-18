const fetch = require('node-fetch');
require('dotenv').config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

async function debugConnections() {
    console.log('🔍 Debugging connections endpoint directly...\n');
    
    // First, login to get a token
    console.log('Step 1: Logging in...');
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
    console.log('✅ Logged in with token:', authToken.substring(0, 20) + '...');
    
    // Now fetch connections with both admin key and auth token
    console.log('\nStep 2: Fetching connections with auth...');
    const connectionsResponse = await fetch(`${SERVER_URL}/admin/connections`, {
        headers: {
            'Authorization': `Bearer ${authToken}`
        }
    });
    
    console.log('Response status:', connectionsResponse.status);
    console.log('Response headers:', connectionsResponse.headers.raw());
    
    const responseText = await connectionsResponse.text();
    console.log('\nRaw response (first 500 chars):');
    console.log(responseText.substring(0, 500));
    
    try {
        const data = JSON.parse(responseText);
        console.log('\n📊 Parsed data summary:');
        console.log('- Total connections:', data.totalConnections);
        console.log('- Sessions count:', data.sessions?.length);
        
        if (data.sessions && data.sessions.length > 0) {
            console.log('\nFirst session details:');
            console.log(JSON.stringify(data.sessions[0], null, 2));
        }
    } catch (err) {
        console.log('Could not parse as JSON:', err.message);
    }
}

debugConnections().catch(console.error);