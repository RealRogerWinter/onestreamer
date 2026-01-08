const express = require('express');
const router = express.Router();
const { authenticateToken, optionalAuth } = require('../middleware/auth');

// This will be injected from the main server
let buffDebuffService = null;
let itemService = null;
let inventoryService = null;

// Middleware to inject services
router.use((req, res, next) => {
    if (req.app.locals.buffDebuffService) {
        buffDebuffService = req.app.locals.buffDebuffService;
    }
    if (req.app.locals.itemService) {
        itemService = req.app.locals.itemService;
    }
    if (req.app.locals.inventoryService) {
        inventoryService = req.app.locals.inventoryService;
    }
    next();
});

// Get all active buffs for a specific user
router.get('/user/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const requestingUserId = req.user.id;

        // Users can only view their own buffs unless they're admin
        if (requestingUserId != userId && !req.user.is_admin) {
            return res.status(403).json({ error: 'Not authorized to view these buffs' });
        }

        if (!buffDebuffService) {
            return res.status(500).json({ error: 'Buff service not available' });
        }

        const buffs = await buffDebuffService.getActiveBuffsForUser(userId);
        
        res.json({
            success: true,
            buffs: buffs,
            count: buffs.length
        });

    } catch (error) {
        console.error('Error getting user buffs:', error);
        res.status(500).json({ error: 'Failed to get user buffs' });
    }
});

// Get current streamer's buffs (public endpoint)
router.get('/streamer/current', async (req, res) => {
    try {
        if (!buffDebuffService) {
            return res.status(500).json({ error: 'Buff service not available' });
        }

        const buffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        
        res.json({
            success: true,
            buffs: buffs,
            count: buffs.length
        });

    } catch (error) {
        console.error('Error getting current streamer buffs:', error);
        res.status(500).json({ error: 'Failed to get current streamer buffs' });
    }
});

