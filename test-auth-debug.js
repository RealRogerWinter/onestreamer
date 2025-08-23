const axios = require('axios');

const API_URL = 'https://onestreamer.live';

async function testAuth() {
    try {
        console.log('🔐 Testing Authentication Flow...\n');
        
        // Test login
        console.log('1. Testing login endpoint...');
        const loginResponse = await axios.post(`${API_URL}/auth/login`, {
            email: 'admin@onestreamer.live',
            password: 'REDACTED-ADMIN-KEY'
        });
        
        console.log('✅ Login successful');
        console.log('Token:', loginResponse.data.token ? 'Present' : 'Missing');
        console.log('User:', loginResponse.data.user);
        
        const token = loginResponse.data.token;
        
        if (!token) {
            console.error('❌ No token received from login');
            return;
        }
        
        // Test /auth/me endpoint
        console.log('\n2. Testing /auth/me endpoint with token...');
        try {
            const meResponse = await axios.get(`${API_URL}/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            console.log('✅ /auth/me successful');
            console.log('User data:', meResponse.data.user);
            console.log('Points:', meResponse.data.stats?.points_balance);
        } catch (error) {
            console.error('❌ /auth/me failed:', error.response?.status, error.response?.data);
        }
        
        // Test admin verify endpoint
        console.log('\n3. Testing /api/admin/verify endpoint...');
        try {
            const adminResponse = await axios.get(`${API_URL}/api/admin/verify`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            console.log('✅ Admin verification successful');
            console.log('Admin status:', adminResponse.data);
        } catch (error) {
            console.error('❌ Admin verify failed:', error.response?.status, error.response?.data);
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error.response?.status, error.response?.data || error.message);
    }
}

testAuth();