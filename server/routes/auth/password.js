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
            // Fire the reset (emails the token). Never return the token to the
            // caller: doing so is a full account-takeover for any known email.
            // Also respond identically whether or not the email resolves, to
            // close the account-enumeration oracle (was 404 vs 200).
            await authService.requestPasswordReset(email);
        } catch (error) {
            // Swallow to preserve the uniform response; log for ops.
            logger.error({ err: error }, 'Password reset request error');
        }
        res.json({
            message: 'If that email is registered, a password reset link has been sent.'
        });
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
