const { runAsync, getAsync, allAsync } = require('../database/database');

class InventoryService {
    constructor(itemService, buffDebuffService = null) {
        this.itemService = itemService;
        this.buffDebuffService = buffDebuffService;
        this.streamService = null;
        this.sessionService = null;
    }

    // Set buff-debuff service dependency after initialization if needed
    setBuffDebuffService(buffDebuffService) {
        this.buffDebuffService = buffDebuffService;
    }

    setStreamAndSessionServices(streamService, sessionService) {
        this.streamService = streamService;
        this.sessionService = sessionService;
    }

    setViewbotService(viewbotService) {
        this.viewbotService = viewbotService;
    }
    
    setViewbotSocketChecker(viewbotSocketChecker) {
        this.viewbotSocketChecker = viewbotSocketChecker;
    }

    async getUserInventory(userId) {
        const inventory = await allAsync(
            `SELECT 
                ui.id as inventory_id,
                ui.item_id,
                ui.quantity,
                ui.acquired_at,
                ui.last_used_at,
                i.name,
                i.display_name,
                i.emoji,
                i.description,
                i.item_type,
                i.rarity,
                i.cooldown_seconds,
                i.max_stack
             FROM user_inventory ui
             JOIN items i ON ui.item_id = i.id
             WHERE ui.user_id = ? AND ui.quantity > 0 AND i.is_active = 1
             ORDER BY i.rarity DESC, i.name`,
            [userId]
        );

        return inventory;
    }

    async getInventoryItem(userId, itemId) {
        return await getAsync(
            `SELECT 
                ui.*,
                i.name,
                i.display_name,
                i.emoji,
                i.cooldown_seconds,
                i.max_stack
             FROM user_inventory ui
             JOIN items i ON ui.item_id = i.id
             WHERE ui.user_id = ? AND ui.item_id = ?`,
            [userId, itemId]
        );
    }

    async addItemToInventory(userId, itemId, quantity = 1) {
        const item = await this.itemService.getItemById(itemId);
        if (!item) {
            throw new Error('Item not found');
        }

        const existingInventory = await this.getInventoryItem(userId, itemId);
        
        if (existingInventory) {
            const newQuantity = item.max_stack === 0 ? existingInventory.quantity + quantity : Math.min(
                existingInventory.quantity + quantity,
                item.max_stack
            );
            
            await runAsync(
                'UPDATE user_inventory SET quantity = ? WHERE user_id = ? AND item_id = ?',
                [newQuantity, userId, itemId]
            );
            
            return {
                itemId,
                quantity: newQuantity,
                added: newQuantity - existingInventory.quantity
            };
        } else {
            const finalQuantity = item.max_stack === 0 ? quantity : Math.min(quantity, item.max_stack);
            
            await runAsync(
                'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)',
                [userId, itemId, finalQuantity]
            );
            
            return {
                itemId,
                quantity: finalQuantity,
                added: finalQuantity
            };
        }
    }

    async removeItemFromInventory(userId, itemId, quantity = 1) {
        const inventoryItem = await this.getInventoryItem(userId, itemId);
        
        if (!inventoryItem) {
            throw new Error('Item not in inventory');
        }
        
        if (inventoryItem.quantity < quantity) {
            throw new Error('Insufficient quantity');
        }
        
        const newQuantity = inventoryItem.quantity - quantity;
        
        if (newQuantity === 0) {
            await runAsync(
                'DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?',
                [userId, itemId]
            );
        } else {
            await runAsync(
                'UPDATE user_inventory SET quantity = ? WHERE user_id = ? AND item_id = ?',
                [newQuantity, userId, itemId]
            );
        }
        
        return {
            itemId,
            quantity: newQuantity,
            removed: quantity
        };
    }

