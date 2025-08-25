const axios = require('axios');

const API_URL = 'https://onestreamer.live';

async function testPasswordUpdate() {
    try {
        // First, login with test credentials
        console.log('1. Logging in...');
        const loginResponse = await axios.post(`${API_URL}/auth/login`, {
            email: 'test@example.com', // Replace with your test email
            password: 'oldpassword'     // Replace with your current password
        });

        const token = loginResponse.data.token;
        console.log('Login successful, token received');

        // Now try to update the password
        console.log('\n2. Attempting to update password...');
        const updateResponse = await axios.put(
            `${API_URL}/auth/profile`,
            {
                currentPassword: 'oldpassword',  // Replace with current password
                newPassword: 'newpassword123'    // Replace with new password
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        console.log('Password update response:', updateResponse.data);

        // Try to login with the new password
        console.log('\n3. Testing login with new password...');
        const newLoginResponse = await axios.post(`${API_URL}/auth/login`, {
            email: 'test@example.com',    // Replace with your test email
            password: 'newpassword123'     // The new password
        });

        if (newLoginResponse.data.token) {
            console.log('✅ Success! Password was changed successfully');
        }

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        
        if (error.response?.status === 400 && error.response?.data?.error === 'Current password is incorrect') {
            console.log('\n⚠️  The current password verification is working, but the provided current password is incorrect');
        }
    }
}

console.log('Password Update Test Script');
console.log('===========================');
console.log('Note: Update the email and passwords in this script before running\n');

// Uncomment the line below to run the test
// testPasswordUpdate();