const express = require('express');
const { authenticateToken } = require('../../middleware/auth');

// Account deletion / restoration surface. Mounted at '/' by the parent so
// paths/methods/middleware are byte-for-byte identical to the prior monolithic
// router.
module.exports = function createAccountRouter({ logger, authService }) {
    const router = express.Router();

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
            logger.error('Account deletion request error:', error);
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
            logger.error('Account deletion confirmation error:', error);
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
            logger.error('Account restoration error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to restore account'
            });
        }
    });

    return router;
};
