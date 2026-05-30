const express = require('express');
const { authenticateToken } = require('../../middleware/auth');

// Email-verification surface (verify-email + resend-verification). Mounted at
// '/' by the parent so paths/methods/middleware are byte-for-byte identical to
// the prior monolithic router.
module.exports = function createEmailVerifyRouter({ logger, authService }) {
    const router = express.Router();

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
                            logger.debug(`🎁 WELCOME: Granted 5 tomatoes to user ${result.userId}`);
                        }

                        // Grant 1 heart swarm
                        if (heartSwarm) {
                            await inventoryService.addItemToInventory(result.userId, heartSwarm.id, 1);
                            logger.debug(`🎁 WELCOME: Granted 1 heart swarm to user ${result.userId}`);
                        }
                    } catch (grantError) {
                        logger.error('Error granting starter items:', grantError);
                        // Don't fail verification if item granting fails
                    }
                }
            }

            res.json({ message: 'Email verified successfully' });
        } catch (error) {
            logger.error('Email verification error:', error);
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
            logger.error('Resend verification error:', error);
            res.status(500).json({ error: 'Failed to resend verification email' });
        }
    });

    return router;
};
