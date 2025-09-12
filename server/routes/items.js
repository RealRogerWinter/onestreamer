const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const axios = require('axios');

// Chat service URL - Updated to use HTTPS and correct port
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';

// Function to send system message to chat service
async function sendSystemMessage(message, username = '🤖 StreamBot') {
    try {
        const https = require('https');
        const agent = new https.Agent({  
            rejectUnauthorized: false // Allow self-signed certificates for local HTTPS
        });
        
        // Add timestamp and call stack to debug duplicate messages
        const timestamp = Date.now();
        const stack = new Error().stack.split('\n')[2].trim();
        console.log(`📤 CHAT: Attempting to send message at ${timestamp}: "${message}" from ${stack}`);
        
        const response = await axios.post(`${CHAT_SERVICE_URL}/api/system-message`, {
            message,
            username
        }, {
            timeout: 5000,
            httpsAgent: agent
        });
        
        console.log(`✅ CHAT: System message sent successfully at ${timestamp}: "${message}"`);
        return response.data;
    } catch (error) {
        console.error(`❌ CHAT: Failed to send system message:`, error.message);
        console.error(`❌ CHAT: URL attempted: ${CHAT_SERVICE_URL}/api/system-message`);
        return null;
    }
}

// Debug middleware for all item routes
router.use((req, res, next) => {
    if (req.path.includes('/inventory/use/')) {
        console.log(`🔴🔴🔴 FART DEBUG MIDDLEWARE: ${req.method} ${req.path}`);
        console.log(`🔴🔴🔴 FART DEBUG: Full URL: ${req.originalUrl}`);
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
        console.error('Error fetching items:', error);
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
        console.error('Error fetching categories:', error);
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
        console.error('Error fetching item:', error);
        res.status(500).json({ error: 'Failed to fetch item' });
    }
});

router.post('/items', authenticateAdmin, async (req, res) => {
    try {
        const itemService = req.app.get('itemService');
        const item = await itemService.createItem(req.body);
        res.status(201).json(item);
    } catch (error) {
        console.error('Error creating item:', error);
        res.status(500).json({ error: 'Failed to create item' });
    }
});

router.put('/items/:id', authenticateAdmin, async (req, res) => {
    try {
        const itemService = req.app.get('itemService');
        const item = await itemService.updateItem(req.params.id, req.body);
        res.json(item);
    } catch (error) {
        console.error('Error updating item:', error);
        res.status(500).json({ error: 'Failed to update item' });
    }
});

