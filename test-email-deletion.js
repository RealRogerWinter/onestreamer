require('dotenv').config({ path: '/root/onestreamer/.env' });
const EmailService = require('./server/services/EmailService');

async function testEmailService() {
    console.log('Testing Email Service for Account Deletion\n');
    console.log('='.repeat(50));
    
    // Check environment variables
    console.log('Environment Variables:');
    console.log('  SMTP_HOST:', process.env.SMTP_HOST || 'NOT SET');
    console.log('  SMTP_PORT:', process.env.SMTP_PORT || 'NOT SET');
    console.log('  SMTP_USER:', process.env.SMTP_USER ? 'SET' : 'NOT SET');
    console.log('  SMTP_PASS:', process.env.SMTP_PASS ? 'SET (hidden)' : 'NOT SET');
    console.log('  FROM_EMAIL:', process.env.FROM_EMAIL || 'NOT SET');
    console.log('');
    
    // Initialize email service
    const emailService = new EmailService();
    
    // Wait a moment for initialization
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test sending deletion email
    const testEmail = 'test@example.com';
    const testUsername = 'testuser';
    const testToken = 'test-deletion-token-123456';
    
    console.log('\nAttempting to send account deletion email...');
    console.log('  To:', testEmail);
    console.log('  Username:', testUsername);
    console.log('  Token:', testToken);
    console.log('');
    
    try {
        const result = await emailService.sendAccountDeletionEmail(
            testEmail,
            testUsername,
            testToken
        );
        
        console.log('✅ Email sent successfully!');
        console.log('Message ID:', result.messageId);
        
        if (result.messageId && result.messageId.startsWith('console-log-')) {
            console.log('\n⚠️  Note: Email was logged to console (no SMTP configured or failed)');
        } else {
            console.log('\n✅ Email was sent via SMTP');
            console.log('Response:', result.response);
        }
    } catch (error) {
        console.error('❌ Failed to send email:', error.message);
        console.error('Full error:', error);
    }
}

testEmailService().catch(console.error);