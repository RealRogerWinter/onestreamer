const express = require('express');
const { requireTurnstile } = require('../../middleware/turnstile');
const { ipFromRequest } = require('../../utils/clientIp');

// S11: lightweight in-memory per-IP rate limiter for the unauthenticated
// password endpoints (no express-rate-limit dependency; mirrors the Map-based
// limiters already used elsewhere in the codebase). Bounds brute-force of the
// reset token and abuse of the reset-email sender. Best-effort per-process —
// fine behind the single app process; a distributed limiter would need Redis.
function createIpRateLimiter({ windowMs, max }) {
    const hits = new Map(); // ip -> { count, resetAt }
    return function rateLimit(req, res, next) {
        const ip = ipFromRequest(req);
        const now = Date.now();
        let entry = hits.get(ip);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(ip, entry);
        }
        entry.count += 1;
        // Opportunistic prune so the map can't grow unbounded.
        if (hits.size > 5000) {
            for (const [k, v] of hits) { if (now >= v.resetAt) hits.delete(k); }
        }
        if (entry.count > max) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        next();
    };
}

// Password forgot/reset surface. Mounted at '/' by the parent so
// paths/methods/middleware are byte-for-byte identical to the prior monolithic
// router.
module.exports = function createPasswordRouter({ logger, authService }) {
    const router = express.Router();

    // 10 requests / 15 min / IP on each password endpoint.
    const passwordRateLimit = createIpRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

    router.post('/forgot-password', passwordRateLimit, requireTurnstile, async (req, res) => {
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

    // S11: reset-password now carries the same rate limit + Turnstile gate as
    // forgot-password (it had neither — token brute-force + no bot check), and
    // the password policy is enforced server-side in AccountService.
    router.post('/reset-password', passwordRateLimit, requireTurnstile, async (req, res) => {
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