router.delete('/items/:id', authenticateAdmin, async (req, res) => {
    try {
        const itemService = req.app.get('itemService');
        await itemService.deleteItem(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting item:', error);
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
        console.error('Error fetching inventory:', error);
        res.status(500).json({ error: 'Failed to fetch inventory' });
    }
});

router.post('/inventory/use/:itemId', authenticateToken, async (req, res) => {
    console.log(`🚨🚨🚨 FART DEBUG: Request received at /inventory/use/${req.params.itemId}`);
    console.log(`🚨🚨🚨 FART DEBUG: User: ${req.user?.username || 'unknown'}, Method: ${req.method}`);
    console.log(`🚨🚨🚨 FART DEBUG: Headers:`, req.headers);
    console.log(`🚀 ITEMS: ===== ITEM USAGE REQUEST RECEIVED =====`);
    const userId = req.user.userId || req.user.id;
    console.log(`🚀 ITEMS: Starting item usage for item ID ${req.params.itemId} by user ${userId} (${req.user.username})`);
    console.log(`🚀 ITEMS: User: ${req.user.username}`);
    try {
        const inventoryService = req.app.get('inventoryService');
        const streamService = req.app.get('streamService');
        const canvasFxService = req.app.get('canvasFxService');
        const itemService = req.app.get('itemService');
        
        const streamStatus = streamService.getStreamStatus();
        const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;
        
        // Get item details first
        const item = await itemService.getItemById(req.params.itemId);
        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        console.log(`🎯 ITEMS: Item "${item.display_name}" (${item.item_type}) being used by user ${userId}`);
        console.log(`🎯 ITEMS: Item ID: ${item.id}, Name: ${item.name}`);
        console.log(`🎯 ITEMS: Effect Data: ${item.effect_data}`);
        
        // Check if this is a TTS item that needs text input
        const isTTSItem = item.name === 'megaphone' || item.name === 'tts_message';
        
        // Check if this is a soundboard item that needs URL input
        const isSoundboardItem = item.name === '101soundboards';
        
        // Check if this is a summon bot item
        const isSummonBotItem = item.name === 'summon_bot' || item.name === 'summon_lesser_bot';
        
        // Check if this is an interactive item that needs click-to-throw
        const isInteractiveItem = canvasFxService && canvasFxService.isInteractiveItem(item);
        
        // But first check if it's an auto-trigger item that should fire immediately
        // Special case for fart and thunderstorm which are auto-trigger but not interactive
        let isAutoTrigger = false;
        if (item.name === 'fart' || item.name === 'thunderstorm') {
            isAutoTrigger = true; // Fart and thunderstorm always auto-trigger
            console.log(`🌩️ ITEMS: ${item.name} detected - setting autoTrigger to true`);
        } else if (isInteractiveItem && canvasFxService) {
            const interactionConfig = canvasFxService.getInteractionConfig(item);
            isAutoTrigger = interactionConfig && interactionConfig.autoTrigger;
            console.log(`🔍 ITEMS: Item ${item.name} - autoTrigger: ${isAutoTrigger}`);
        }
        
        console.log(`🎯 ITEMS DEBUG: Item ${item.name} - isInteractiveItem: ${isInteractiveItem}, isAutoTrigger: ${isAutoTrigger}, isTTSItem: ${isTTSItem}, item_type: ${item.item_type}`);
        
        // Check if this is a buff/debuff item
        const isBuffDebuffItem = itemService.isBuffOrDebuffItem(item);
        
        // Check if this is a cooldown modifier item (guard or weapon)
        const isCooldownModifier = itemService.isCooldownModifierItem(item);
        console.log(`🔍 ITEMS DEBUG: Item "${item.display_name}" - Type: ${item.item_type}, isBuffDebuffItem: ${isBuffDebuffItem}, isCooldownModifier: ${isCooldownModifier}`);
        
        // Extra debugging for fortress_wall specifically
        if (item.name === 'fortress_wall') {
            console.log(`🏰 FORTRESS DEBUG: This is the fortress_wall item!`);
            console.log(`🏰 FORTRESS DEBUG: Should take cooldown modifier path`);
        }
        
        // IMPORTANT: Check auto-trigger FIRST, then interactive items
        // Auto-trigger items should fire immediately without user interaction
        if (isAutoTrigger) {
            console.log(`🔥 ITEMS: Auto-trigger item ${item.display_name} - consuming immediately`);
            
            // Consume the item
            const usageResult = await inventoryService.useItem(
                userId, 
                req.params.itemId,
                streamId
            );
            
            // Special handling for Fart item
            if (item.name === 'fart') {
                console.log(`💨 ITEMS: Fart item auto-triggered by ${req.user.username}`);
                
                const soundFxService = req.app.get('soundFxService');
                
                // Queue the sound effect first
                if (soundFxService) {
                    soundFxService.queue101Soundboard(
                        userId,
                        req.user.username,
                        'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                        { streamId }
                    ).then(() => {
                        console.log(`🔊 ITEMS: Fart sound effect queued`);
                    }).catch(error => {
                        console.error('❌ ITEMS: Failed to play fart sound:', error);
                    });
                }
                
                // Delay the visual effect by 1 second to sync with sound
                setTimeout(() => {
                    if (canvasFxService) {
                        canvasFxService.triggerItemEffect(
                            userId,
                            usageResult.item.id,
                            streamId,
                            {
                                position: { x: 0.5, y: 0.7 } // Center-bottom of screen
                            }
                        ).then(() => {
                            console.log(`💨 ITEMS: Fart visual effect triggered (after 1000ms delay)`);
                        }).catch(error => {
                            console.error('❌ ITEMS: Failed to trigger fart visual:', error);
                        });
                    }
                }, 2000); // 2 second delay to sync with sound
                
                // Send chat message
                await sendSystemMessage(`💨 ${req.user.username} let one rip!`, '🤖 StreamBot');
            }
            
            // Special handling for Thunderstorm item
            if (item.name === 'thunderstorm') {
                console.log(`⛈️ ITEMS: Thunderstorm item auto-triggered by ${req.user.username}`);
                
                const soundFxService = req.app.get('soundFxService');
                
                // Queue the thunderstorm sound effect
                if (soundFxService) {
                    soundFxService.queue101Soundboard(
                        userId,
                        req.user.username,
                        'https://www.101soundboards.com/sounds/74377-thunderstorm',
                        { streamId }
                    ).then(() => {
                        console.log(`🔊 ITEMS: Thunderstorm sound effect queued`);
                    }).catch(error => {
                        console.error('❌ ITEMS: Failed to play thunderstorm sound:', error);
                    });
                }
                
                // Wait 2 seconds then trigger the visual effect (covers whole screen)
                setTimeout(() => {
                    if (canvasFxService) {
                        canvasFxService.triggerItemEffect(
                            userId,
                            usageResult.item.id,
                            streamId,
                            {
                                position: { x: 0.5, y: 0.5 } // Center of screen
                            }
                        ).then(() => {
                            console.log(`⛈️ ITEMS: Thunderstorm visual effect triggered (after 2 second delay)`);
                        }).catch(error => {
                            console.error('❌ ITEMS: Failed to trigger thunderstorm visual:', error);
                        });
                    }
                }, 2000); // 2 second delay to sync with sound
                
                // Send chat message
                await sendSystemMessage(`⛈️ ${req.user.username} summoned a thunderstorm!`, '🤖 StreamBot');
            }
            
            // Get interaction config for response
            const interactionConfig = canvasFxService ? canvasFxService.getInteractionConfig(item) : null;
            
            // Return success with item consumed
            const result = {
                success: true,
                item: usageResult.item,
                remainingQuantity: usageResult.remainingQuantity,
                interactionMode: 'auto-trigger',
                interactionConfig,
                message: 'Auto-trigger item activated'
            };
            
            return res.json(result);
        } else if (isInteractiveItem) {
            console.log(`🎯 ITEMS: Taking interactive item path for ${item.display_name}`);
            
            // Check if there's an active stream for interactive items
            // Allow anonymous streamers too - check both hasActiveStream and MediaSoup
            const mediasoupService = req.app.get('mediasoupService');
            const hasMediaSoupStreamer = mediasoupService && mediasoupService.currentStreamer;
            
            if (!streamStatus.hasActiveStream && !hasMediaSoupStreamer) {
                console.log(`❌ ITEMS: No active stream for interactive item ${item.display_name}`);
                console.log(`   StreamService hasActiveStream: ${streamStatus.hasActiveStream}`);
                console.log(`   MediasoupService currentStreamer: ${hasMediaSoupStreamer}`);
                return res.status(400).json({ 
                    error: 'No active stream', 
                    message: 'Interactive items can only be used when someone is streaming. Please wait for a streamer to start.',
                    requiresStream: true 
                });
            } else if (!streamStatus.hasActiveStream && hasMediaSoupStreamer) {
                console.log(`⚠️ ITEMS: StreamService says no stream but MediaSoup has streamer - allowing for anonymous`);
            }
            
            // For interactive items, only validate but don't consume the item yet
            const inventoryItem = await inventoryService.getInventoryItem(userId, req.params.itemId);
            if (!inventoryItem || inventoryItem.quantity < 1) {
                return res.status(400).json({ error: 'Item not in inventory or insufficient quantity' });
            }
            
            // Validate item usage (cooldown check)
            const validation = await itemService.validateItemUsage(userId, req.params.itemId);
            if (!validation.valid) {
                return res.status(429).json({ 
                    error: validation.error || 'Cannot use item',
                    cooldownRemaining: validation.cooldownRemaining 
                });
            }
            
            // Get interaction config for the item
            const interactionConfig = canvasFxService.getInteractionConfig(item);
            
            // Return success with interaction mode - client should enable click-to-throw UI
            const result = {
                success: true,
                item: {
                    id: item.id,
                    name: item.name,
                    displayName: item.display_name,
                    emoji: item.emoji,
                    type: item.item_type
                },
                remainingQuantity: inventoryItem.quantity,
                interactionMode: interactionConfig?.mode || 'click-to-throw',
                interactionConfig: interactionConfig,
                message: 'Interaction mode activated'
            };
            
            // Create a unique interaction ID for tracking
            const interactionId = `interact_${userId}_${item.id}_${Date.now()}`;
            result.interactionId = interactionId;
            
            // For drawing items, the interaction mode is different
            if (interactionConfig && interactionConfig.mode === 'click-to-draw') {
                result.message = 'Drawing mode activated';
            }
            
            // Notify the specific user's socket to enable interaction mode
            const io = req.app.get('io');
            const sessionService = req.app.get('sessionService');
            if (io && sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    io.to(socketId).emit('canvas-effect-mode', {
                        mode: interactionConfig?.mode || 'click-to-throw',
                        item: result.item,
                        interactionConfig: interactionConfig,
                        userId: userId,
                        username: req.user.username,
                        streamId,
                        interactionId: interactionId
                    });
                });
            }
            
            res.json(result);
        } else if (isBuffDebuffItem && !isInteractiveItem) {
            console.log(`🎭 ITEMS: Taking buff/debuff path for ${item.display_name}`);
            // Handle buff/debuff items
            const buffDebuffService = req.app.get('buffDebuffService');
            if (!buffDebuffService) {
                return res.status(500).json({ error: 'Buff/Debuff service not available' });
            }

            // Get the current streamer to determine target
            const currentStreamerSocketId = streamService.getCurrentStreamer();
            let targetUserId = null;
            let isAnonymousStreamer = false;

            if (currentStreamerSocketId && req.app.get('sessionService')) {
                const session = req.app.get('sessionService').getSessionBySocketId(currentStreamerSocketId);
                if (session && session.userId) {
                    // Accept any user ID, including negative IDs for anonymous/viewbot users
                    targetUserId = session.userId;
                    if (targetUserId < 0) {
                        console.log(`🎭 ITEMS: Found anonymous/viewbot streamer with synthetic ID: ${targetUserId}`);
                    } else {
                        console.log(`🎭 ITEMS: Found current streamer userId: ${targetUserId}`);
                    }
                } else {
                    console.log(`🎭 ITEMS: No session found for current streamer ${currentStreamerSocketId}`);
                }
            } else {
                console.log(`🎭 ITEMS: No current streamer or session service unavailable`);
            }

            if (!targetUserId) {
                return res.status(400).json({ error: 'No active streamer found to apply buff/debuff' });
            }

            // Consume the item from inventory
            const result = await inventoryService.useItem(
                userId, 
                req.params.itemId,
                streamId
            );

            // Apply the buff/debuff
            try {
                console.log(`🎭 ITEMS: About to call applyBuffDebuffItem with params:`, {
                    targetUserId,
                    itemId: req.params.itemId,
                    appliedByUserId: userId,
                    hasBuffDebuffService: !!buffDebuffService,
                    streamId
                });
                
                const buffResult = await itemService.applyBuffDebuffItem(
                    targetUserId,
                    req.params.itemId,
                    userId,
                    buffDebuffService,
                    true, // Skip cooldown validation since we already consumed the item
                    streamId // Pass the stream ID for visual effects
                );

                console.log(`🎭 ITEMS: applyBuffDebuffItem returned:`, buffResult);

                // Add the buff result to the response
                result.buffResult = buffResult;
                result.targetUserId = targetUserId;
                result.message = `${result.item.displayName} applied to streamer successfully!`;

                console.log(`🎭 ITEMS: Applied ${result.item.displayName} buff/debuff to user ${targetUserId}`);

                // Send system message about the effect
                const effectMessage = `${req.user.username} used ${result.item.displayName} on the streamer!`;
                console.log(`📨 ITEMS: Sending buff/debuff chat message: "${effectMessage}"`);
                await sendSystemMessage(effectMessage);

            } catch (buffError) {
                console.error('Error applying buff/debuff effect:', buffError);
                result.message = `${result.item.displayName} used but buff/debuff effect failed: ${buffError.message}`;
            }

            // Emit socket events for buff/debuff items
            const io = req.app.get('io');
            const sessionService = req.app.get('sessionService');
            if (io) {
                // Global event for all users to see buff/debuff effects
                io.emit('item-used', {
                    userId: userId,
                    username: req.user.username,
                    item: result.item,
                    targetUserId: targetUserId,
                    streamId,
                    buffResult: result.buffResult
                });

                // Specific inventory update for the user
                if (sessionService) {
                    const userSocketIds = sessionService.getSocketsByUserId(userId);
                    userSocketIds.forEach(socketId => {
                        io.to(socketId).emit('inventory-updated', {
                            action: 'use',
                            itemId: req.params.itemId,
                            quantity: 1,
                            remainingQuantity: result.remainingQuantity
                        });
                    });
                }
            }
            
            return res.json(result);
        } else if (isCooldownModifier) {
            console.log(`🛡️⚔️ ITEMS: Taking cooldown modifier path for ${item.display_name}`);
            // Handle cooldown modifier items
            const takeoverService = req.app.get('takeoverService');
            if (!takeoverService) {
                return res.status(500).json({ error: 'Takeover service not available' });
            }

            // Consume the item from inventory
            const result = await inventoryService.useItem(
                userId, 
                req.params.itemId,
                streamId
            );

            // Apply the cooldown modification
            try {
                const cooldownResult = await itemService.applyCooldownModifierItem(
                    userId,
                    req.params.itemId,
                    userId,
                    takeoverService,
                    true // Skip cooldown validation since we already consumed the item
                );

                // Add the cooldown effects to the result
                result.cooldownEffects = cooldownResult.effects;
                result.message = `${result.item.displayName} used successfully! ${cooldownResult.effects.map(e => e.message).join(', ')}`;

                console.log(`🛡️⚔️ ITEMS: Applied ${result.item.displayName} cooldown effects:`, cooldownResult.effects);

                // CRITICAL DEBUG: Check cooldown immediately after modification
                const immediateCheck = await takeoverService.getGlobalCooldownRemaining();
                console.log(`🔍 CRITICAL DEBUG: Cooldown remaining immediately after modification: ${immediateCheck}s`);

                // Send system message about the effect
                const effectMessages = cooldownResult.effects.map(effect => {
                    if (effect.type === 'global_cooldown_increase') {
                        return `${req.user.username} used ${result.item.displayName} - Global cooldown extended by ${effect.amount}s!`;
                    } else if (effect.type === 'global_cooldown_decrease') {
                        return `${req.user.username} used ${result.item.displayName} - Global cooldown reduced by ${effect.amount}s!`;
                    } else if (effect.type === 'reset_individual_cooldowns') {
                        return `${req.user.username} used ${result.item.displayName} - Reset ${effect.count} individual cooldowns!`;
                    } else if (effect.type === 'freeze_individual_cooldowns') {
                        return `${req.user.username} used ${result.item.displayName} - Froze ${effect.count} individual cooldowns for ${effect.duration}s!`;
                    }
                    return effect.message;
                });

                for (const message of effectMessages) {
                    console.log(`📨 ITEMS: Sending cooldown modifier chat message: "${message}"`);
                    await sendSystemMessage(message);
                }

            } catch (cooldownError) {
                console.error('Error applying cooldown effect:', cooldownError);
                result.message = `${result.item.displayName} used but cooldown effect failed: ${cooldownError.message}`;
            }

            // Emit socket events for cooldown modifier items
            const io = req.app.get('io');
            const sessionService = req.app.get('sessionService');
            if (io) {
                // Global event for all users to see cooldown effects
                io.emit('item-used', {
                    userId: userId,
                    username: req.user.username,
                    item: result.item,
                    streamId,
                    cooldownEffects: result.cooldownEffects
                });

                // Broadcast cooldown status update to all users
                const globalCooldownInfo = await itemService.getGlobalCooldownInfo(takeoverService);
                io.emit('cooldown-status-update', {
                    globalCooldown: globalCooldownInfo,
                    timestamp: Date.now()
                });
                
                // Specific inventory update for the user
                if (sessionService) {
                    const userSocketIds = sessionService.getSocketsByUserId(userId);
                    userSocketIds.forEach(socketId => {
                        io.to(socketId).emit('inventory-updated', {
                            action: 'use',
                            itemId: req.params.itemId,
                            quantity: 1,
                            remainingQuantity: result.remainingQuantity
                        });
                    });
                }
            }
            
            res.json(result);
        } else if (isTTSItem) {
            console.log(`🎯 ITEMS: Taking TTS path for ${item.display_name}`);
            // For TTS items, validate but don't consume yet - need text input first
            const inventoryItem = await inventoryService.getInventoryItem(userId, req.params.itemId);
            if (!inventoryItem || inventoryItem.quantity < 1) {
                return res.status(400).json({ error: 'Item not in inventory or insufficient quantity' });
            }
            
            // Validate item usage (cooldown check)
            const validation = await itemService.validateItemUsage(userId, req.params.itemId);
            if (!validation.valid) {
                return res.status(429).json({ error: validation.error || 'Cannot use item' });
            }
            
            // Return success with TTS mode flag - client should show TTS input UI
            const result = {
                success: true,
                item: {
                    id: item.id,
                    name: item.name,
                    displayName: item.display_name,
                    emoji: item.emoji,
                    type: item.item_type
                    // Don't include cooldown - it should only be applied when TTS is actually sent
                },
                remainingQuantity: inventoryItem.quantity,
                ttsMode: true,
                message: 'TTS input required'
            };
            
            res.json(result);
        } else if (isSummonBotItem) {
            console.log(`🤖 ITEMS: Taking summon bot path for ${item.display_name}`);
            // For summon bot items, validate but don't consume yet - need bot details first
            const inventoryItem = await inventoryService.getInventoryItem(userId, req.params.itemId);
            if (!inventoryItem || inventoryItem.quantity < 1) {
                return res.status(400).json({ error: 'Item not in inventory or insufficient quantity' });
            }
            
            // Validate item usage (cooldown check)
            const validation = await itemService.validateItemUsage(userId, req.params.itemId);
            if (!validation.valid) {
                return res.status(429).json({ 
                    error: validation.error || 'Cannot use item',
                    cooldownRemaining: validation.cooldownRemaining 
                });
            }
            
            // Return success with summon bot mode flag - client should show input dialog
            const result = {
                success: true,
                item: {
                    id: item.id,
                    name: item.name,
                    displayName: item.display_name,
                    emoji: item.emoji,
                    type: item.item_type
                },
                remainingQuantity: inventoryItem.quantity,
                summonBotMode: true,
                message: 'Bot customization required'
            };
            
            res.json(result);
        } else if (isSoundboardItem) {
            console.log(`🎯 ITEMS: Taking soundboard path for ${item.display_name}`);
            // For soundboard items, validate but don't consume yet - need URL input first
            const inventoryItem = await inventoryService.getInventoryItem(userId, req.params.itemId);
            if (!inventoryItem || inventoryItem.quantity < 1) {
                return res.status(400).json({ error: 'Item not in inventory or insufficient quantity' });
            }
            
            // Validate item usage (cooldown check)
            const validation = await itemService.validateItemUsage(userId, req.params.itemId);
            if (!validation.valid) {
                return res.status(429).json({ error: validation.error || 'Cannot use item' });
            }
            
            // Return success with soundboard mode flag - client should show URL input UI
            const result = {
                success: true,
                item: {
                    id: item.id,
                    name: item.name,
                    displayName: item.display_name,
                    emoji: item.emoji,
                    type: item.item_type
                    // Don't include cooldown - it should only be applied when sound is actually played
                },
                remainingQuantity: inventoryItem.quantity,
                soundboardMode: true,
                message: 'Soundboard URL input required'
            };
            
            res.json(result);
        } else if (isInteractiveItem && !isAutoTrigger) {
            console.log(`🎯 ITEMS: Taking interactive item path for ${item.display_name}`);
            
            // Check if there's an active stream for interactive items
            if (!streamStatus.hasActiveStream) {
                console.log(`❌ ITEMS: No active stream for interactive item ${item.display_name}`);
                return res.status(400).json({ 
                    error: 'No active stream', 
                    message: 'Interactive items can only be used when someone is streaming. Please wait for a streamer to start.',
                    requiresStream: true 
                });
            }
            
            // For interactive items, only validate but don't consume the item yet
            const inventoryItem = await inventoryService.getInventoryItem(userId, req.params.itemId);
            if (!inventoryItem || inventoryItem.quantity < 1) {
                return res.status(400).json({ error: 'Item not in inventory or insufficient quantity' });
            }
            
            // Validate item usage (cooldown check)
            const validation = await itemService.validateItemUsage(userId, req.params.itemId);
            if (!validation.valid) {
                return res.status(429).json({ error: validation.error || 'Cannot use item' });
            }
            
            // Special handling for marker - enable drawing mode WITHOUT consuming the item yet
            console.log(`🎨 ITEMS DEBUG: Checking marker condition - item.name: "${item.name}", includes_marker: ${item.name.includes('_marker')}, equals_marker: ${item.name === 'marker'}`);
            if (item.name.includes('_marker') || item.name === 'marker') {
                console.log(`🎨 ITEMS DEBUG: MARKER DETECTED! Entering marker-specific code path`);
                // DO NOT consume the item yet - just enable drawing mode
                
                // Enable drawing mode for the user who activated it
                const io = req.app.get('io');
                const sessionService = req.app.get('sessionService');
                
                if (io && sessionService) {
                    const userSocketIds = sessionService.getSocketsByUserId(userId);
                    const interactionConfig = canvasFxService.getInteractionConfig(item);
                    
                    // Generate a unique interaction ID for this specific item use
                    const interactionId = `${userId}-${item.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    
                    userSocketIds.forEach(socketId => {
                        console.log(`🎯 SOCKET: Sending canvas-effect-mode for drawing to socket ${socketId} with interaction ID ${interactionId}`);
                        io.to(socketId).emit('canvas-effect-mode', {
                            mode: 'click-to-draw',
                            item: {
                                id: item.id,
                                name: item.name,
                                displayName: item.display_name,
                                emoji: item.emoji,
                                type: item.item_type
                            },
                            userId: userId,
                            username: req.user.username,
                            streamId,
                            interactionConfig,
                            interactionId  // Add unique ID to prevent duplicate handling
                        });
                    });
                }
                
                // Return success WITHOUT consuming the item (just like other interactive items)
                const result = {
                    success: true,
                    item: {
                        id: item.id,
                        name: item.name,
                        displayName: item.display_name,
                        emoji: item.emoji,
                        type: item.item_type
                        // Don't include cooldown - it should only be applied when item is actually used
                    },
                    remainingQuantity: inventoryItem.quantity, // No change yet
                    interactiveMode: true,
                    drawingMode: true,
                    message: 'Drawing mode activated'
                };
                
                return res.json(result);
            }
            
            
            // Set up click-to-throw mode instead of immediate consumption for other interactive items
            const io = req.app.get('io');
            const sessionService = req.app.get('sessionService');
            
            if (io && sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                const interactionConfig = canvasFxService.getInteractionConfig(item);
                
                console.log(`🎯 ITEMS: Enabling interactive mode for user ${req.user.username} with item ${item.display_name}`);
                console.log(`🎯 ITEMS: Found ${userSocketIds.length} sockets for user ${userId}`);
                
                if (userSocketIds.length === 0) {
                    console.log(`❌ ITEMS: No active sockets found for user ${userId}. Falling back to immediate usage.`);
                    // Fall back to immediate usage since we can't activate click-to-throw mode
                    const result = await inventoryService.useItem(
                        userId, 
                        req.params.itemId,
                        streamId
                    );
                    
                    // Trigger visual effect immediately
                    if (canvasFxService && result.item) {
                        const effect = await canvasFxService.triggerItemEffect(
                            userId,
                            result.item.id,
                            streamId,
                            { username: req.user.username }
                        );
                        
                        if (effect) {
                            console.log(`🎨 ITEMS: Triggered immediate visual effect for ${result.item.displayName}`);
                        }
                    }
                    
                    // Emit socket events for immediate usage - mark as interactive fallback
                    io.emit('item-used', {
                        userId: userId,
                        username: req.user.username,
                        item: result.item,
                        streamId,
                        interactiveFallback: true // Flag to indicate this was an interactive item with fallback
                    });
                    
                    // Mark response as interactive fallback so client doesn't show notifications
                    const fallbackResult = {
                        ...result,
                        interactiveFallback: true,
                        message: 'Interactive item used immediately (fallback mode)'
                    };
                    return res.json(fallbackResult);
                }
                
                // Generate a unique interaction ID for this specific item use
                const interactionId = `${userId}-${item.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                
                userSocketIds.forEach(socketId => {
                    console.log(`🎯 SOCKET: Sending canvas-effect-mode to socket ${socketId} for user ${userId} (${req.user.username}) with interaction ID ${interactionId}`);
                    io.to(socketId).emit('canvas-effect-mode', {
                        mode: interactionConfig?.mode || 'click-to-throw',
                        item: {
                            id: item.id,
                            name: item.name,
                            displayName: item.display_name,
                            emoji: item.emoji,
                            type: item.item_type
                        },
                        userId: userId,
                        username: req.user.username,
                        streamId,
                        interactionConfig,
                        interactionId  // Add unique ID to prevent duplicate handling
                    });
                });
            }
            
            
            // Return success without consuming the item (for click-to-throw items)
            const result = {
                success: true,
                item: {
                    id: item.id,
                    name: item.name,
                    displayName: item.display_name,
                    emoji: item.emoji,
                    type: item.item_type
                    // Don't include cooldown - it should only be applied when item is actually used
                },
                remainingQuantity: inventoryItem.quantity, // No change yet
                interactiveMode: true,
                message: 'Click-to-throw mode activated'
            };
            
            res.json(result);
        } else {
            console.log(`🎯 ITEMS: Taking regular item path for ${item.display_name}`);
                // For non-interactive, non-cooldown-modifier items, use the original flow
                console.log(`🔍 ITEMS DEBUG: About to call inventoryService.useItem for ${item.display_name}`);
                const result = await inventoryService.useItem(
                    userId, 
                    req.params.itemId,
                    streamId
                );
                console.log(`🔍 ITEMS DEBUG: inventoryService.useItem completed for ${item.display_name}, result:`, result);
                
                // Special handling for Fart item (automatic sound + visual)
                if (item.name === 'fart') {
                    console.log(`💨 ITEMS: Fart item activated by ${req.user.username}`);
                    
                    const soundFxService = req.app.get('soundFxService');
                    const canvasFxService = req.app.get('canvasFxService');
                    
                    // Trigger the sound effect automatically
                    if (soundFxService) {
                        try {
                            await soundFxService.queue101Soundboard(
                                userId,
                                req.user.username,
                                'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                                { streamId }
                            );
                            console.log(`🔊 ITEMS: Fart sound effect queued`);
                        } catch (error) {
                            console.error('❌ ITEMS: Failed to play fart sound:', error);
                        }
                    }
                    
                    // Wait 2 seconds then trigger the visual effect
                    setTimeout(() => {
                        if (canvasFxService) {
                            canvasFxService.triggerItemEffect(
                                userId,
                                result.item.id,
                                streamId,
                                {
                                    position: { x: 0.5, y: 0.7 } // Center-bottom of screen
                                }
                            ).then(() => {
                                console.log(`💨 ITEMS: Fart visual effect triggered (after 2 second delay)`);
                            }).catch(error => {
                                console.error('❌ ITEMS: Failed to trigger fart visual:', error);
                            });
                        }
                    }, 2000); // 2 second delay to sync with sound
                    
                    // Send chat message
                    await sendSystemMessage(`💨 ${req.user.username} let one rip!`, '🤖 StreamBot');
                }
                
                // Special handling for Kill Switch after item consumption
                if (item.name === 'kill_switch') {
                    console.log(`💥 ITEMS: Kill Switch activated by ${req.user.username} (user ${userId}) in regular path`);
                    
                    const streamService = req.app.get('streamService');
                    const sessionService = req.app.get('sessionService');
                    const io = req.app.get('io');
                    
                    if (!streamService || !sessionService || !io) {
                        console.error('❌ KILL SWITCH: Required services not available');
                        return res.status(500).json({ error: 'Kill Switch unavailable - required services not found' });
                    }
                    
                    // Get current streamer
                    const currentStreamerSocketId = streamService.getCurrentStreamer();
                    if (!currentStreamerSocketId) {
                        console.log('❌ KILL SWITCH: No active streamer to disconnect');
                        return res.status(400).json({ error: 'No active streamer to disconnect' });
                    }
                    
                    console.log(`💥 KILL SWITCH: Current streamer socket: ${currentStreamerSocketId}`);
                    
                    // Get streamer's session info for logging
                    const streamerSession = sessionService.getSessionBySocketId(currentStreamerSocketId);
                    const streamerUsername = streamerSession?.username || 'Unknown';
                    console.log(`💥 KILL SWITCH: Disconnecting streamer "${streamerUsername}" (socket: ${currentStreamerSocketId})`);
                    
                    // Force disconnect the current streamer
                    try {
                        // Send disconnect message to the streamer
                        io.to(currentStreamerSocketId).emit('force-disconnect', {
                            reason: 'Kill Switch activated',
                            activatedBy: req.user.username,
                            message: '💥 Kill Switch has been activated! You have been disconnected.'
                        });
                        
                        // Broadcast to all viewers that Kill Switch was used
                        io.emit('kill-switch-activated', {
                            activatedBy: req.user.username,
                            targetStreamer: streamerUsername,
                            message: `💥 ${req.user.username} activated the Kill Switch! Stream disconnected.`
                        });
                        
                        // Actually disconnect the socket after a brief delay
                        setTimeout(() => {
                            const socket = io.sockets.sockets.get(currentStreamerSocketId);
                            if (socket) {
                                console.log(`💥 KILL SWITCH: Force disconnecting socket ${currentStreamerSocketId}`);
                                socket.disconnect(true);
                            }
                        }, 1000); // 1 second delay to allow messages to be sent
                        
                        console.log(`✅ KILL SWITCH: Successfully activated by ${req.user.username}, disconnecting ${streamerUsername}`);
                        
                    } catch (error) {
                        console.error('❌ KILL SWITCH: Error during force disconnect:', error);
                        return res.status(500).json({ error: 'Kill Switch activation failed' });
                    }
                    
                    // Update inventory for the user (item already consumed)
                    const userSocketIds = sessionService.getSocketsByUserId(userId);
                    userSocketIds.forEach(socketId => {
                        io.to(socketId).emit('inventory-updated', {
                            action: 'use',
                            itemId: req.params.itemId,
                            quantity: 1,
                            remainingQuantity: result.remainingQuantity
                        });
                    });
                    
                    return res.json({
                        ...result,
                        killSwitchActivated: true,
                        targetStreamer: streamerUsername,
                        message: `💥 Kill Switch activated! ${streamerUsername} has been disconnected.`
                    });
                }
                
                // Trigger visual effect immediately for non-interactive items
                if (canvasFxService && result.item) {
                    const effect = await canvasFxService.triggerItemEffect(
                        userId,
                        result.item.id,
                        streamId,
                        { username: req.user.username }
                    );
                    
                    if (effect) {
                        console.log(`🎨 ITEMS: Triggered visual effect for ${result.item.displayName}`);
                    }
                }
                
                // Emit socket events for non-interactive items only
                const io = req.app.get('io');
                const sessionService = req.app.get('sessionService');
                if (io) {
                    // Global event for all users to see item effects
                    io.emit('item-used', {
                        userId: userId,
                        username: req.user.username,
                        item: result.item,
                        streamId
                    });
                    
                    // Specific inventory update for the user
                    if (sessionService) {
                        const userSocketIds = sessionService.getSocketsByUserId(userId);
                        userSocketIds.forEach(socketId => {
                            io.to(socketId).emit('inventory-updated', {
                                action: 'use',
                                itemId: req.params.itemId,
                                quantity: 1,
                                remainingQuantity: result.remainingQuantity
                            });
                        });
                    }
                }
                
                res.json(result);
            }
    } catch (error) {
        console.error('Error using item:', error);
        
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
        const userId = req.user.userId || req.user.id;
        console.log(`✏️ DRAWING START: User ${req.user.username} starting drawing`, req.body);
        const { item } = req.body;
        
        if (!item) {
            return res.status(400).json({ error: 'Missing required parameter: item' });
        }
        
        const inventoryService = req.app.get('inventoryService');
        const canvasFxService = req.app.get('canvasFxService');
        const itemService = req.app.get('itemService');
        const streamService = req.app.get('streamService');
        
        const streamStatus = streamService.getStreamStatus();
        const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;
        
        // Check if there's an active stream (required for drawing)
        if (!streamStatus.hasActiveStream) {
            console.log(`❌ DRAWING START: No active stream to draw on`);
            return res.status(400).json({ 
                error: 'No active stream', 
                message: 'You can only draw when someone is streaming. Please wait for a streamer to start.',
                requiresStream: true 
            });
        }
        
        console.log(`✏️ DRAWING START: Consuming marker item ${item.name} for user ${req.user.username}`);
        
        // Now consume the item from inventory
        const result = await inventoryService.useItem(
            userId, 
            item.id,
            streamId
        );
        
        // Trigger the multi-phase visual effect for all clients
        if (canvasFxService && result.item) {
            try {
                const effect = await canvasFxService.triggerItemEffect(
                    userId,
                    result.item.id,
                    streamId,
                    { username: req.user.username }
                );
                
                console.log(`✏️ DRAWING START: triggerItemEffect returned:`, effect);
                
                if (effect) {
                    console.log(`✏️ DRAWING START: Triggered multi-phase drawing effect for ${result.item.displayName}`);
                } else {
                    console.log(`❌ DRAWING START: Failed to trigger effect for ${result.item.displayName} - null effect returned`);
                }
            } catch (error) {
                console.error(`❌ DRAWING START: Error triggering effect for ${result.item.displayName}:`, error);
            }
        }
        
        // Send system message about drawing starting
        await sendSystemMessage(`${req.user.username} started drawing with ${item.displayName || item.display_name}!`);
        
        // Emit socket events for inventory update and item usage
        const io = req.app.get('io');
        const sessionService = req.app.get('sessionService');
        if (io) {
            // Global event for all users to see item usage
            io.emit('item-used', {
                userId: userId,
                username: req.user.username,
                item: result.item,
                streamId,
                drawingStarted: true
            });
            
            // Specific inventory update for the user
            if (sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    io.to(socketId).emit('inventory-updated', {
                        action: 'draw',
                        itemId: item.id,
                        quantity: 1,
                        remainingQuantity: result.remainingQuantity
                    });
                });
            }
        }
        
        res.json({ 
            success: true, 
            item: result.item, // Include the full item with cooldown
            message: `Drawing started with ${item.displayName || item.display_name}!`,
            remainingQuantity: result.remainingQuantity
        });
    } catch (error) {
        console.error('Error starting drawing:', error);
        
        if (error.message.includes('cooldown')) {
            return res.status(429).json({ error: error.message });
        }
        
        res.status(500).json({ error: error.message || 'Failed to start drawing' });
    }
});