// Apply a buff/debuff using an item
router.post('/apply', authenticateToken, async (req, res) => {
    try {
        let { targetUserId, itemId } = req.body;
        const appliedByUserId = req.user.id;

        console.log(`🔍 BUFF DEBUG: HTTP /api/buffs/apply called`);
        console.log(`🔍 BUFF DEBUG: Request body: ${JSON.stringify(req.body)}`);
        console.log(`🔍 BUFF DEBUG: targetUserId type: ${typeof targetUserId}, value: "${targetUserId}"`);
        console.log(`🔍 BUFF DEBUG: appliedByUserId: ${appliedByUserId}`);

        if (!targetUserId || !itemId) {
            return res.status(400).json({ error: 'Target user ID and item ID are required' });
        }

        if (!buffDebuffService || !itemService || !inventoryService) {
            return res.status(500).json({ error: 'Required services not available' });
        }

        // Handle viewbot target - convert socket ID to synthetic user ID
        const viewbotService = req.app.locals.viewbotService;
        const sessionService = req.app.locals.sessionService;
        const streamService = req.app.locals.streamService;
        
        // Debug current streamer info
        if (streamService) {
            const currentStreamer = streamService.getCurrentStreamer();
            console.log(`🔍 BUFF DEBUG: Current streamer socket ID: "${currentStreamer}"`);
            if (currentStreamer && viewbotService) {
                const isViewbot = viewbotService.isViewbotStream(currentStreamer);
                console.log(`🔍 BUFF DEBUG: Is current streamer a viewbot? ${isViewbot}`);
            }
        }
        
        console.log(`🔍 BUFF DEBUG: Checking if targetUserId "${targetUserId}" is viewbot stream...`);
        const isTargetViewbot = viewbotService && viewbotService.isViewbotStream(targetUserId);
        console.log(`🔍 BUFF DEBUG: Is targetUserId a viewbot stream? ${isTargetViewbot}`);
        
        if (isTargetViewbot) {
            const syntheticUserId = sessionService ? sessionService.getUserIdBySocketId(targetUserId) : null;
            if (syntheticUserId) {
                console.log(`🎭 BUFF HTTP: Translating viewbot ${targetUserId} to synthetic user ${syntheticUserId}`);
                targetUserId = syntheticUserId;
            } else {
                return res.status(400).json({ error: 'Viewbot target not properly initialized for buff system' });
            }
        } else if (streamService && viewbotService && sessionService) {
            // Additional check: If client sent current streamer's user ID and current streamer is a viewbot
            const currentStreamer = streamService.getCurrentStreamer();
            console.log(`🔍 BUFF DEBUG: Checking if targetUserId matches current streamer scenario...`);
            console.log(`🔍 BUFF DEBUG: Current streamer: "${currentStreamer}"`);
            
            if (currentStreamer && viewbotService.isViewbotStream(currentStreamer)) {
                console.log(`🔍 BUFF DEBUG: Current streamer is a viewbot`);
                
                // Check if the targetUserId might be the current streamer's user ID
                const currentStreamerUserId = sessionService.getUserIdBySocketId(currentStreamer);
                console.log(`🔍 BUFF DEBUG: Current streamer user ID: ${currentStreamerUserId}`);
                console.log(`🔍 BUFF DEBUG: Target user ID: ${targetUserId} (type: ${typeof targetUserId})`);
                
                // Convert targetUserId to number for comparison if it's a string
                const targetUserIdNum = typeof targetUserId === 'string' ? parseInt(targetUserId, 10) : targetUserId;
                
                if (currentStreamerUserId && (targetUserIdNum === Math.abs(currentStreamerUserId))) {
                    console.log(`🎯 BUFF DEBUG: MATCH! Client sent current streamer user ID, translating to viewbot`);
                    console.log(`🎭 BUFF HTTP: Converting user ID ${targetUserId} to viewbot synthetic user ${currentStreamerUserId}`);
                    targetUserId = currentStreamerUserId; // This should be the negative synthetic user ID
                } else {
                    console.log(`🔍 BUFF DEBUG: No match - not a current-streamer-is-viewbot scenario`);
                }
            } else {
                console.log(`🔍 BUFF DEBUG: Current streamer is not a viewbot or doesn't exist`);
            }
        }

        console.log(`🎯 BUFF DEBUG: Final targetUserId after all processing: ${targetUserId} (type: ${typeof targetUserId})`);

        // Check if user owns the item
        const inventoryItem = await inventoryService.getInventoryItem(appliedByUserId, itemId);
        if (!inventoryItem || inventoryItem.quantity <= 0) {
            return res.status(400).json({ error: 'You do not own this item' });
        }

        // Apply the buff/debuff using ItemService
        const result = await itemService.applyBuffDebuffItem(
            targetUserId,
            itemId,
            appliedByUserId,
            buffDebuffService
        );

        // Consume the item from inventory (if not reusable)
        await inventoryService.removeItemFromInventory(appliedByUserId, itemId, 1);

        res.json({
            success: true,
            buff: result,
            message: 'Buff/debuff applied successfully'
        });

    } catch (error) {
        console.error('Error applying buff/debuff:', error);
        
        // Provide more specific error messages
        if (error.message.includes('cooldown')) {
            return res.status(429).json({ error: error.message });
        }
        if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        if (error.message.includes('not a buff or debuff')) {
            return res.status(400).json({ error: error.message });
        }
        
        res.status(500).json({ error: 'Failed to apply buff/debuff' });
    }
});

// Remove a specific buff (admin only or special items)
router.delete('/:buffId', authenticateToken, async (req, res) => {
    try {
        const { buffId } = req.params;
        const userId = req.user.id;

        if (!buffDebuffService) {
            return res.status(500).json({ error: 'Buff service not available' });
        }

        // Get buff details to check ownership
        const buff = await buffDebuffService.getBuffById(buffId);
        if (!buff) {
            return res.status(404).json({ error: 'Buff not found' });
        }

        // Only allow removal if user owns the buff or is admin
        if (buff.user_id != userId && !req.user.is_admin) {
            return res.status(403).json({ error: 'Not authorized to remove this buff' });
        }

        const success = await buffDebuffService.removeBuff(buffId, 'manual_removal');
        
        if (success) {
            res.json({
                success: true,
                message: 'Buff removed successfully'
            });
        } else {
            res.status(500).json({ error: 'Failed to remove buff' });
        }

    } catch (error) {
        console.error('Error removing buff:', error);
        res.status(500).json({ error: 'Failed to remove buff' });
    }
});

