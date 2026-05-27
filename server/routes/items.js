const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'items' });

const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const DrawingService = require('../services/DrawingService');
const ThrowingService = require('../services/ThrowingService');
const ItemUseService = require('../services/ItemUseService');
const ChatNotifier = require('../services/ChatNotifier');

// Single ChatNotifier instance shared across all item services so we have
// one place to swap the chat transport / inject in tests. PR-J/J2/J3.
const chatNotifier = new ChatNotifier();
const sendSystemMessage = chatNotifier.send;

const drawingService = new DrawingService();
const throwingService = new ThrowingService();
const itemUseService = new ItemUseService();

// Debug middleware for all item routes
router.use((req, res, next) => {
    if (req.path.includes('/inventory/use/')) {
        logger.debug(`🔴🔴🔴 FART DEBUG MIDDLEWARE: ${req.method} ${req.path}`);
        logger.debug(`🔴🔴🔴 FART DEBUG: Full URL: ${req.originalUrl}`);
    }
    next();
});

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

// Inventory endpoints
router.get('/inventory', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const inventoryService = req.app.get('inventoryService');
        const inventory = await inventoryService.getUserInventory(userId);
        res.json(inventory);
    } catch (error) {
        logger.error('Error fetching inventory:', error);
        res.status(500).json({ error: 'Failed to fetch inventory' });
    }
});

router.post('/inventory/use/:itemId', authenticateToken, async (req, res) => {
    logger.debug(`🚨🚨🚨 FART DEBUG: Request received at /inventory/use/${req.params.itemId}`);
    logger.debug(`🚨🚨🚨 FART DEBUG: User: ${req.user?.username || 'unknown'}, Method: ${req.method}`);
    logger.debug(`🚨🚨🚨 FART DEBUG: Headers:`, req.headers);
    logger.debug(`🚀 ITEMS: ===== ITEM USAGE REQUEST RECEIVED =====`);
    const userId = req.user.userId || req.user.id;
    logger.debug(`🚀 ITEMS: Starting item usage for item ID ${req.params.itemId} by user ${userId} (${req.user.username})`);
    logger.debug(`🚀 ITEMS: User: ${req.user.username}`);
    try {
        const result = await itemUseService.useItem({
            user: req.user,
            itemId: req.params.itemId,
            body: req.body,
            services: {
                inventoryService: req.app.get('inventoryService'),
                itemService: req.app.get('itemService'),
                streamService: req.app.get('streamService'),
                canvasFxService: req.app.get('canvasFxService'),
                buffDebuffService: req.app.get('buffDebuffService'),
                takeoverService: req.app.get('takeoverService'),
                soundFxService: req.app.get('soundFxService'),
                mediasoupService: req.app.get('mediasoupService')
            },
            io: req.app.get('io'),
            sessionService: req.app.get('sessionService'),
            buffNotifier: req.app.get('buffNotifier'),
            sendSystemMessage
        });

        if (!result.ok) {
            switch (result.kind) {
                case 'item-not-found':
                    return res.status(404).json({ error: 'Item not found' });
                case 'not-in-inventory':
                    return res.status(400).json({ error: 'Item not in inventory or insufficient quantity' });
                case 'no-active-stream':
                    return res.status(400).json({
                        error: 'No active stream',
                        message: 'Interactive items can only be used when someone is streaming. Please wait for a streamer to start.',
                        requiresStream: true
                    });
                case 'no-streamer-target':
                    return res.status(400).json({ error: 'No active streamer found to apply buff/debuff' });
                case 'no-active-streamer-killswitch':
                    return res.status(400).json({ error: 'No active streamer to disconnect' });
                case 'service-unavailable':
                    if (result.service === 'buffDebuffService') {
                        return res.status(500).json({ error: 'Buff/Debuff service not available' });
                    }
                    if (result.service === 'takeoverService') {
                        return res.status(500).json({ error: 'Takeover service not available' });
                    }
                    return res.status(500).json({ error: 'Service not available' });
                case 'killswitch-failed':
                    return res.status(500).json({ error: 'Kill Switch unavailable - required services not found' });
                case 'validation-failed': {
                    const body = { error: result.error };
                    if (result.cooldownRemaining !== undefined) {
                        body.cooldownRemaining = result.cooldownRemaining;
                    }
                    return res.status(429).json(body);
                }
                case 'cooldown':
                    return res.status(429).json({ error: result.message });
                case 'error':
                default:
                    return res.status(500).json({ error: result.message || 'Failed to use item' });
            }
        }

        return res.status(result.status || 200).json(result.body);
    } catch (error) {
        logger.error('Error using item:', error);

        if (error.message.includes('cooldown')) {
            return res.status(429).json({ error: error.message });
        }

        res.status(500).json({ error: error.message || 'Failed to use item' });
    }
});

