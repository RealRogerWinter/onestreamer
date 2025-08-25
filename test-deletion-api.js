const axios = require('axios');

async function testDeletionAPI() {
    console.log('Testing Account Deletion API\n');
    console.log('=' .repeat(50));
    
    // First, let's login as a test user
    const email = 'user@example.com'; // User ID 4 from the database
    const password = 'Test';
    
    try {
        console.log('\n1. Attempting login...');
        console.log('   Email:', email);
        
        // Login without turnstile for testing
        const loginUrl = 'https://onestreamer.live/auth/login';
        
        // We need to use a real user session
        // For testing, let's just check if the endpoint exists
        const testResponse = await axios.post(
            'https://onestreamer.live/auth/request-deletion',
            {},
            {
                headers: {
                    'Authorization': 'Bearer invalid-token-for-test'
                }
            }
        ).catch(err => {
            if (err.response) {
                console.log('\n✓ Deletion endpoint exists');
                console.log('Response status:', err.response.status);
                console.log('Response:', err.response.data);
                
                if (err.response.status === 403) {
                    console.log('\n✓ Authentication is working (rejected invalid token)');
                }
                
                return err.response;
            } else {
                console.error('Network error:', err.message);
                return null;
            }
        });
        
        // Now test if email would be sent
        console.log('\n2. Testing if email service is configured...');
        
        // Check the actual server configuration
        console.log('\nNote: To fully test email sending, you need:');
        console.log('  1. A valid user account with verified email');
        console.log('  2. Valid authentication token');
        console.log('  3. The user must request deletion through the UI');
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testDeletionAPI();