router.post('/inventory/throw', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        console.log(`🎯 THROW ENDPOINT HIT: User ${req.user.username} throwing item`, req.body);
        const { x, y, item, username } = req.body;
        
        if (x === undefined || x === null || y === undefined || y === null || !item || !username) {
            return res.status(400).json({ error: 'Missing required parameters: x, y, item, username' });
        }
        
        const inventoryService = req.app.get('inventoryService');
        const canvasFxService = req.app.get('canvasFxService');
        const itemService = req.app.get('itemService');
        const streamService = req.app.get('streamService');
        
        const streamStatus = streamService.getStreamStatus();
        const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;
        
        // Check if there's an active stream (required for throwing items)
        if (!streamStatus.hasActiveStream) {
            console.log(`❌ THROW: No active stream to throw item at`);
            return res.status(400).json({ 
                error: 'No active stream', 
                message: 'You can only throw items when someone is streaming. Please wait for a streamer to start.',
                requiresStream: true 
            });
        }
        
        console.log(`🎯 THROW DEBUG: Throwing item ${item.name} for user ${req.user.username}`);
        
        // First, consume the item from inventory
        const result = await inventoryService.useItem(
            userId, 
            item.id,
            streamId
        );
        
        // Check if this is a buff/debuff item that needs special handling after throwing
        const fullItem = await itemService.getItemById(item.id);
        const isBuffDebuffItem = itemService.isBuffOrDebuffItem(fullItem);
        
        // For buff/debuff items like smoke_bomb, apply the buff first to get duration
        let buffDuration = null;
        if (isBuffDebuffItem) {
            console.log(`🎯 THROW: Item ${fullItem.name} is a buff/debuff, applying after throw`);
            
            const buffDebuffService = req.app.get('buffDebuffService');
            if (buffDebuffService) {
                // Get the current streamer to determine target
                const currentStreamerSocketId = streamService.getCurrentStreamer();
                let targetUserId = null;

                if (currentStreamerSocketId && req.app.get('sessionService')) {
                    const session = req.app.get('sessionService').getSessionBySocketId(currentStreamerSocketId);
                    if (session && session.userId) {
                        targetUserId = session.userId;
                        console.log(`🎯 THROW: Found current streamer userId: ${targetUserId}`);
                    }
                }

                if (targetUserId) {
                    try {
                        const buffResult = await itemService.applyBuffDebuffItem(
                            targetUserId,
                            item.id,
                            userId,
                            buffDebuffService,
                            true, // Skip cooldown validation since we already consumed the item
                            streamId
                        );
                        console.log(`🎯 THROW: Applied ${fullItem.display_name} buff/debuff to streamer after throw`);
                        result.buffResult = buffResult;
                        
                        // Get the buff duration for the effect
                        if (fullItem.duration_seconds) {
                            buffDuration = fullItem.duration_seconds;
                            console.log(`🎯 THROW: Buff duration is ${buffDuration} seconds`);
                        }
                    } catch (buffError) {
                        console.error('Error applying buff/debuff after throw:', buffError);
                    }
                }
            }
        }
        
        // Trigger the visual effect at specific coordinates for ALL viewers
        // For buff items, pass the buff duration to ensure proper effect duration
        if (canvasFxService) {
            const effectParams = { username: req.user.username };
            if (buffDuration) {
                effectParams.buffDuration = buffDuration;
                effectParams.triggeredByThrow = true;
                console.log(`🎯 THROW: Passing buff duration ${buffDuration}s to effect`);
            }
            
            const effect = await canvasFxService.triggerItemEffectAtPosition(
                userId,
                item.id,
                streamId,
                { x: parseFloat(x), y: parseFloat(y) },
                effectParams
            );
            
            if (effect) {
                console.log(`🎯 ITEMS: ${req.user.username} threw ${item.displayName} at (${x}, ${y})`);
                
                // Send configurable StreamBot chat message
                const interactionConfig = canvasFxService.getInteractionConfig({ name: item.name });
                const chatMessage = interactionConfig?.chatMessage?.replace('{username}', req.user.username) 
                    || `${req.user.username} threw ${item.displayName}!`;
                
                await sendSystemMessage(chatMessage);
                
                // Check if this is an interactive item to suppress UI notifications
                const isInteractiveItem = canvasFxService && canvasFxService.isInteractiveItem(item);
                
                // Emit socket events for inventory update and item usage
                const io = req.app.get('io');
                const sessionService = req.app.get('sessionService');
                if (io) {
                    // Always emit item-used for cooldown tracking, but flag interactive items
                    io.emit('item-used', {
                        userId: userId,
                        username: req.user.username,
                        item: result.item,
                        streamId,
                        thrown: true, // Flag to indicate this was thrown
                        suppressNotification: isInteractiveItem // Flag to suppress notifications for interactive items
                    });
                    
                    if (isInteractiveItem) {
                        console.log(`🔇 THROW: Flagged interactive item for notification suppression: ${item.display_name}`);
                    }
                    
                    // Specific inventory update for the user
                    if (sessionService) {
                        const userSocketIds = sessionService.getSocketsByUserId(userId);
                        userSocketIds.forEach(socketId => {
                            io.to(socketId).emit('inventory-updated', {
                                action: 'throw',
                                itemId: item.id,
                                quantity: 1,
                                remainingQuantity: result.remainingQuantity
                            });
                        });
                    }
                }
                
                res.json({ 
                    success: true, 
                    item: result.item, // Include the full item with cooldown
                    effect: effect,
                    message: `${item.displayName} thrown successfully!`,
                    remainingQuantity: result.remainingQuantity
                });
            } else {
                throw new Error('Failed to trigger effect');
            }
        } else {
            throw new Error('Canvas FX service not available');
        }
    } catch (error) {
        console.error('Error throwing item:', error);
        
        // If the error occurred after consuming the item, we might need to refund it
        // For now, we'll just return the error - this should be rare
        
        if (error.message.includes('cooldown')) {
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
        console.error('Error fetching cooldowns:', error);
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
        
        console.log('🔍 COOLDOWN STATUS DEBUG:', debugInfo);
        
        res.json({
            globalCooldown: globalCooldownInfo,
            individualCooldowns: allCooldowns.length,
            debug: debugInfo,
            timestamp: Date.now(),
            version: "debug-enhanced"
        });
    } catch (error) {
        console.error('Error fetching cooldown status:', error);
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
        console.error('Error fetching inventory value:', error);
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
        console.error('Error fetching shop items:', error);
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
        if (io && sessionService) {
            const userSocketIds = sessionService.getSocketsByUserId(userId);
            // console.log(`📦 INVENTORY: Emitting inventory-updated to user ${userId}, found ${userSocketIds.length} sockets: [${userSocketIds.join(', ')}]`);
            userSocketIds.forEach(socketId => {
                // console.log(`📦 INVENTORY: Emitting to socket ${socketId}`);
                io.to(socketId).emit('inventory-updated', {
                    action: 'purchase',
                    itemId,
                    quantity
                });
            });
        }
        
        res.json(result);
    } catch (error) {
        console.error('Error purchasing item:', error);
        
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
        if (io && sessionService) {
            const userSocketIds = sessionService.getSocketsByUserId(userId);
            userSocketIds.forEach(socketId => {
                io.to(socketId).emit('inventory-updated', {
                    action: 'sell',
                    itemId,
                    quantity
                });
            });
        }
        
        res.json(result);
    } catch (error) {
        console.error('Error selling item:', error);
        res.status(500).json({ error: error.message || 'Failed to sell item' });
    }
});

