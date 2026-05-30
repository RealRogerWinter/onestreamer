const express = require('express');

/**
 * Public catalog / shop read endpoints (no auth). Handlers moved verbatim from
 * the former monolithic server/routes/items.js.
 *
 * @param {{ logger: import('pino').Logger }} deps
 */
module.exports = function createCatalogRouter({ logger }) {
    const router = express.Router();

    // Items endpoints
    router.get('/items', async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const { category } = req.query;

            let items;
            if (category && category !== 'all') {
                items = await itemService.getItemsByCategory(category);
            } else {
                items = await itemService.getAllItems();
            }

            res.json(items);
        } catch (error) {
            logger.error('Error fetching items:', error);
            res.status(500).json({ error: 'Failed to fetch items' });
        }
    });

    // Get all unique categories
    router.get('/items/categories/list', async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const categories = await itemService.getAllCategories();
            res.json(categories);
        } catch (error) {
            logger.error('Error fetching categories:', error);
            res.status(500).json({ error: 'Failed to fetch categories' });
        }
    });

    router.get('/items/:id', async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const item = await itemService.getItemById(req.params.id);

            if (!item) {
                return res.status(404).json({ error: 'Item not found' });
            }

            res.json(item);
        } catch (error) {
            logger.error('Error fetching item:', error);
            res.status(500).json({ error: 'Failed to fetch item' });
        }
    });

    // Endpoint to get current cooldown status (public, no auth required)
    router.get('/cooldown/status', async (req, res) => {
        try {
            const takeoverService = req.app.get('takeoverService');
            const itemService = req.app.get('itemService');

            if (!takeoverService || !itemService) {
                return res.status(500).json({ error: 'Required services not available' });
            }

            const globalCooldownInfo = await itemService.getGlobalCooldownInfo(takeoverService);
            const allCooldowns = await takeoverService.getAllCooldowns();

            // Debug info
            const debugInfo = {
                lastStreamStartTime: takeoverService.lastStreamStartTime,
                hasActiveStream: !!takeoverService.lastStreamStartTime,
                globalCooldownSeconds: takeoverService.globalCooldownSeconds,
                individualCooldownSeconds: takeoverService.individualCooldownSeconds
            };

            logger.debug('🔍 COOLDOWN STATUS DEBUG:', debugInfo);

            res.json({
                globalCooldown: globalCooldownInfo,
                individualCooldowns: allCooldowns.length,
                debug: debugInfo,
                timestamp: Date.now(),
                version: "debug-enhanced"
            });
        } catch (error) {
            logger.error('Error fetching cooldown status:', error);
            res.status(500).json({ error: 'Failed to fetch cooldown status' });
        }
    });

    // Shop endpoints (public reads)
    router.get('/shop', async (req, res) => {
        try {
            const shopService = req.app.get('shopService');
            const items = await shopService.getShopItems();
            res.json(items);
        } catch (error) {
            logger.error('Error fetching shop items:', error);
            res.status(500).json({ error: 'Failed to fetch shop items' });
        }
    });

    router.get('/shop/featured', async (req, res) => {
        try {
            const shopService = req.app.get('shopService');
            const items = await shopService.getFeaturedItems();
            res.json(items);
        } catch (error) {
            logger.error('Error fetching featured items:', error);
            res.status(500).json({ error: 'Failed to fetch featured items' });
        }
    });

    router.get('/shop/discounted', async (req, res) => {
        try {
            const shopService = req.app.get('shopService');
            const items = await shopService.getDiscountedItems();
            res.json(items);
        } catch (error) {
            logger.error('Error fetching discounted items:', error);
            res.status(500).json({ error: 'Failed to fetch discounted items' });
        }
    });

    return router;
};