    async useItem(userId, itemId, streamId = null) {
        const inventoryItem = await this.getInventoryItem(userId, itemId);
        
        if (!inventoryItem) {
            throw new Error('Item not in inventory');
        }
        
        if (inventoryItem.quantity < 1) {
            throw new Error('No items available to use');
        }

        const validation = await this.itemService.validateItemUsage(userId, itemId);
        if (!validation.valid) {
            throw new Error(validation.error || 'Cannot use item');
        }

        const item = await this.itemService.getItemById(itemId);
        
        // Apply buff/debuff FIRST if the item is a buff or debuff type and we have the buff service
        let buffResult = null;
        if (this.buffDebuffService && this.itemService.isBuffOrDebuffItem(item)) {
            // Determine target user - should be the current streamer
            let targetUserId = userId; // Default to self if no streamer
            
            if (this.streamService && this.sessionService) {
                const currentStreamerSocketId = this.streamService.getCurrentStreamer();
                console.log(`🔍 INVENTORY DEBUG: Current streamer socket ID: "${currentStreamerSocketId}"`);
                console.log(`🔍 INVENTORY DEBUG: ViewbotService available: ${!!this.viewbotService}`);
                console.log(`🔍 INVENTORY DEBUG: Starting viewbot targeting logic...`);
                
                if (currentStreamerSocketId) {
                    const streamerSession = this.sessionService.getSessionBySocketId(currentStreamerSocketId);
                    console.log(`🔍 INVENTORY DEBUG: Streamer session found: ${!!streamerSession}`);
                    
                    if (streamerSession && streamerSession.userId) {
                        targetUserId = streamerSession.userId;
                        console.log(`🎭 INVENTORY: Applying ${item.item_type} "${item.display_name}" to current streamer (user ${targetUserId})`);
                    } else {
                        // Check if current streamer is a viewbot (check both methods)
                        console.log(`🔍 INVENTORY DEBUG: Checking if "${currentStreamerSocketId}" is viewbot...`);
                        const isViewbotByService = this.viewbotService && this.viewbotService.isViewbotStream(currentStreamerSocketId);
                        const isViewbotBySocket = this.viewbotSocketChecker && this.viewbotSocketChecker(currentStreamerSocketId);
                        const isViewbot = isViewbotByService || isViewbotBySocket;
                        console.log(`🔍 INVENTORY DEBUG: Is viewbot by service: ${isViewbotByService}, by socket tracker: ${isViewbotBySocket}, final: ${isViewbot}`);
                        
                        if (isViewbot) {
                            const syntheticUserId = this.sessionService.getUserIdBySocketId(currentStreamerSocketId);
                            console.log(`🔍 INVENTORY DEBUG: Synthetic user ID: ${syntheticUserId}`);
                            
                            if (syntheticUserId) {
                                targetUserId = syntheticUserId;
                                console.log(`🎭 INVENTORY: Applying ${item.item_type} "${item.display_name}" to viewbot streamer (synthetic user ${targetUserId})`);
                            } else {
                                console.log(`🎭 INVENTORY: Viewbot streamer found but no synthetic user ID, applying to self (user ${userId})`);
                            }
                        } else {
                            console.log(`🎭 INVENTORY: No session found for streamer, applying to self (user ${userId})`);
                        }
                    }
                } else {
                    console.log(`🎭 INVENTORY: No active streamer, applying to self (user ${userId})`);
                }
            } else {
                console.log(`🎭 INVENTORY: Stream/Session services not available, applying to self (user ${userId})`);
            }
            
            try {
                buffResult = await this.itemService.applyBuffDebuffItem(
                    targetUserId, // Apply to current streamer or self
                    itemId, 
                    userId, // appliedByUserId is the user who used the item
                    this.buffDebuffService,
                    true // skipCooldownValidation - we handle cooldown ourselves
                );
            } catch (buffError) {
                console.error(`❌ INVENTORY: Error applying ${item.item_type}:`, buffError);
                // Don't fail the entire operation if buff application fails
                throw buffError; // Re-throw so the user knows the buff failed
            }
        }

        await this.removeItemFromInventory(userId, itemId, 1);
        
        await this.itemService.applyItemCooldown(userId, itemId, streamId);
        
        await runAsync(
            'UPDATE user_inventory SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND item_id = ?',
            [userId, itemId]
        );
        
        const result = {
            success: true,
            item: {
                id: item.id,
                name: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: item.item_type,
                cooldown: item.cooldown_seconds
            },
            remainingQuantity: inventoryItem.quantity - 1
        };

        // Add buff information to the result if a buff was applied
        if (buffResult) {
            result.buffApplied = {
                id: buffResult.id,
                duration: buffResult.duration_seconds,
                remainingSeconds: buffResult.remaining_seconds,
                buffType: buffResult.buff_type
            };
        }

        return result;
    }

