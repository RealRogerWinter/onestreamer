require('dotenv').config({ path: '/root/onestreamer/.env' });
const EmailService = require('./server/services/EmailService');

async function testOAuthUserEmail() {
    console.log('Testing Email for OAuth User (MeatSoSmooth)\n');
    console.log('='.repeat(50));
    
    // OAuth user details from database
    const oauthUser = {
        email: 'user@example.com',
        username: 'MeatSoSmooth',
        provider: 'google'
    };
    
    console.log('User Details:');
    console.log('  Email:', oauthUser.email);
    console.log('  Username:', oauthUser.username);
    console.log('  Provider:', oauthUser.provider);
    console.log('');
    
    // Initialize email service
    const emailService = new EmailService();
    
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test deletion token
    const crypto = require('crypto');
    const testToken = crypto.randomBytes(32).toString('hex');
    
    console.log('Attempting to send deletion email to OAuth user...\n');
    
    try {
        const result = await emailService.sendAccountDeletionEmail(
            oauthUser.email,
            oauthUser.username,
            testToken
        );
        
        console.log('✅ Email sent successfully!');
        console.log('Message ID:', result.messageId);
        
        if (result.response) {
            console.log('SMTP Response:', result.response);
        }
        
        console.log('\n✅ Email should arrive at:', oauthUser.email);
        console.log('Deletion URL would be:', `https://onestreamer.live/confirm-deletion/${testToken}`);
        
    } catch (error) {
        console.error('❌ Failed to send email:', error.message);
        console.error('Full error:', error);
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('\nNOTE: If the email sends successfully here but not from the app,');
    console.log('the issue might be with the EmailService not being properly');
    console.log('initialized when handling OAuth user deletion requests.');
}

testOAuthUserEmail().catch(console.error);