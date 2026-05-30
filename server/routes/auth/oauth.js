const express = require('express');
const passport = require('passport');

// Google OAuth surface: the redirect entrypoint, the callback, and the
// complete-oauth-registration step for new users. Mounted at '/' by the parent
// so paths/methods/middleware are byte-for-byte identical to the prior
// monolithic router. JWT_SECRET is injected so the temp-token signing in the
// callback matches the prior module-scoped requireEnv('JWT_SECRET').
module.exports = function createOAuthRouter({ logger, authService, JWT_SECRET }) {
    const router = express.Router();

    router.get('/google',
        passport.authenticate('google', { scope: ['profile', 'email'] })
    );

    router.post('/complete-oauth-registration', async (req, res) => {
        try {
            const { tempToken, username } = req.body;

            logger.debug('OAuth registration attempt:', { hasToken: !!tempToken, username });

            if (!tempToken || !username) {
                return res.status(400).json({ error: 'Temporary token and username are required' });
            }

            // Verify and decode the temporary token
            const decoded = authService.verifyToken(tempToken);

            logger.debug('Decoded token:', {
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
            logger.error('OAuth registration completion error:', error);
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
                    }, JWT_SECRET, {
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
                logger.error('Google auth callback error:', error);
                res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/error`);
            }
        }
    );

    return router;
};
