const express = require('express');
const { authenticateToken } = require('../../middleware/auth');

/**
 * Authenticated inventory / item-use endpoints. Handlers moved verbatim from
 * the former monolithic server/routes/items.js.
 *
 * The drawing/throwing/use services and the chat sender are instantiated once
 * in the parent module (server/routes/items.js) and injected here so a single
 * shared instance is used process-wide (matches the prior behavior).
 *
 * @param {{
 *   logger: import('pino').Logger,
 *   drawingService: object,
 *   throwingService: object,
 *   itemUseService: object,
 *   sendSystemMessage: Function,
 * }} deps
 */
module.exports = function createInventoryRouter({ logger, drawingService, throwingService, itemUseService, sendSystemMessage }) {
    const router = express.Router();

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
                    webrtcService: req.app.get('webrtcService')
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
                    webrtcService: req.app.get('webrtcService')
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
            const ProfanityFilterService = require('../../services/ProfanityFilterService');
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

    return router;
};