router.get('/shop/featured', async (req, res) => {
    try {
        const shopService = req.app.get('shopService');
        const items = await shopService.getFeaturedItems();
        res.json(items);
    } catch (error) {
        console.error('Error fetching featured items:', error);
        res.status(500).json({ error: 'Failed to fetch featured items' });
    }
});

router.get('/shop/discounted', async (req, res) => {
    try {
        const shopService = req.app.get('shopService');
        const items = await shopService.getDiscountedItems();
        res.json(items);
    } catch (error) {
        console.error('Error fetching discounted items:', error);
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
        if (io && sessionService) {
            const userSocketIds = sessionService.getSocketsByUserId(userId);
            userSocketIds.forEach(socketId => {
                io.to(socketId).emit('inventory-updated', {
                    action: 'grant',
                    itemId,
                    quantity
                });
            });
        }
        
        res.json(result);
    } catch (error) {
        console.error('Error granting items:', error);
        res.status(500).json({ error: 'Failed to grant items' });
    }
});

router.get('/admin/items/stats', authenticateAdmin, async (req, res) => {
    try {
        const itemService = req.app.get('itemService');
        const stats = await itemService.getItemStats();
        res.json(stats);
    } catch (error) {
        console.error('Error fetching item stats:', error);
        res.status(500).json({ error: 'Failed to fetch item stats' });
    }
});

