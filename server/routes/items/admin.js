const express = require('express');
const { authenticateAdmin } = require('../../middleware/auth');

/**
 * Admin-gated item / shop / inventory management endpoints. Includes the
 * admin-only item CRUD (POST /items, PUT/DELETE /items/:id) plus the /admin/*
 * management surface. Handlers moved verbatim from the former monolithic
 * server/routes/items.js.
 *
 * @param {{ logger: import('pino').Logger }} deps
 */
module.exports = function createAdminRouter({ logger }) {
    const router = express.Router();

    // Item CRUD (admin)
    router.post('/items', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const item = await itemService.createItem(req.body);
            res.status(201).json(item);
        } catch (error) {
            logger.error('Error creating item:', error);
            res.status(500).json({ error: 'Failed to create item' });
        }
    });

    router.put('/items/:id', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const item = await itemService.updateItem(req.params.id, req.body);
            res.json(item);
        } catch (error) {
            logger.error('Error updating item:', error);
            res.status(500).json({ error: 'Failed to update item' });
        }
    });

    router.delete('/items/:id', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            await itemService.deleteItem(req.params.id);
            res.json({ success: true });
        } catch (error) {
            logger.error('Error deleting item:', error);
            res.status(500).json({ error: 'Failed to delete item' });
        }
    });

    // Admin endpoints
    router.post('/admin/items/grant', authenticateAdmin, async (req, res) => {
        try {
            const { userId, itemId, quantity = 1 } = req.body;

            if (!userId || !itemId) {
                return res.status(400).json({ error: 'User ID and Item ID required' });
            }

            const inventoryService = req.app.get('inventoryService');
            const result = await inventoryService.grantItemsToUser(userId, itemId, quantity);

            // Emit socket event for item grant
            const io = req.app.get('io');
            const sessionService = req.app.get('sessionService');
            const buffNotifier = req.app.get('buffNotifier');
            if (io && sessionService && buffNotifier) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    buffNotifier.inventoryUpdated({
                        toSocketId: socketId,
                        action: 'grant',
                        itemId,
                        quantity,
                    });
                });
            }

            res.json(result);
        } catch (error) {
            logger.error('Error granting items:', error);
            res.status(500).json({ error: 'Failed to grant items' });
        }
    });

    router.get('/admin/items/stats', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const stats = await itemService.getItemStats();
            res.json(stats);
        } catch (error) {
            logger.error('Error fetching item stats:', error);
            res.status(500).json({ error: 'Failed to fetch item stats' });
        }
    });

    router.get('/admin/shop/stats', authenticateAdmin, async (req, res) => {
        try {
            const shopService = req.app.get('shopService');
            const stats = await shopService.getShopStatistics();
            res.json(stats);
        } catch (error) {
            logger.error('Error fetching shop stats:', error);
            res.status(500).json({ error: 'Failed to fetch shop stats' });
        }
    });

    router.get('/admin/user/:userId/inventory', authenticateAdmin, async (req, res) => {
        try {
            const inventoryService = req.app.get('inventoryService');
            const inventory = await inventoryService.getUserInventory(req.params.userId);
            res.json(inventory);
        } catch (error) {
            logger.error('Error fetching user inventory:', error);
            res.status(500).json({ error: 'Failed to fetch user inventory' });
        }
    });

    router.delete('/admin/user/:userId/inventory', authenticateAdmin, async (req, res) => {
        try {
            const inventoryService = req.app.get('inventoryService');
            const result = await inventoryService.clearUserInventory(req.params.userId);
            res.json(result);
        } catch (error) {
            logger.error('Error clearing user inventory:', error);
            res.status(500).json({ error: 'Failed to clear user inventory' });
        }
    });

    // Admin shop management endpoints
    router.get('/admin/shop', authenticateAdmin, async (req, res) => {
        try {
            const shopService = req.app.get('shopService');
            const items = await shopService.getAllShopItems();
            res.json(items);
        } catch (error) {
            logger.error('Error fetching admin shop items:', error);
            res.status(500).json({ error: 'Failed to fetch shop items' });
        }
    });

    router.post('/admin/shop', authenticateAdmin, async (req, res) => {
        try {
            const { item_id, price, stock_limit, is_featured = false, discount_percentage = 0 } = req.body;

            if (!item_id || !price) {
                return res.status(400).json({ error: 'item_id and price are required' });
            }

            const shopService = req.app.get('shopService');
            const shopItem = await shopService.addItemToShop(item_id, price, {
                stock_limit,
                is_featured,
                discount_percentage
            });
            res.status(201).json(shopItem);
        } catch (error) {
            logger.error('Error adding item to shop:', error);
            res.status(500).json({ error: 'Failed to add item to shop' });
        }
    });

    router.put('/admin/shop/:shopItemId', authenticateAdmin, async (req, res) => {
        try {
            const shopService = req.app.get('shopService');
            const shopItem = await shopService.updateShopItem(req.params.shopItemId, req.body);
            res.json(shopItem);
        } catch (error) {
            logger.error('Error updating shop item:', error);
            res.status(500).json({ error: 'Failed to update shop item' });
        }
    });

    router.delete('/admin/shop/:shopItemId', authenticateAdmin, async (req, res) => {
        try {
            const shopService = req.app.get('shopService');
            await shopService.removeItemFromShop(req.params.shopItemId);
            res.json({ success: true });
        } catch (error) {
            logger.error('Error removing item from shop:', error);
            res.status(500).json({ error: 'Failed to remove item from shop' });
        }
    });

    // Admin items endpoints (aliases for existing endpoints)
    router.get('/admin/items', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const items = await itemService.getAllItems();
            res.json(items);
        } catch (error) {
            logger.error('Error fetching admin items:', error);
            res.status(500).json({ error: 'Failed to fetch items' });
        }
    });

    router.post('/admin/items', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const item = await itemService.createItem(req.body);
            res.status(201).json(item);
        } catch (error) {
            logger.error('Error creating admin item:', error);
            res.status(500).json({ error: 'Failed to create item' });
        }
    });

    router.get('/admin/items/:id', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const item = await itemService.getItemById(req.params.id);

            if (!item) {
                return res.status(404).json({ error: 'Item not found' });
            }

            res.json(item);
        } catch (error) {
            logger.error('Error fetching admin item:', error);
            res.status(500).json({ error: 'Failed to fetch item' });
        }
    });

    router.put('/admin/items/:id', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            const item = await itemService.updateItem(req.params.id, req.body);
            res.json(item);
        } catch (error) {
            logger.error('Error updating admin item:', error);
            res.status(500).json({ error: 'Failed to update item' });
        }
    });

    router.delete('/admin/items/:id', authenticateAdmin, async (req, res) => {
        try {
            const itemService = req.app.get('itemService');
            await itemService.deleteItem(req.params.id);
            res.json({ success: true });
        } catch (error) {
            logger.error('Error deleting admin item:', error);
            res.status(500).json({ error: 'Failed to delete item' });
        }
    });

    // Admin endpoint to reset all cooldowns for the authenticated user
    router.post('/admin/cooldowns/reset', authenticateAdmin, async (req, res) => {
        try {
            const userId = req.user.userId || req.user.id;
            const itemService = req.app.get('itemService');

            // Reset item usage cooldowns for the admin user
            const count = await itemService.resetUserItemCooldowns(userId);

            logger.debug(`🔄 ADMIN: User ${userId} reset ${count} item cooldowns`);

            res.json({
                success: true,
                message: `Reset cooldowns for ${count} item usages`,
                itemsAffected: count
            });
        } catch (error) {
            logger.error('Error resetting user item cooldowns:', error);
            res.status(500).json({ error: 'Failed to reset cooldowns' });
        }
    });

    return router;
};
