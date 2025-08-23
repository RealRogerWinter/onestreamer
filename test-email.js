#!/usr/bin/env node

require('dotenv').config();
const EmailService = require('./server/services/EmailService');

async function testEmail() {
    console.log('Testing email configuration...\n');
    
    // Check environment variables
    console.log('SMTP Configuration:');
    console.log('  Host:', process.env.SMTP_HOST || 'NOT SET');
    console.log('  Port:', process.env.SMTP_PORT || 'NOT SET');
    console.log('  User:', process.env.SMTP_USER || 'NOT SET');
    console.log('  Pass:', process.env.SMTP_PASS ? '***SET***' : 'NOT SET');
    console.log('  From:', process.env.FROM_EMAIL || 'NOT SET');
    console.log('');
    
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log('⚠️  SMTP configuration is incomplete!');
        console.log('\nTo configure email, update your .env file with one of these options:\n');
        
        console.log('Option 1: Gmail (Recommended for testing)');
        console.log('  1. Enable 2-factor authentication on your Gmail account');
        console.log('  2. Generate an app password: https://myaccount.google.com/apppasswords');
        console.log('  3. Update .env:');
        console.log('     SMTP_HOST=smtp.gmail.com');
        console.log('     SMTP_PORT=587');
        console.log('     SMTP_USER=your-email@gmail.com');
        console.log('     SMTP_PASS=your-16-char-app-password\n');
        
        console.log('Option 2: SendGrid (Free tier: 100 emails/day)');
        console.log('  1. Sign up at https://sendgrid.com');
        console.log('  2. Create an API key');
        console.log('  3. Update .env:');
        console.log('     SMTP_HOST=smtp.sendgrid.net');
        console.log('     SMTP_PORT=587');
        console.log('     SMTP_USER=apikey');
        console.log('     SMTP_PASS=your-sendgrid-api-key\n');
        
        console.log('Option 3: Mailgun (Free tier: 5000 emails/month for 3 months)');
        console.log('  1. Sign up at https://mailgun.com');
        console.log('  2. Get SMTP credentials from dashboard');
        console.log('  3. Update .env:');
        console.log('     SMTP_HOST=smtp.mailgun.org');
        console.log('     SMTP_PORT=587');
        console.log('     SMTP_USER=your-mailgun-username');
        console.log('     SMTP_PASS=your-mailgun-password\n');
        
        console.log('Option 4: SMTP2GO (Free tier: 1000 emails/month)');
        console.log('  1. Sign up at https://smtp2go.com');
        console.log('  2. Create SMTP credentials');
        console.log('  3. Update .env:');
        console.log('     SMTP_HOST=mail.smtp2go.com');
        console.log('     SMTP_PORT=2525');
        console.log('     SMTP_USER=your-smtp2go-username');
        console.log('     SMTP_PASS=your-smtp2go-password\n');
    }
    
    // Test sending an email
    const emailService = new EmailService();
    
    // Give it a moment to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const testEmail = process.argv[2];
    if (testEmail) {
        console.log(`\nAttempting to send test email to: ${testEmail}`);
        try {
            await emailService.sendTestEmail(
                testEmail,
                'OneStreamer Email Test',
                'If you received this email, your SMTP configuration is working correctly!'
            );
            console.log('✅ Test email sent successfully!');
        } catch (error) {
            console.error('❌ Failed to send test email:', error.message);
        }
    } else {
        console.log('\nTo send a test email, run:');
        console.log('  node test-email.js your-email@example.com');
    }
}

testEmail().catch(console.error);