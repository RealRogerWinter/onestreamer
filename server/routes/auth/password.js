const express = require('express');
const { requireTurnstile } = require('../../middleware/turnstile');

// Password forgot/reset surface. Mounted at '/' by the parent so
// paths/methods/middleware are byte-for-byte identical to the prior monolithic
// router.
module.exports = function createPasswordRouter({ logger, authService }) {
    const router = express.Router();

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
            logger.error('Password reset request error:', error);
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
            logger.error('Password reset error:', error);
            res.status(400).json({ error: error.message });
        }
    });

    return router;
};
