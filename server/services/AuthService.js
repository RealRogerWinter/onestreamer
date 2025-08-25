const jwt = require('jsonwebtoken');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const AccountService = require('./AccountService');
const EmailService = require('./EmailService');

class AuthService {
    constructor() {
        console.log('🔐 AUTH: Initializing AuthService...');
        this.accountService = new AccountService();
        this._emailService = null; // Lazy load EmailService
        this.jwtSecret = process.env.JWT_SECRET || '***REMOVED-JWT-DEFAULT***';
        this.jwtExpiry = '24h';
        this.initializePassport();
        console.log('🔐 AUTH: AuthService initialized');
    }
    
    get emailService() {
        if (!this._emailService) {
            console.log('🔐 AUTH: Lazy loading EmailService...');
            this._emailService = new EmailService();
        }
        return this._emailService;
    }

    initializePassport() {
        passport.use(new LocalStrategy(
            {
                usernameField: 'email',
                passwordField: 'password'
            },
            async (email, password, done) => {
                try {
                    const user = await this.accountService.verifyPassword(email, password);
                    if (!user) {
                        return done(null, false, { message: 'Invalid email or password' });
                    }
                    return done(null, user);
                } catch (error) {
                    return done(error);
                }
            }
        ));

        if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
            passport.use(new GoogleStrategy(
                {
                    clientID: process.env.GOOGLE_CLIENT_ID,
                    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                    callbackURL: '/auth/google/callback'
                },
                async (accessToken, refreshToken, profile, done) => {
                    try {
                        let user = await this.accountService.getUserByOAuth('google', profile.id);
                        
                        if (!user) {
                            const email = profile.emails[0].value;
                            const username = profile.displayName.replace(/\s+/g, '') + '_' + Date.now();
                            
                            user = await this.accountService.createUser(
                                email,
                                username,
                                null,
                                'google',
                                profile.id
                            );
                            
                            await this.accountService.verifyUser(user.verificationToken);
                            
                            user = await this.accountService.getUserById(user.id);
                        } else {
                            await this.accountService.updateLastLogin(user.id);
                        }
                        
                        return done(null, user);
                    } catch (error) {
                        return done(error);
                    }
                }
            ));
        }

        passport.serializeUser((user, done) => {
            done(null, user.id);
        });

