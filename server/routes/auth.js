const express = require('express');
const router = express.Router();
const passport = require('passport');
const { body, validationResult } = require('express-validator');
const AuthService = require('../services/AuthService');
const SessionService = require('../services/SessionService');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const { requireTurnstile } = require('../middleware/turnstile');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const authService = new AuthService();

// Configure multer for avatar uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadPath = '/var/www/html/uploads/avatars';
        try {
            await fs.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (error) {
            cb(error, null);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `avatar-${req.user.id}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

const validateSignup = [
    body('email').isEmail().normalizeEmail(),
    body('username').isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/),
    body('password').isLength({ min: 6 })
];

const validateLogin = [
    body('email').notEmpty().trim(), // Accept email or username
    body('password').notEmpty()
];

router.post('/signup', requireTurnstile, validateSignup, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, username, password } = req.body;
        const result = await authService.signup(email, username, password);

        const ipAddress = req.ip || req.connection.remoteAddress;
        const sessionService = req.app.get('sessionService');
        
        if (sessionService && ipAddress) {
            const sessionData = sessionService.getSessionByIp(ipAddress);
            if (sessionData) {
                await authService.transferSessionToUser(result.user.id, ipAddress, sessionData);
                sessionService.linkUserToSession(ipAddress, result.user.id);
                
                // Restart time tracking for existing active sessions after signup
                const timeTrackingService = req.app.get('timeTrackingService');
                if (timeTrackingService) {
                    await timeTrackingService.restartSessionsAfterLogin(result.user.id, ipAddress);
                }
            }
        }

        res.status(201).json({
            message: 'User created successfully',
            user: result.user,
            token: result.token,
            refreshToken: result.refreshToken
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ error: error.message });
    }
});

router.post('/login', requireTurnstile, validateLogin, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password } = req.body;
        console.log('🔐 Login attempt:', { email, passwordLength: password ? password.length : 0 });
        const result = await authService.login(email, password);

        const ipAddress = req.ip || req.connection.remoteAddress;
        const sessionService = req.app.get('sessionService');
        
        if (sessionService && ipAddress) {
            const sessionData = sessionService.getSessionByIp(ipAddress);
            if (sessionData && !sessionData.userId) {
                await authService.transferSessionToUser(result.user.id, ipAddress, sessionData);
                sessionService.linkUserToSession(ipAddress, result.user.id);
                
                // Restart time tracking for existing active sessions after login
                const timeTrackingService = req.app.get('timeTrackingService');
                if (timeTrackingService) {
                    await timeTrackingService.restartSessionsAfterLogin(result.user.id, ipAddress);
                }
            }
        }

        res.json({
            message: 'Login successful',
            user: result.user,
            token: result.token,
            refreshToken: result.refreshToken
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(401).json({ error: error.message });
    }
});

router.post('/logout', authenticateToken, (req, res) => {
    res.json({ message: 'Logout successful' });
});

router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        
        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }

        const result = await authService.refreshToken(refreshToken);
        
        res.json({
            token: result.token,
            refreshToken: result.refreshToken
        });
    } catch (error) {
        console.error('Token refresh error:', error);
        res.status(401).json({ error: 'Invalid refresh token' });
    }
});

router.get('/verify-email/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const result = await authService.verifyEmail(token);

        // Grant starter items to newly verified users
        if (result && result.userId) {
            const inventoryService = req.app.locals.inventoryService;
            const itemService = req.app.locals.itemService;

            if (inventoryService && itemService) {
                try {
                    // Get item IDs for starter items
                    const tomato = await itemService.getItemByName('tomato');
                    const heartSwarm = await itemService.getItemByName('heart_swarm');

                    // Grant 5 tomatoes
                    if (tomato) {
                        await inventoryService.addItemToInventory(result.userId, tomato.id, 5);
                        console.log(`🎁 WELCOME: Granted 5 tomatoes to user ${result.userId}`);
                    }

                    // Grant 1 heart swarm
                    if (heartSwarm) {
                        await inventoryService.addItemToInventory(result.userId, heartSwarm.id, 1);
                        console.log(`🎁 WELCOME: Granted 1 heart swarm to user ${result.userId}`);
                    }
                } catch (grantError) {
                    console.error('Error granting starter items:', grantError);
                    // Don't fail verification if item granting fails
                }
            }
        }

        res.json({ message: 'Email verified successfully' });
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(400).json({ error: error.message });
    }
});

router.post('/resend-verification', authenticateToken, async (req, res) => {
    try {
        const user = await authService.accountService.getUserById(req.user.id);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.is_verified) {
            return res.status(400).json({ error: 'Email is already verified' });
        }
        
        const newToken = await authService.resendVerificationEmail(user.id);
        
        res.json({ 
            message: 'Verification email has been resent. Please check your email.',
            success: true 
        });
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ error: 'Failed to resend verification email' });
    }
});

router.post('/forgot-password', requireTurnstile, async (req, res) => {
    try {
        const { email } = req.body;
        const resetToken = await authService.requestPasswordReset(email);
        
        if (resetToken) {
            res.json({ 
                message: 'Password reset token generated',
                resetToken
            });
        } else {
            res.status(404).json({ error: 'Email not found' });
        }
    } catch (error) {
        console.error('Password reset request error:', error);
        res.status(500).json({ error: 'Failed to process password reset' });
    }
});

router.post('/reset-password', async (req, res) => {
    try {
        const { resetToken, newPassword } = req.body;
        
        if (!resetToken || !newPassword) {
            return res.status(400).json({ error: 'Reset token and new password required' });
        }

        await authService.resetPassword(resetToken, newPassword);
        res.json({ message: 'Password reset successful' });
    } catch (error) {
        console.error('Password reset error:', error);
        res.status(400).json({ error: error.message });
    }
});

router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await authService.accountService.getUserById(req.user.id);
        const stats = await authService.accountService.getUserStats(req.user.id);
        
        // Use points_balance, not calculated points
        const points = stats?.points_balance || 0;
        
        // Check if user can change username
        const canChangeUsername = await authService.accountService.canChangeUsername(req.user.id);
        
        res.json({
            user: {
                ...user,
                canChangeUsername,
                avatar_url: user.avatar_url,
                description: user.description
            },
            stats: {
                ...stats,
                points  // This is now the balance, not calculated
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

router.put('/change-username', authenticateToken, async (req, res) => {
    try {
        const { newUsername } = req.body;
        
        if (!newUsername) {
            return res.status(400).json({ error: 'New username is required' });
        }
        
        const result = await authService.accountService.changeUsername(req.user.id, newUsername);
        
        // Generate new token with updated username
        const user = await authService.accountService.getUserById(req.user.id);
        const token = authService.generateToken(user);
        const refreshToken = authService.generateRefreshToken(user);
        
        res.json({
            success: true,
            username: result.username,
            token,
            refreshToken,
            message: 'Username changed successfully'
        });
    } catch (error) {
        console.error('Change username error:', error);
        res.status(400).json({ error: error.message });
    }
});

router.put('/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { bio, website, location, displayName, currentPassword, newPassword, description } = req.body;
        
        console.log('Profile update request:', { 
            userId, 
            hasCurrentPassword: !!currentPassword,
            hasNewPassword: !!newPassword,
            hasBio: !!bio,
            hasWebsite: !!website,
            hasLocation: !!location,
            hasDisplayName: !!displayName
        });
        
        // Update user profile
        const user = await authService.accountService.getUserById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Handle password change if requested
        if (currentPassword && newPassword) {
            console.log('Attempting password change for user:', userId);
            // Verify current password
            const isValidPassword = await authService.accountService.verifyUserPassword(userId, currentPassword);
            console.log('Current password validation result:', isValidPassword);
            if (!isValidPassword) {
                return res.status(400).json({ error: 'Current password is incorrect' });
            }
            
            // Update password
            await authService.accountService.changePassword(userId, newPassword);
            console.log('Password changed successfully for user:', userId);
        }
        
        // Update profile fields
        const updatedProfile = await authService.accountService.updateProfile(userId, {
            bio,
            website,
            location,
            displayName,
            description
        });
        
        res.json({
            success: true,
            message: 'Profile updated successfully',
            profile: updatedProfile
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// Avatar upload endpoint with enhanced error handling
router.post('/avatar', authenticateToken, (req, res) => {
    upload.single('avatar')(req, res, async (err) => {
        try {
            // Handle multer errors
            if (err) {
                console.error('Multer error:', err);
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: 'File size too large. Maximum size is 5MB.' });
                }
                if (err.message === 'Only image files are allowed') {
                    return res.status(400).json({ error: err.message });
                }
                return res.status(400).json({ error: 'Error uploading file: ' + err.message });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const userId = req.user.id;
            const avatarUrl = `/uploads/avatars/${req.file.filename}`;
            
            console.log('Avatar upload:', {
                userId,
                filename: req.file.filename,
                mimetype: req.file.mimetype,
                size: req.file.size,
                avatarUrl
            });
            
            // Get old avatar to delete it
            const user = await authService.accountService.getUserById(userId);
            if (user && user.avatar_url) {
                const oldAvatarPath = path.join(__dirname, '..', user.avatar_url);
                try {
                    await fs.unlink(oldAvatarPath);
                    console.log('Deleted old avatar:', oldAvatarPath);
                } catch (err) {
                    console.log('Could not delete old avatar:', err.message);
                }
            }
            
            // Update user's avatar URL in database
            await authService.accountService.updateProfile(userId, {
                avatar_url: avatarUrl
            });
            
            res.json({
                success: true,
                avatar_url: avatarUrl,
                message: 'Avatar uploaded successfully'
            });
        } catch (error) {
            console.error('Avatar upload error:', error);
            res.status(500).json({ error: 'Failed to upload avatar: ' + error.message });
        }
    });
});

// Delete avatar endpoint
router.delete('/avatar', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await authService.accountService.getUserById(userId);
        
        if (user.avatar_url) {
            // Extract filename from URL path
            const filename = user.avatar_url.split('/').pop();
            const avatarPath = path.join('/var/www/html/uploads/avatars', filename);
            try {
                await fs.unlink(avatarPath);
            } catch (err) {
                console.log('Could not delete avatar file:', err.message);
            }
        }
        
        // Remove avatar URL from database
        await authService.accountService.updateProfile(userId, {
            avatar_url: null
        });
        
        res.json({
            success: true,
            message: 'Avatar deleted successfully'
        });
    } catch (error) {
        console.error('Avatar delete error:', error);
        res.status(500).json({ error: 'Failed to delete avatar' });
    }
});

// Get user public profile endpoint
router.get('/user/:username', async (req, res) => {
    try {
        const { username } = req.params;
        
        // Remove any emoji prefix (like 🤖) from the username for checking
        const cleanUsername = username.replace(/^🤖\s*/, '');
        
        // List of animal names used for anonymous users
        const ANONYMOUS_ANIMALS = [
            'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
            'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
            'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
            'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
            'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
        ];
        
        // Check if this is an anonymous user (animal name + numbers pattern)
        const isAnonymousPattern = ANONYMOUS_ANIMALS.some(animal => {
            const pattern = new RegExp(`^${animal}\\d+$`, 'i');
            return pattern.test(cleanUsername);
        });
        
        // Also check for explicit anonymous/guest prefixes
        if (isAnonymousPattern || cleanUsername.toLowerCase().startsWith('anonymous') || cleanUsername.toLowerCase().startsWith('guest')) {
            // Return a special response for anonymous users
            return res.json({
                username: cleanUsername,
                is_anonymous: true,
                description: 'This is an anonymous user. No account information available.',
                created_at: new Date().toISOString()
            });
        }
        
        // Special case for StreamBot
        if (cleanUsername.toLowerCase() === 'streambot') {
            return res.json({
                username: 'StreamBot',
                is_chatbot: true,
                description: 'The StreamBot is responsible for various functions of OneStreamer including notifications, automated messages, and system operations.',
                bot_type: 'System Bot',
                is_system: true,
                created_at: '2024-01-01T00:00:00.000Z',
                is_anonymous: false
            });
        }
        
        // Check if this is a chatbot by checking active chatbots
        const db = require('../database/database').db;
        const chatbot = await new Promise((resolve, reject) => {
            db.get(
                `SELECT c.*, t.personality_prompt 
                 FROM chatbots c 
                 LEFT JOIN temporary_bots t ON c.id = t.chatbot_id
                 WHERE c.name = ? AND c.is_enabled = 1`,
                [cleanUsername],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
        
        if (chatbot) {
            // Use personality_prompt for temporary bots, otherwise use the full prompt
            let description = chatbot.prompt || 'AI Chatbot';
            if (chatbot.is_temporary && chatbot.personality_prompt) {
                description = chatbot.personality_prompt;
            }
            
            // Return chatbot information
            return res.json({
                username: cleanUsername,
                is_chatbot: true,
                description: description,
                bot_type: chatbot.llm_model || 'default',
                duration_minutes: chatbot.is_temporary ? 60 : null,
                created_at: chatbot.created_at,
                expires_at: chatbot.expires_at,
                is_anonymous: false
            });
        }
        
        const user = await authService.accountService.getUserByUsername(cleanUsername);
        
        if (!user) {
            // If not found as a user, might be an inactive chatbot
            const inactiveChatbot = await new Promise((resolve, reject) => {
                db.get(
                    `SELECT c.*, t.personality_prompt 
                     FROM chatbots c 
                     LEFT JOIN temporary_bots t ON c.id = t.chatbot_id
                     WHERE c.name = ?`,
                    [cleanUsername],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            
            if (inactiveChatbot) {
                // Use personality_prompt for temporary bots, otherwise use the full prompt
                let description = inactiveChatbot.prompt || 'AI Chatbot (Inactive)';
                if (inactiveChatbot.is_temporary && inactiveChatbot.personality_prompt) {
                    description = inactiveChatbot.personality_prompt + ' (Inactive)';
                } else if (!inactiveChatbot.is_temporary) {
                    description = (inactiveChatbot.prompt || 'AI Chatbot') + ' (Inactive)';
                }
                
                return res.json({
                    username: cleanUsername,
                    is_chatbot: true,
                    description: description,
                    bot_type: inactiveChatbot.llm_model || 'default',
                    is_active: false,
                    is_anonymous: false
                });
            }
            
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get user stats if available
        const accountService = require('../services/AccountService');
        const userStats = await accountService.getUserStats(user.id);
        
        // Return only public information
        res.json({
            username: user.username,
            avatar_url: user.avatar_url,
            description: user.description,
            is_admin: user.is_admin,
            is_moderator: user.is_moderator,
            created_at: user.created_at,
            is_anonymous: false,
            is_chatbot: false,
            // Include stats if available
            points_balance: userStats?.points_balance || 0,
            total_stream_time: userStats?.total_stream_time || 0,
            total_view_time: userStats?.total_view_time || 0,
            stream_count: userStats?.stream_count || 0
        });
    } catch (error) {
        console.error('Get user profile error:', error);
        res.status(500).json({ error: 'Failed to get user profile' });
    }
});

router.get('/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/check-username/:username', async (req, res) => {
    try {
        const { username } = req.params;
        
        // Validate username format
        if (!username.match(/^[a-zA-Z0-9_]+$/) || username.length < 3 || username.length > 20) {
            return res.json({ 
                available: false, 
                error: 'Username must be 3-20 characters and contain only letters, numbers, and underscores' 
            });
        }
        
        const existingUser = await authService.accountService.getUserByUsername(username);
        
        res.json({ 
            available: !existingUser,
            username: username 
        });
    } catch (error) {
        console.error('Username check error:', error);
        res.status(500).json({ error: 'Failed to check username availability' });
    }
});

router.post('/complete-oauth-registration', async (req, res) => {
    try {
        const { tempToken, username } = req.body;
        
        console.log('OAuth registration attempt:', { hasToken: !!tempToken, username });
        
        if (!tempToken || !username) {
            return res.status(400).json({ error: 'Temporary token and username are required' });
        }
        
        // Verify and decode the temporary token
        const decoded = authService.verifyToken(tempToken);
        
        console.log('Decoded token:', { 
            hasDecoded: !!decoded, 
            tempOAuth: decoded?.tempOAuth,
            oauthProvider: decoded?.oauthProvider,
            email: decoded?.email 
        });
        
        if (!decoded || !decoded.tempOAuth) {
            return res.status(400).json({ error: 'Invalid or expired temporary token' });
        }
        
        // Validate username format
        if (!username.match(/^[a-zA-Z0-9_]+$/) || username.length < 3 || username.length > 20) {
            return res.status(400).json({ error: 'Username must be 3-20 characters and contain only letters, numbers, and underscores' });
        }
        
        // Complete the OAuth registration with the selected username
        const result = await authService.completeOAuthRegistration(decoded, username);
        
        const ipAddress = req.ip || req.connection.remoteAddress;
        const sessionService = req.app.get('sessionService');
        
        if (sessionService && ipAddress) {
            const sessionData = sessionService.getSessionByIp(ipAddress);
            if (sessionData && !sessionData.userId) {
                await authService.transferSessionToUser(result.user.id, ipAddress, sessionData);
                sessionService.linkUserToSession(ipAddress, result.user.id);
                
                // Restart time tracking for existing active sessions after OAuth registration
                const timeTrackingService = req.app.get('timeTrackingService');
                if (timeTrackingService) {
                    await timeTrackingService.restartSessionsAfterLogin(result.user.id, ipAddress);
                }
            }
        }
        
        res.json({
            message: 'OAuth registration completed successfully',
            user: result.user,
            token: result.token,
            refreshToken: result.refreshToken
        });
    } catch (error) {
        console.error('OAuth registration completion error:', error);
        res.status(400).json({ error: error.message });
    }
});

router.get('/google/callback',
    passport.authenticate('google', { session: false }),
    async (req, res) => {
        try {
            const userData = req.user;
            
            // Check if this is a new user who needs to select a username
            if (userData.isNewUser) {
                // Create a temporary token with all OAuth data
                const jwt = require('jsonwebtoken');
                const tempToken = jwt.sign({
                    tempOAuth: true,
                    isNewUser: true,
                    oauthProvider: userData.oauthProvider,
                    oauthId: userData.oauthId,
                    email: userData.email,
                    displayName: userData.displayName,
                    suggestedUsername: userData.suggestedUsername
                }, process.env.JWT_SECRET || '***REMOVED-JWT-DEFAULT***', {
                    expiresIn: '1h' // Short expiry for security
                });
                
                // Redirect to username selection page
                res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/complete-registration?tempToken=${tempToken}`);
            } else {
                // Existing user - proceed with normal login
                const token = authService.generateToken(userData);
                const refreshToken = authService.generateRefreshToken(userData);

                const ipAddress = req.ip || req.connection.remoteAddress;
                const sessionService = req.app.get('sessionService');
                
                if (sessionService && ipAddress) {
                    const sessionData = sessionService.getSessionByIp(ipAddress);
                    if (sessionData && !sessionData.userId) {
                        await authService.transferSessionToUser(userData.id, ipAddress, sessionData);
                        sessionService.linkUserToSession(ipAddress, userData.id);
                        
                        // Restart time tracking for existing active sessions after OAuth login
                        const timeTrackingService = req.app.get('timeTrackingService');
                        if (timeTrackingService) {
                            await timeTrackingService.restartSessionsAfterLogin(userData.id, ipAddress);
                        }
                    }
                }

                res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/success?token=${token}&refreshToken=${refreshToken}`);
            }
        } catch (error) {
            console.error('Google auth callback error:', error);
            res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/error`);
        }
    }
);

