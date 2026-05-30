const express = require('express');
const { validationResult } = require('express-validator');
const { requireTurnstile } = require('../../middleware/turnstile');
const { authenticateToken } = require('../../middleware/auth');

// Login / logout / token-refresh surface. Mounted at '/' by the parent so
// paths/methods/middleware/validation are byte-for-byte identical to the prior
// monolithic router.
module.exports = function createLoginRouter({ logger, authService, validateLogin }) {
    const router = express.Router();

    router.post('/login', requireTurnstile, validateLogin, async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { email, password } = req.body;
            logger.debug('🔐 Login attempt:', { email, passwordLength: password ? password.length : 0 });
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
            logger.error('Login error:', error);
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
            logger.error('Token refresh error:', error);
            res.status(401).json({ error: 'Invalid refresh token' });
        }
    });

    return router;
};
