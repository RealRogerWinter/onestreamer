const jwt = require('jsonwebtoken');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const AccountService = require('./AccountService');
const EmailService = require('./EmailService');

class AuthService {
    constructor() {
        this.accountService = new AccountService();
        this.emailService = new EmailService();
        this.jwtSecret = process.env.JWT_SECRET || '***REMOVED-JWT-DEFAULT***';
        this.jwtExpiry = '24h';
        this.initializePassport();
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

            const token = this.generateToken(user);
            const refreshToken = this.generateRefreshToken(user);

            return {
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                    isVerified: user.is_verified,
                    isAdmin: user.is_admin === 1,
                    isModerator: user.is_moderator === 1
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
}

module.exports = AuthService;