// New endpoint for throwing interactive items at specific coordinates
// Endpoint for consuming drawing/marker items when drawing starts
router.post('/inventory/drawing-start', authenticateToken, async (req, res) => {
    try {
        const result = await drawingService.startDrawing({
            user: req.user,
            item: req.body.item,
            services: {
                inventoryService: req.app.get('inventoryService'),
                canvasFxService: req.app.get('canvasFxService'),
                streamService: req.app.get('streamService')
            },
            io: req.app.get('io'),
            sessionService: req.app.get('sessionService'),
            buffNotifier: req.app.get('buffNotifier'),
            sendSystemMessage
        });

        if (!result.ok) {
            switch (result.kind) {
                case 'missing-item':
                    return res.status(400).json({ error: 'Missing required parameter: item' });
                case 'no-active-stream':
                    return res.status(400).json({
                        error: 'No active stream',
                        message: 'You can only draw when someone is streaming. Please wait for a streamer to start.',
                        requiresStream: true
                    });
                case 'cooldown':
                    return res.status(429).json({ error: result.message });
                case 'error':
                default:
                    return res.status(500).json({ error: result.message || 'Failed to start drawing' });
            }
        }

        res.json({
            success: true,
            item: result.item, // Include the full item with cooldown
            message: result.displayMessage,
            remainingQuantity: result.remainingQuantity
        });
    } catch (error) {
        logger.error('Error starting drawing:', error);

        if (error.message && error.message.includes('cooldown')) {
            return res.status(429).json({ error: error.message });
        }

        res.status(500).json({ error: error.message || 'Failed to start drawing' });
    }
});

router.post('/inventory/throw', authenticateToken, async (req, res) => {
    try {
        const result = await throwingService.startThrow({
            user: req.user,
            body: req.body,
            services: {
                inventoryService: req.app.get('inventoryService'),
                canvasFxService: req.app.get('canvasFxService'),
                itemService: req.app.get('itemService'),
                streamService: req.app.get('streamService'),
                buffDebuffService: req.app.get('buffDebuffService'),
                mediasoupService: req.app.get('mediasoupService')
            },
            io: req.app.get('io'),
            sessionService: req.app.get('sessionService'),
            buffNotifier: req.app.get('buffNotifier'),
            sendSystemMessage
        });

        if (!result.ok) {
            switch (result.kind) {
                case 'missing-params':
                    return res.status(400).json({ error: 'Missing required parameters: x, y, item, username' });
                case 'no-active-stream':
                    return res.status(400).json({
                        error: 'No active stream',
                        message: 'You can only throw items when someone is streaming. Please wait for a streamer to start.',
                        requiresStream: true
                    });
                case 'cooldown':
                    return res.status(429).json({ error: result.message });
                case 'no-canvas-fx':
                    return res.status(500).json({ error: 'Canvas FX service not available' });
                case 'effect-failed':
                    return res.status(500).json({ error: 'Failed to trigger effect' });
                case 'error':
                default:
                    return res.status(500).json({ error: result.message || 'Failed to throw item' });
            }
        }

        res.json({
            success: true,
            item: result.item, // Include the full item with cooldown
            effect: result.effect,
            message: result.displayMessage,
            remainingQuantity: result.remainingQuantity
        });
    } catch (error) {
        logger.error('Error throwing item:', error);

        if (error.message && error.message.includes('cooldown')) {
            return res.status(429).json({ error: error.message });
        }

        res.status(500).json({ error: error.message || 'Failed to throw item' });
    }
});

router.get('/inventory/cooldowns', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const itemService = req.app.get('itemService');
        const takeoverService = req.app.get('takeoverService');
        
        const itemCooldowns = await itemService.getItemCooldowns(userId);
        
        let response = { itemCooldowns };
        
        // Add global cooldown info if takeoverService is available
        if (takeoverService) {
            const globalCooldownInfo = await itemService.getGlobalCooldownInfo(takeoverService);
            response.globalCooldown = globalCooldownInfo;
        }
        
        res.json(response);
    } catch (error) {
        logger.error('Error fetching cooldowns:', error);
        res.status(500).json({ error: 'Failed to fetch cooldowns' });
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

router.get('/inventory/value', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const inventoryService = req.app.get('inventoryService');
        const value = await inventoryService.getUserInventoryValue(userId);
        res.json(value);
    } catch (error) {
        logger.error('Error fetching inventory value:', error);
        res.status(500).json({ error: 'Failed to fetch inventory value' });
    }
});

// Shop endpoints
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