// Get available buff/debuff items
router.get('/items/available', authenticateToken, async (req, res) => {
    try {
        if (!itemService) {
            return res.status(500).json({ error: 'Item service not available' });
        }

        // Get all buff and debuff items
        const buffItems = await itemService.getItemsByType('buff');
        const debuffItems = await itemService.getItemsByType('debuff');
        
        const allBuffDebuffItems = [...buffItems, ...debuffItems].map(item => ({
            id: item.id,
            name: item.name,
            displayName: item.display_name,
            emoji: item.emoji,
            description: item.description,
            itemType: item.item_type,
            rarity: item.rarity,
            basePrice: item.base_price,
            cooldownSeconds: item.cooldown_seconds,
            maxStack: item.max_stack,
            durationSeconds: item.duration_seconds,
            effectData: item.effect_data ? JSON.parse(item.effect_data) : null,
            stackBehavior: item.stack_behavior
        }));

        res.json({
            success: true,
            items: allBuffDebuffItems,
            count: allBuffDebuffItems.length
        });

    } catch (error) {
        console.error('Error getting available buff/debuff items:', error);
        res.status(500).json({ error: 'Failed to get available items' });
    }
});

// Get buff statistics (admin only)
router.get('/stats', authenticateToken, async (req, res) => {
    try {
        if (!req.user.is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (!buffDebuffService) {
            return res.status(500).json({ error: 'Buff service not available' });
        }

        const stats = await buffDebuffService.getBuffStats();
        
        res.json({
            success: true,
            stats: stats
        });

    } catch (error) {
        console.error('Error getting buff statistics:', error);
        res.status(500).json({ error: 'Failed to get buff statistics' });
    }
});

// Apply buff to current streamer (special endpoint for viewers)
router.post('/apply-to-streamer', authenticateToken, async (req, res) => {
    try {
        const { itemId } = req.body;
        const appliedByUserId = req.user.id;

        if (!itemId) {
            return res.status(400).json({ error: 'Item ID is required' });
        }

        if (!buffDebuffService || !itemService || !inventoryService) {
            return res.status(500).json({ error: 'Required services not available' });
        }

        // Get current streamer - this would need to be implemented
        // For now, return an error indicating this feature needs streamer mapping
        return res.status(501).json({ 
            error: 'Streamer targeting not yet implemented - need socketId to userId mapping' 
        });

    } catch (error) {
        console.error('Error applying buff to current streamer:', error);
        res.status(500).json({ error: 'Failed to apply buff to current streamer' });
    }
});

// Get cooldowns for a user's buff items
router.get('/cooldowns/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const requestingUserId = req.user.id;

        // Users can only view their own cooldowns unless they're admin
        if (requestingUserId != userId && !req.user.is_admin) {
            return res.status(403).json({ error: 'Not authorized to view these cooldowns' });
        }

        if (!itemService) {
            return res.status(500).json({ error: 'Item service not available' });
        }

        const cooldowns = await itemService.getItemCooldowns(userId);
        
        // Filter to only buff/debuff items
        const buffDebuffCooldowns = cooldowns.filter(cooldown => {
            // This would require checking if the item is a buff/debuff
            // For now, return all cooldowns
            return true;
        });

        res.json({
            success: true,
            cooldowns: buffDebuffCooldowns,
            count: buffDebuffCooldowns.length
        });

    } catch (error) {
        console.error('Error getting buff cooldowns:', error);
        res.status(500).json({ error: 'Failed to get buff cooldowns' });
    }
});

module.exports = router;