// Account deletion routes
router.post('/request-deletion', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await authService.requestAccountDeletion(userId);
        
        res.json({
            success: true,
            message: 'Account deletion requested. Please check your email to confirm.'
        });
    } catch (error) {
        console.error('Account deletion request error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to request account deletion' 
        });
    }
});

router.post('/confirm-deletion', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ 
                success: false,
                error: 'Deletion token is required' 
            });
        }
        
        const result = await authService.confirmAccountDeletion(token);
        
        res.json({
            success: true,
            message: 'Account deletion confirmed. Your account will be permanently deleted in 15 days.'
        });
    } catch (error) {
        console.error('Account deletion confirmation error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to confirm account deletion' 
        });
    }
});

router.post('/restore-account', async (req, res) => {
    try {
        // Check if authenticated via token
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        
        if (token) {
            // Token-based restoration for already logged-in users
            const decoded = authService.verifyToken(token);
            if (decoded) {
                const userId = decoded.id;
                const restored = await authService.accountService.restoreAccount(userId);
                
                if (restored) {
                    // Get updated user data
                    const user = await authService.accountService.getUserById(userId);
                    const newToken = authService.generateToken(user);
                    const refreshToken = authService.generateRefreshToken(user);
                    
                    res.json({
                        success: true,
                        user: {
                            id: user.id,
                            email: user.email,
                            username: user.username,
                            isVerified: user.is_verified,
                            isAdmin: user.is_admin === 1,
                            isModerator: user.is_moderator === 1,
                            accountStatus: 'active'
                        },
                        token: newToken,
                        refreshToken: refreshToken,
                        message: 'Account successfully restored'
                    });
                    return;
                }
            }
        }
        
        // Fall back to password-based restoration
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ 
                success: false,
                error: 'Email and password are required' 
            });
        }
        
        const result = await authService.restoreAccount(email, password);
        
        if (result.success) {
            res.json({
                success: true,
                user: result.user,
                token: result.token,
                refreshToken: result.refreshToken,
                message: 'Account successfully restored'
            });
        } else {
            res.status(400).json({ 
                success: false,
                error: result.error || 'Failed to restore account' 
            });
        }
    } catch (error) {
        console.error('Account restoration error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to restore account' 
        });
    }
});

