const express = require('express');
const router = express.Router();
const passport = require('passport');
const { body, validationResult } = require('express-validator');
const AuthService = require('../services/AuthService');
const SessionService = require('../services/SessionService');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');

const authService = new AuthService();

const validateSignup = [
    body('email').isEmail().normalizeEmail(),
    body('username').isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/),
    body('password').isLength({ min: 6 })
];

const validateLogin = [
    body('email').notEmpty().trim(), // Accept email or username
    body('password').notEmpty()
];

router.post('/signup', validateSignup, async (req, res) => {
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

router.post('/login', validateLogin, async (req, res) => {
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
        await authService.verifyEmail(token);
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

router.post('/forgot-password', async (req, res) => {
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
                canChangeUsername
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

router.get('/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/google/callback',
    passport.authenticate('google', { session: false }),
    async (req, res) => {
        try {
            const user = req.user;
            const token = authService.generateToken(user);
            const refreshToken = authService.generateRefreshToken(user);

            const ipAddress = req.ip || req.connection.remoteAddress;
            const sessionService = req.app.get('sessionService');
            
            if (sessionService && ipAddress) {
                const sessionData = sessionService.getSessionByIp(ipAddress);
                if (sessionData && !sessionData.userId) {
                    await authService.transferSessionToUser(user.id, ipAddress, sessionData);
                    sessionService.linkUserToSession(ipAddress, user.id);
                    
                    // Restart time tracking for existing active sessions after OAuth login
                    const timeTrackingService = req.app.get('timeTrackingService');
                    if (timeTrackingService) {
                        await timeTrackingService.restartSessionsAfterLogin(user.id, ipAddress);
                    }
                }
            }

            res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/success?token=${token}&refreshToken=${refreshToken}`);
        } catch (error) {
            console.error('Google auth callback error:', error);
            res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/error`);
        }
    }
);

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