router.get('/admin/shop/stats', authenticateAdmin, async (req, res) => {
    try {
        const shopService = req.app.get('shopService');
        const stats = await shopService.getShopStatistics();
        res.json(stats);
    } catch (error) {
        console.error('Error fetching shop stats:', error);
        res.status(500).json({ error: 'Failed to fetch shop stats' });
    }
});

router.get('/admin/user/:userId/inventory', authenticateAdmin, async (req, res) => {
    try {
        const inventoryService = req.app.get('inventoryService');
        const inventory = await inventoryService.getUserInventory(req.params.userId);
        res.json(inventory);
    } catch (error) {
        console.error('Error fetching user inventory:', error);
        res.status(500).json({ error: 'Failed to fetch user inventory' });
    }
});

router.delete('/admin/user/:userId/inventory', authenticateAdmin, async (req, res) => {
    try {
        const inventoryService = req.app.get('inventoryService');
        const result = await inventoryService.clearUserInventory(req.params.userId);
        res.json(result);
    } catch (error) {
        console.error('Error clearing user inventory:', error);
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
        console.error('Error fetching admin shop items:', error);
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
        console.error('Error adding item to shop:', error);
        res.status(500).json({ error: 'Failed to add item to shop' });
    }
});

router.put('/admin/shop/:shopItemId', authenticateAdmin, async (req, res) => {
    try {
        const shopService = req.app.get('shopService');
        const shopItem = await shopService.updateShopItem(req.params.shopItemId, req.body);
        res.json(shopItem);
    } catch (error) {
        console.error('Error updating shop item:', error);
        res.status(500).json({ error: 'Failed to update shop item' });
    }
});

