const UserInventoryRepository = require('../database/repository/UserInventoryRepository');
const ItemTransactionRepository = require('../database/repository/ItemTransactionRepository');

class InventoryService {
    constructor(itemService, buffDebuffService = null, deps = {}) {
        this.itemService = itemService;
        this.buffDebuffService = buffDebuffService;
        this.streamService = null;
        this.sessionService = null;
        // Repo wiring — accepts an injected repo for unit-test mocking,
        // falls back to a default-constructed instance otherwise. Same
        // shape as BuffDebuffService / ContinuousRecordingService /
        // AccountService.
        this.userInventoryRepository = deps.userInventoryRepository || new UserInventoryRepository();
        this.itemTransactionRepository = deps.itemTransactionRepository || new ItemTransactionRepository();
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
        return await this.userInventoryRepository.findInventoryWithItemsForUser(userId);
    }

    async getInventoryItem(userId, itemId) {
        return await this.userInventoryRepository.findInventoryItem(userId, itemId);
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

            await this.userInventoryRepository.updateQuantity(userId, itemId, newQuantity);

            return {
                itemId,
                quantity: newQuantity,
                added: newQuantity - existingInventory.quantity
            };
        } else {
            const finalQuantity = item.max_stack === 0 ? quantity : Math.min(quantity, item.max_stack);

            await this.userInventoryRepository.insertItem(userId, itemId, finalQuantity);

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
            await this.userInventoryRepository.deleteItem(userId, itemId);
        } else {
            await this.userInventoryRepository.updateQuantity(userId, itemId, newQuantity);
        }

        return {
            itemId,
            quantity: newQuantity,
            removed: quantity
        };
    }

    async useItem(userId, itemId, streamId = null) {
        console.log(`📦 INVENTORY: useItem called - userId: ${userId}, itemId: ${itemId}, streamId: ${streamId}`);
        const inventoryItem = await this.getInventoryItem(userId, itemId);
        console.log(`📦 INVENTORY: inventoryItem result:`, inventoryItem);
        
        if (!inventoryItem) {
            console.error(`❌ INVENTORY: Item ${itemId} not found for user ${userId}`);
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
                        // Apply to any streamer, including anonymous/viewbot users with negative IDs
                        targetUserId = streamerSession.userId;
                        if (targetUserId < 0) {
                            console.log(`🎭 INVENTORY: Applying ${item.item_type} "${item.display_name}" to anonymous/viewbot streamer (synthetic ID ${targetUserId})`);
                        } else {
                            console.log(`🎭 INVENTORY: Applying ${item.item_type} "${item.display_name}" to current streamer (user ${targetUserId})`);
                        }
                    } else {
                        console.log(`🎭 INVENTORY: No session found for streamer, applying to self (user ${userId})`)
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

        await this.userInventoryRepository.markUsed(userId, itemId);
        
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
        const result = await this.userInventoryRepository.aggregateValueForUser(userId);

        return {
            totalValue: result?.total_value || 0,
            uniqueItems: result?.unique_items || 0,
            totalItems: result?.total_items || 0
        };
    }

    async getInventoryByRarity(userId) {
        return await this.userInventoryRepository.aggregateByRarity(userId);
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
        
        await this.itemTransactionRepository.insertAdminGrant({
            userId,
            itemId,
            quantity: result.added,
        });
        
        return {
            success: true,
            item: item.display_name,
            quantityGranted: result.added,
            totalQuantity: result.quantity
        };
    }

    async getRecentlyUsedItems(userId, limit = 5) {
        return await this.userInventoryRepository.findRecentlyUsed(userId, limit);
    }

    async clearUserInventory(userId) {
        await this.userInventoryRepository.deleteAllForUser(userId);

        return { success: true, message: 'Inventory cleared' };
    }
}

module.exports = InventoryService;