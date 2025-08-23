const nodemailer = require('nodemailer');

class EmailService {
    constructor() {
        this.transporter = null;
        this.initializeTransporter();
    }

    initializeTransporter() {
        // Check for environment variables for email configuration
        const emailConfig = {
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT || 587,
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        };

        // If no SMTP config provided, use a test account or console logging
        if (!emailConfig.host || !emailConfig.auth.user) {
            console.log('📧 EMAIL: No SMTP configuration found. Using console logging for emails.');
            this.transporter = {
                sendMail: async (mailOptions) => {
                    console.log('\n' + '='.repeat(50));
                    console.log('📧 EMAIL WOULD BE SENT:');
                    console.log('To:', mailOptions.to);
                    console.log('Subject:', mailOptions.subject);
                    console.log('Content:');
                    console.log(mailOptions.html || mailOptions.text);
                    console.log('='.repeat(50) + '\n');
                    
                    return { messageId: 'console-log-' + Date.now() };
                }
            };
            return;
        }

        try {
            this.transporter = nodemailer.createTransport(emailConfig);
            console.log('📧 EMAIL: SMTP transporter initialized');
            
            // Verify connection
            this.transporter.verify((error, success) => {
                if (error) {
                    console.error('📧 EMAIL: SMTP verification failed:', error);
                } else {
                    console.log('📧 EMAIL: SMTP server ready');
                }
            });
        } catch (error) {
            console.error('📧 EMAIL: Failed to initialize transporter:', error);
        }
    }

    async sendVerificationEmail(email, username, verificationToken) {
        const verificationUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/verify-email/${verificationToken}`;
        
        const mailOptions = {
            from: process.env.FROM_EMAIL || 'noreply@onestreamer.com',
            to: email,
            subject: 'Verify Your OneStreamer Account',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
                    <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="color: #333; margin-bottom: 10px;">🎬 OneStreamer</h1>
                            <h2 style="color: #666; font-weight: normal;">Welcome, ${username}!</h2>
                        </div>
                        
                        <p style="color: #555; font-size: 16px; line-height: 1.6;">
                            Thank you for creating an account with OneStreamer! To get started, please verify your email address by clicking the button below.
                        </p>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${verificationUrl}" 
                               style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; font-size: 16px;">
                                Verify Email Address
                            </a>
                        </div>
                        
                        <p style="color: #777; font-size: 14px; line-height: 1.5;">
                            If the button doesn't work, you can copy and paste this link into your browser:<br>
                            <a href="${verificationUrl}" style="color: #007bff; word-break: break-all;">${verificationUrl}</a>
                        </p>
                        
                        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                        
                        <p style="color: #999; font-size: 12px; text-align: center;">
                            This verification link will expire in 24 hours.<br>
                            If you didn't create this account, you can safely ignore this email.
                        </p>
                    </div>
                </div>
            `
        };

        try {
            const result = await this.transporter.sendMail(mailOptions);
            console.log(`📧 EMAIL: Verification email sent to ${email}:`, result.messageId);
            return result;
        } catch (error) {
            console.error('📧 EMAIL: Failed to send verification email:', error);
            throw error;
        }
    }

    async sendPasswordResetEmail(email, username, resetToken) {
        const resetUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;
        
        const mailOptions = {
            from: process.env.FROM_EMAIL || 'noreply@onestreamer.com',
            to: email,
            subject: 'Reset Your OneStreamer Password',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
                    <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="color: #333; margin-bottom: 10px;">🎬 OneStreamer</h1>
                            <h2 style="color: #666; font-weight: normal;">Password Reset</h2>
                        </div>
                        
                        <p style="color: #555; font-size: 16px; line-height: 1.6;">
                            Hi ${username},<br><br>
                            We received a request to reset your password. If you made this request, click the button below to reset your password.
                        </p>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${resetUrl}" 
                               style="background-color: #dc3545; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; font-size: 16px;">
                                Reset Password
                            </a>
                        </div>
                        
                        <p style="color: #777; font-size: 14px; line-height: 1.5;">
                            If the button doesn't work, you can copy and paste this link into your browser:<br>
                            <a href="${resetUrl}" style="color: #dc3545; word-break: break-all;">${resetUrl}</a>
                        </p>
                        
                        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                        
                        <p style="color: #999; font-size: 12px; text-align: center;">
                            This reset link will expire in 1 hour.<br>
                            If you didn't request this reset, you can safely ignore this email.
                        </p>
                    </div>
                </div>
            `
        };

        try {
            const result = await this.transporter.sendMail(mailOptions);
            console.log(`📧 EMAIL: Password reset email sent to ${email}:`, result.messageId);
            return result;
        } catch (error) {
            console.error('📧 EMAIL: Failed to send password reset email:', error);
            throw error;
        }
    }

    async sendTestEmail(to, subject = 'Test Email', content = 'This is a test email from OneStreamer.') {
        const mailOptions = {
            from: process.env.FROM_EMAIL || 'noreply@onestreamer.com',
            to: to,
            subject: subject,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>🎬 OneStreamer Test Email</h2>
                    <p>${content}</p>
                    <p><small>Sent at: ${new Date().toISOString()}</small></p>
                </div>
            `
        };

        try {
            const result = await this.transporter.sendMail(mailOptions);
            console.log(`📧 EMAIL: Test email sent to ${to}:`, result.messageId);
            return result;
        } catch (error) {
            console.error('📧 EMAIL: Failed to send test email:', error);
            throw error;
        }
    }
}

module.exports = EmailService;