router.delete('/admin/shop/:shopItemId', authenticateAdmin, async (req, res) => {
    try {
        const shopService = req.app.get('shopService');
        await shopService.removeItemFromShop(req.params.shopItemId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error removing item from shop:', error);
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
        console.error('Error fetching admin items:', error);
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});

router.post('/admin/items', authenticateAdmin, async (req, res) => {
    try {
        const itemService = req.app.get('itemService');
        const item = await itemService.createItem(req.body);
        res.status(201).json(item);
    } catch (error) {
        console.error('Error creating admin item:', error);
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
        console.error('Error fetching admin item:', error);
        res.status(500).json({ error: 'Failed to fetch item' });
    }
});

router.put('/admin/items/:id', authenticateAdmin, async (req, res) => {
    try {
        const itemService = req.app.get('itemService');
        const item = await itemService.updateItem(req.params.id, req.body);
        res.json(item);
    } catch (error) {
        console.error('Error updating admin item:', error);
        res.status(500).json({ error: 'Failed to update item' });
    }
});

router.delete('/admin/items/:id', authenticateAdmin, async (req, res) => {
    try {
        const itemService = req.app.get('itemService');
        await itemService.deleteItem(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting admin item:', error);
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
        
        console.log(`🔄 ADMIN: User ${userId} reset ${count} item cooldowns`);
        
        res.json({ 
            success: true, 
            message: `Reset cooldowns for ${count} item usages`,
            itemsAffected: count
        });
    } catch (error) {
        console.error('Error resetting user item cooldowns:', error);
        res.status(500).json({ error: 'Failed to reset cooldowns' });
    }
});

// Summon Bot endpoint - handles the actual bot creation after user provides details
router.post('/inventory/summon-bot/:itemId', authenticateToken, async (req, res) => {
    console.log(`🤖 SUMMON BOT: Request received for item ${req.params.itemId} by user ${req.user.username}`);
    
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
            console.log(`🚫 SUMMON BOT: Name validation failed: ${nameValidation.error}`);
            return res.status(400).json({ error: nameValidation.error });
        }
        
        // Validate personality prompt
        const promptValidation = profanityFilter.validatePersonalityPrompt(personalityPrompt);
        if (!promptValidation.isValid) {
            console.log(`🚫 SUMMON BOT: Prompt validation failed: ${promptValidation.error}`);
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
        
        console.log(`✅ SUMMON BOT: Bot "${botName}" created successfully by ${req.user.username}`);
        
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
        
        console.log(`📤 SUMMON BOT: Attempting to send chat message: "${chatMessage}"`);
        
        try {
            const messageResult = await sendSystemMessage(chatMessage, '🤖 StreamBot');
            console.log(`✅ SUMMON BOT: Chat message sent successfully:`, messageResult);
        } catch (msgError) {
            console.error(`❌ SUMMON BOT: Failed to send chat message:`, msgError);
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
        console.error('❌ SUMMON BOT: Error creating bot:', error);
        res.status(500).json({ error: 'Failed to summon bot' });
    }
});

module.exports = router;