    async getUserInventoryValue(userId) {
        const result = await getAsync(
            `SELECT 
                SUM(ui.quantity * i.base_price) as total_value,
                COUNT(DISTINCT ui.item_id) as unique_items,
                SUM(ui.quantity) as total_items
             FROM user_inventory ui
             JOIN items i ON ui.item_id = i.id
             WHERE ui.user_id = ? AND ui.quantity > 0`,
            [userId]
        );
        
        return {
            totalValue: result?.total_value || 0,
            uniqueItems: result?.unique_items || 0,
            totalItems: result?.total_items || 0
        };
    }

    async getInventoryByRarity(userId) {
        const inventory = await allAsync(
            `SELECT 
                i.rarity,
                COUNT(DISTINCT ui.item_id) as item_count,
                SUM(ui.quantity) as total_quantity
             FROM user_inventory ui
             JOIN items i ON ui.item_id = i.id
             WHERE ui.user_id = ? AND ui.quantity > 0
             GROUP BY i.rarity
             ORDER BY 
                CASE i.rarity
                    WHEN 'legendary' THEN 1
                    WHEN 'epic' THEN 2
                    WHEN 'rare' THEN 3
                    WHEN 'uncommon' THEN 4
                    WHEN 'common' THEN 5
                END`,
            [userId]
        );
        
        return inventory;
    }

    async transferItem(fromUserId, toUserId, itemId, quantity = 1) {
        const fromInventory = await this.getInventoryItem(fromUserId, itemId);
        
        if (!fromInventory || fromInventory.quantity < quantity) {
            throw new Error('Insufficient items to transfer');
        }
        
        await this.removeItemFromInventory(fromUserId, itemId, quantity);
        
        await this.addItemToInventory(toUserId, itemId, quantity);
        
        return {
            success: true,
            itemId,
            quantity,
            fromUserId,
            toUserId
        };
    }

    async grantItemsToUser(userId, itemId, quantity, grantedBy = 'admin') {
        const result = await this.addItemToInventory(userId, itemId, quantity);
        
        const item = await this.itemService.getItemById(itemId);
        
        await runAsync(
            `INSERT INTO item_transactions 
             (user_id, item_id, transaction_type, quantity, price_per_item, total_cost)
             VALUES (?, ?, 'admin_grant', ?, 0, 0)`,
            [userId, itemId, result.added]
        );
        
        return {
            success: true,
            item: item.display_name,
            quantityGranted: result.added,
            totalQuantity: result.quantity
        };
    }

    async getRecentlyUsedItems(userId, limit = 5) {
        const items = await allAsync(
            `SELECT 
                ui.item_id,
                ui.last_used_at,
                i.name,
                i.display_name,
                i.emoji,
                i.item_type
             FROM user_inventory ui
             JOIN items i ON ui.item_id = i.id
             WHERE ui.user_id = ? AND ui.last_used_at IS NOT NULL
             ORDER BY ui.last_used_at DESC
             LIMIT ?`,
            [userId, limit]
        );
        
        return items;
    }

    async clearUserInventory(userId) {
        await runAsync(
            'DELETE FROM user_inventory WHERE user_id = ?',
            [userId]
        );
        
        return { success: true, message: 'Inventory cleared' };
    }
}

module.exports = InventoryService;