// Admin routes
router.get('/admin/users', authenticateAdmin, async (req, res) => {
    try {
        const { search, limit = 50 } = req.query;
        let users;
        
        if (search) {
            users = await authService.accountService.searchUsers(search, parseInt(limit));
        } else {
            users = await authService.accountService.getAllUsers(parseInt(limit));
        }
        
        res.json({ users });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

router.post('/admin/users/:id/promote', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot modify your own admin status' });
        }
        
        await authService.accountService.promoteToAdmin(userId);
        res.json({ message: 'User promoted to admin' });
    } catch (error) {
        console.error('Promote user error:', error);
        res.status(500).json({ error: 'Failed to promote user' });
    }
});

router.post('/admin/users/:id/demote', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot modify your own admin status' });
        }
        
        await authService.accountService.demoteFromAdmin(userId);
        res.json({ message: 'User demoted from admin' });
    } catch (error) {
        console.error('Demote user error:', error);
        res.status(500).json({ error: 'Failed to demote user' });
    }
});

router.post('/admin/users/:id/ban', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot ban yourself' });
        }
        
        await authService.accountService.banUser(userId);
        res.json({ message: 'User banned' });
    } catch (error) {
        console.error('Ban user error:', error);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

router.post('/admin/users/:id/unban', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        await authService.accountService.unbanUser(userId);
        res.json({ message: 'User unbanned' });
    } catch (error) {
        console.error('Unban user error:', error);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

router.delete('/admin/users/:id', authenticateAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        
        await authService.accountService.deleteUser(userId);
        res.json({ message: 'User deleted' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

module.exports = router;