const express = require('express');
const { authenticateToken } = require('../../middleware/auth');

/**
 * Shop purchase / sell endpoints (authenticateToken). Handlers moved verbatim
 * from the former monolithic server/routes/items.js.
 *
 * @param {{ logger: import('pino').Logger }} deps
 */
module.exports = function createPurchaseRouter({ logger }) {
    const router = express.Router();

    router.post('/shop/purchase', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId || req.user.id;
            const { itemId, quantity = 1 } = req.body;

            if (!itemId) {
                return res.status(400).json({ error: 'Item ID required' });
            }

            const shopService = req.app.get('shopService');
            const result = await shopService.purchaseItem(userId, itemId, quantity);

            // Emit socket event for purchase
            const io = req.app.get('io');
            const sessionService = req.app.get('sessionService');
            const buffNotifier = req.app.get('buffNotifier');
            if (io && sessionService && buffNotifier) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    buffNotifier.inventoryUpdated({
                        toSocketId: socketId,
                        action: 'purchase',
                        itemId,
                        quantity,
                    });
                });
            }

            res.json(result);
        } catch (error) {
            logger.error('Error purchasing item:', error);

            if (error.message.includes('Insufficient points')) {
                return res.status(402).json({ error: error.message });
            }

            res.status(500).json({ error: error.message || 'Failed to purchase item' });
        }
    });

    router.post('/shop/sell', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId || req.user.id;
            const { itemId, quantity = 1 } = req.body;

            if (!itemId) {
                return res.status(400).json({ error: 'Item ID required' });
            }

            const shopService = req.app.get('shopService');
            const result = await shopService.sellItem(userId, itemId, quantity);

            // Emit socket event for sale
            const io = req.app.get('io');
            const sessionService = req.app.get('sessionService');
            const buffNotifier = req.app.get('buffNotifier');
            if (io && sessionService && buffNotifier) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    buffNotifier.inventoryUpdated({
                        toSocketId: socketId,
                        action: 'sell',
                        itemId,
                        quantity,
                    });
                });
            }

            res.json(result);
        } catch (error) {
            logger.error('Error selling item:', error);
            res.status(500).json({ error: error.message || 'Failed to sell item' });
        }
    });

    return router;
};