        passport.deserializeUser(async (id, done) => {
            try {
                const user = await this.accountService.getUserById(id);
                done(null, user);
            } catch (error) {
                done(error);
            }
        });
    }

    generateToken(user) {
        const payload = {
            id: user.id,
            email: user.email,
            username: user.username
        };

        return jwt.sign(payload, this.jwtSecret, {
            expiresIn: this.jwtExpiry
        });
    }

    verifyToken(token) {
        try {
            const decoded = jwt.verify(token, this.jwtSecret);
            console.log('✅ Token verified successfully for user ID:', decoded.id);
            return decoded;
        } catch (error) {
            console.log('❌ Token verification failed:', error.message);
            return null;
        }
    }

    generateRefreshToken(user) {
        const payload = {
            id: user.id,
            type: 'refresh'
        };

        return jwt.sign(payload, this.jwtSecret, {
            expiresIn: '7d'
        });
    }

    async signup(email, username, password) {
        try {
            const existingUserByEmail = await this.accountService.getUserByEmail(email);
            if (existingUserByEmail) {
                throw new Error('Email already registered');
            }

            const existingUserByUsername = await this.accountService.getUserByUsername(username);
            if (existingUserByUsername) {
                throw new Error('Username already taken');
            }

            const user = await this.accountService.createUser(email, username, password);
            
            // Send verification email
            try {
                await this.emailService.sendVerificationEmail(email, username, user.verificationToken);
                console.log(`📧 AUTH: Verification email sent to ${email}`);
            } catch (emailError) {
                console.error('📧 AUTH: Failed to send verification email:', emailError);
                // Don't fail the signup process if email fails
            }
            
            const token = this.generateToken(user);
            const refreshToken = this.generateRefreshToken(user);

            return {
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                    isVerified: false,
                    isAdmin: false,
                    isModerator: false
                },
                token,
                refreshToken,
                verificationToken: user.verificationToken
            };
        } catch (error) {
            throw error;
        }
    }

    async login(email, password) {
        try {
            const user = await this.accountService.verifyPassword(email, password);
            
            if (!user) {
                throw new Error('Invalid email or password');
            }

            // Check if account is pending deletion
            if (user.account_status === 'pending_deletion') {
                // Still allow login but include status
                const token = this.generateToken(user);
                const refreshToken = this.generateRefreshToken(user);

                return {
                    user: {
                        id: user.id,
                        email: user.email,
                        username: user.username,
                        isVerified: user.is_verified,
                        isAdmin: user.is_admin === 1,
                        isModerator: user.is_moderator === 1,
                        accountStatus: user.account_status,
                        deletionScheduledFor: user.deletion_scheduled_for
                    },
                    token,
                    refreshToken,
                    accountStatus: 'pending_deletion'
                };
            }

            const token = this.generateToken(user);
            const refreshToken = this.generateRefreshToken(user);

            return {
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                    isVerified: user.is_verified,
                    isAdmin: user.is_admin === 1,
                    isModerator: user.is_moderator === 1,
                    accountStatus: user.account_status || 'active'
                },
                token,
                refreshToken
            };
        } catch (error) {
            throw error;
        }
    }

    async refreshToken(refreshToken) {
        try {
            const decoded = jwt.verify(refreshToken, this.jwtSecret);
            
            if (decoded.type !== 'refresh') {
                throw new Error('Invalid refresh token');
            }

            const user = await this.accountService.getUserById(decoded.id);
            
            if (!user) {
                throw new Error('User not found');
            }

            const newToken = this.generateToken(user);
            const newRefreshToken = this.generateRefreshToken(user);

            return {
                token: newToken,
                refreshToken: newRefreshToken
            };
        } catch (error) {
            throw error;
        }
    }

    async verifyEmail(verificationToken) {
        return await this.accountService.verifyUser(verificationToken);
    }

    async requestPasswordReset(email) {
        const resetToken = await this.accountService.createPasswordResetToken(email);
        
        if (resetToken) {
            const user = await this.accountService.getUserByEmail(email);
            if (user) {
                try {
                    await this.emailService.sendPasswordResetEmail(email, user.username, resetToken);
                    console.log(`📧 AUTH: Password reset email sent to ${email}`);
                } catch (emailError) {
                    console.error('📧 AUTH: Failed to send password reset email:', emailError);
                    // Don't fail the process if email fails
                }
            }
        }
        
        return resetToken;
    }

    async resetPassword(resetToken, newPassword) {
        return await this.accountService.resetPassword(resetToken, newPassword);
    }

    async transferSessionToUser(userId, ipAddress, sessionData) {
        await this.accountService.transferIPSessionToUser(userId, ipAddress, sessionData);
    }

    async resendVerificationEmail(userId) {
        const user = await this.accountService.getUserById(userId);
        
        if (!user) {
            throw new Error('User not found');
        }
        
        if (user.is_verified) {
            throw new Error('Email is already verified');
        }
        
        // Generate new verification token
        const newToken = await this.accountService.regenerateVerificationToken(userId);
        
        // Send verification email
        try {
            await this.emailService.sendVerificationEmail(user.email, user.username, newToken);
            console.log(`📧 AUTH: Resent verification email to ${user.email}`);
            return newToken;
        } catch (emailError) {
            console.error('📧 AUTH: Failed to resend verification email:', emailError);
            throw new Error('Failed to send verification email');
        }
    }

    async requestAccountDeletion(userId) {
        const user = await this.accountService.getUserById(userId);
        
        console.log('🔍 DELETION REQUEST - User data:', {
            id: user?.id,
            username: user?.username,
            email: user?.email,
            oauth_provider: user?.oauth_provider,
            is_verified: user?.is_verified
        });
        
        if (!user) {
            throw new Error('User not found');
        }

        if (!user.is_verified) {
            throw new Error('Email must be verified to delete account');
        }

        // Generate deletion token
        const crypto = require('crypto');
        const deletionToken = crypto.randomBytes(32).toString('hex');
        const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        // Update user record with deletion request
        await this.accountService.requestDeletion(userId, deletionToken, tokenExpires);

        // Send confirmation email
        console.log('📧 DELETION EMAIL - Attempting to send to:', user.email);
        try {
            await this.emailService.sendAccountDeletionEmail(
                user.email, 
                user.username, 
                deletionToken
            );
            console.log('📧 DELETION EMAIL - Successfully sent to:', user.email);
        } catch (emailError) {
            console.error('📧 DELETION EMAIL - Failed to send to:', user.email, 'Error:', emailError);
            throw new Error('Failed to send confirmation email. Please try again.');
        }

        return { success: true };
    }

    async confirmAccountDeletion(token) {
        if (!token) {
            throw new Error('Invalid deletion token');
        }

        const result = await this.accountService.confirmDeletion(token);
        
        if (!result.success) {
            throw new Error(result.error || 'Failed to confirm account deletion');
        }

        return result;
    }

    async restoreAccount(email, password) {
        try {
            // Verify credentials
            const user = await this.accountService.verifyPassword(email, password);
            
            if (!user) {
                return { 
                    success: false, 
                    error: 'Invalid email or password' 
                };
            }

            // Check if account is pending deletion
            if (user.account_status !== 'pending_deletion') {
                return { 
                    success: false, 
                    error: 'Account is not pending deletion' 
                };
            }

            // Restore the account
            const restored = await this.accountService.restoreAccount(user.id);
            
            if (restored) {
                const token = this.generateToken(user);
                const refreshToken = this.generateRefreshToken(user);
                
                return {
                    success: true,
                    user: user,
                    token: token,
                    refreshToken: refreshToken
                };
            }

            return { 
                success: false, 
                error: 'Failed to restore account' 
            };
        } catch (error) {
            console.error('Account restoration error:', error);
            return { 
                success: false, 
                error: error.message || 'Failed to restore account' 
            };
        }
    }
}

module.exports = AuthService;