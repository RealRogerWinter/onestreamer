const axios = require('axios');

async function testDeletionConfirmation() {
    console.log('Testing Deletion Confirmation\n');
    console.log('='.repeat(50));
    
    // Test token from the URL you provided
    const testToken = '744b3a634f3c3717bd36619ab2c6bac1bdf6e51aa84618ca2c6325e934c84a5d';
    
    console.log('Testing confirmation endpoint with token:', testToken.substring(0, 20) + '...\n');
    
    try {
        const response = await axios.post(
            'https://onestreamer.live/auth/confirm-deletion',
            { token: testToken }
        );
        
        console.log('Response:', response.data);
        
        if (response.data.success) {
            console.log('\n✅ Account deletion confirmed successfully!');
            console.log('Message:', response.data.message);
        }
    } catch (error) {
        if (error.response) {
            console.log('Response status:', error.response.status);
            console.log('Response data:', error.response.data);
            
            if (error.response.data.error) {
                console.log('\nError:', error.response.data.error);
                
                if (error.response.data.error.includes('expired')) {
                    console.log('ℹ️  The deletion token has expired (tokens are valid for 24 hours)');
                } else if (error.response.data.error.includes('Invalid')) {
                    console.log('ℹ️  The deletion token is invalid or has already been used');
                }
            }
        } else {
            console.error('Network error:', error.message);
        }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('Note: The deletion confirmation page should:');
    console.log('1. Show a loading spinner while confirming');
    console.log('2. Display success message with 15-day warning');
    console.log('3. Count down and automatically log out');
    console.log('4. Clear all session data and cookies');
    console.log('5. Redirect to home page');
}

testDeletionConfirmation();