// Summon Bot endpoint - handles the actual bot creation after user provides details
router.post('/inventory/summon-bot/:itemId', authenticateToken, async (req, res) => {
    logger.debug(`🤖 SUMMON BOT: Request received for item ${req.params.itemId} by user ${req.user.username}`);
    
    try {
        const userId = req.user.userId || req.user.id;
        const { botName, personalityPrompt } = req.body;
        const inventoryService = req.app.get('inventoryService');
        const itemService = req.app.get('itemService');
        const chatBotService = req.app.get('chatBotService');
        
        // Import and use ProfanityFilterService
        const ProfanityFilterService = require('../services/ProfanityFilterService');
        const profanityFilter = new ProfanityFilterService();
        
        // Get item details
        const item = await itemService.getItemById(req.params.itemId);
        if (!item || (item.name !== 'summon_bot' && item.name !== 'summon_lesser_bot')) {
            return res.status(400).json({ error: 'Invalid item' });
        }
        
        // Validate bot name
        const nameValidation = profanityFilter.validateBotName(botName);
        if (!nameValidation.isValid) {
            logger.debug(`🚫 SUMMON BOT: Name validation failed: ${nameValidation.error}`);
            return res.status(400).json({ error: nameValidation.error });
        }
        
        // Validate personality prompt
        const promptValidation = profanityFilter.validatePersonalityPrompt(personalityPrompt);
        if (!promptValidation.isValid) {
            logger.debug(`🚫 SUMMON BOT: Prompt validation failed: ${promptValidation.error}`);
            return res.status(400).json({ error: promptValidation.error });
        }
        
        // Validate inventory and cooldown
        const inventoryItem = await inventoryService.getInventoryItem(userId, req.params.itemId);
        if (!inventoryItem || inventoryItem.quantity < 1) {
            return res.status(400).json({ error: 'Item not in inventory or insufficient quantity' });
        }
        
        const validation = await itemService.validateItemUsage(userId, req.params.itemId);
        if (!validation.valid) {
            return res.status(429).json({ 
                error: validation.error || 'Cannot use item',
                cooldownRemaining: validation.cooldownRemaining 
            });
        }
        
        // Parse effect data for bot duration
        const effectData = item.effect_data ? JSON.parse(item.effect_data) : {};
        const botDuration = effectData.bot_duration || 3600; // Default 1 hour
        
        // Create the temporary bot
        const bot = await chatBotService.createTemporaryBot({
            name: botName.trim(),
            personalityPrompt: personalityPrompt.trim(),
            summonedBy: userId,
            summonedByUsername: req.user.username,
            duration: botDuration,
            itemId: item.id,
            llmModel: 'openai',
            temperature: 0.8
        });
        
        // Consume the item
        const usageResult = await inventoryService.useItem(
            userId, 
            req.params.itemId,
            null // streamId
        );
        
        logger.debug(`✅ SUMMON BOT: Bot "${botName}" created successfully by ${req.user.username}`);
        
        // Send a chat notification with all details
        let durationText;
        if (botDuration < 3600) {
            const durationInMinutes = Math.round(botDuration / 60);
            durationText = durationInMinutes === 1 ? '1 minute' : `${durationInMinutes} minutes`;
        } else {
            const durationInHours = Math.round(botDuration / 3600);
            durationText = durationInHours === 1 ? '1 hour' : `${durationInHours} hours`;
        }
        
        const chatMessage = `🤖 ${req.user.username} has summoned "${botName}" to the chat!\n` +
            `⏱️ Duration: ${durationText}\n` +
            `💭 Personality: "${personalityPrompt.trim()}"`;
        
        logger.debug(`📤 SUMMON BOT: Attempting to send chat message: "${chatMessage}"`);
        
        try {
            const messageResult = await sendSystemMessage(chatMessage, '🤖 StreamBot');
            logger.debug(`✅ SUMMON BOT: Chat message sent successfully:`, messageResult);
        } catch (msgError) {
            logger.error(`❌ SUMMON BOT: Failed to send chat message:`, msgError);
        }
        
        // Also emit socket message for real-time notification
        const io = req.app.get('io');
        if (io) {
            io.emit('system-message', {
                message: `🤖 ${req.user.username} has summoned "${botName}" to the chat! Duration: ${durationText}. Personality: "${personalityPrompt.trim()}"`,
                timestamp: Date.now(),
                type: 'bot-summoned'
            });
        }
        
        res.json({
            success: true,
            bot: {
                id: bot.id,
                name: bot.name,
                expiresAt: bot.expires_at
            },
            remainingQuantity: usageResult.remainingQuantity,
            message: `Bot "${botName}" has been summoned!`
        });
        
    } catch (error) {
        logger.error('❌ SUMMON BOT: Error creating bot:', error);
        res.status(500).json({ error: 'Failed to summon bot' });
    }
});

module.exports = router;
