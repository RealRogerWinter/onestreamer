const express = require('express');
const { validationResult } = require('express-validator');
const { requireTurnstile } = require('../../middleware/turnstile');

// Registration / username-availability surface. Mounted at '/' by the parent
// so paths/methods/middleware/validation are byte-for-byte identical to the
// prior monolithic router. Deps (logger, authService, validateSignup) are
// injected so a single module-scoped AuthService instance is shared, matching
// the prior behavior.
module.exports = function createRegisterRouter({ logger, authService, validateSignup }) {
    const router = express.Router();

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
            logger.error('Signup error:', error);
            res.status(400).json({ error: error.message });
        }
    });

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
            logger.error('Username check error:', error);
            res.status(500).json({ error: 'Failed to check username availability' });
        }
    });

    return router;
};
