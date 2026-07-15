const UserInventoryRepository = require('../database/repository/UserInventoryRepository');
const ItemTransactionRepository = require('../database/repository/ItemTransactionRepository');

const logger = require('../bootstrap/logger').child({ svc: 'InventoryService' });

// PR 16.3: typed error used by giftItem to signal client-facing validation
// failures (self-gift, item not giftable, insufficient inventory). The
// HTTP handler in server/routes/internal.js catches this and maps
// { statusCode, clientMessage } to the JSON body shape that pre-PR routes
// built inline. Anything else propagates as a 500.
class InventoryError extends Error {
  constructor(statusCode, clientMessage) {
    super(clientMessage);
    this.name = 'InventoryError';
    this.statusCode = statusCode;
    this.clientMessage = clientMessage;
  }
}

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
        // Injected for testability (matches ShopService); resolved lazily from
        // the database module otherwise, so unit tests can jest.mock it
        // without dragging the DB into the require graph at module load.
        this.withTransaction = deps.withTransaction || null;
    }

    _getWithTransaction() {
        if (!this.withTransaction) {
            this.withTransaction = require('../database/database').withTransaction;
        }
        return this.withTransaction;
    }

    /**
     * Inventory repo to write through: the caller's tx-scoped one when a
     * `tx` handle is supplied (ADR-0029), the default otherwise.
     */
    _inventoryRepo(tx) {
        return tx ? new UserInventoryRepository(tx) : this.userInventoryRepository;
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

    async getInventoryItem(userId, itemId, tx = null) {
        return await this._inventoryRepo(tx).findInventoryItem(userId, itemId);
    }

    async addItemToInventory(userId, itemId, quantity = 1, tx = null) {
        const item = await this.itemService.getItemById(itemId);
        if (!item) {
            throw new Error('Item not found');
        }

        // Pre-read only to report `added` in the return shape; the write itself
        // is the atomic upsert below, so two concurrent adds can no longer
        // lost-update (the stored quantity is always exact — `added` is
        // best-effort under a race, exact otherwise).
        const before = (await this.getInventoryItem(userId, itemId, tx))?.quantity ?? 0;

        const updated = await this._inventoryRepo(tx).incrementQuantity(
            userId,
            itemId,
            quantity,
            item.max_stack
        );
        const newQuantity = updated.quantity;

        return {
            itemId,
            quantity: newQuantity,
            added: newQuantity - before
        };
    }

    async removeItemFromInventory(userId, itemId, quantity = 1, tx = null) {
        // Atomic guarded decrement (ADR-0013a; mirrors
        // AccountStatsRepository.atomicSubtractPoints): the UPDATE applies and
        // RETURNs the new quantity only if the row holds >= quantity, so two
        // concurrent removes against the same stack can't both succeed — the
        // loser gets undefined and throws. Closes the item-duplication /
        // double-use race the prior read-then-update allowed. Single statement,
        // so it composes safely inside an outer withTransaction scope.
        const repo = this._inventoryRepo(tx);
        const updated = await repo.decrementQuantity(userId, itemId, quantity);

        if (!updated) {
            // Decrement didn't apply. Disambiguate "missing" vs "insufficient"
            // to preserve the pre-atomic error messages — this read is only for
            // the message; the mutation decision was already made atomically.
            const inventoryItem = await this.getInventoryItem(userId, itemId, tx);
            if (!inventoryItem) {
                throw new Error('Item not in inventory');
            }
            throw new Error('Insufficient quantity');
        }

        const newQuantity = updated.quantity;
        if (newQuantity === 0) {
            await repo.deleteItem(userId, itemId);
        }

        return {
            itemId,
            quantity: newQuantity,
            removed: quantity
        };
    }

    async useItem(userId, itemId, streamId = null) {
        logger.debug(`📦 INVENTORY: useItem called - userId: ${userId}, itemId: ${itemId}, streamId: ${streamId}`);
        const inventoryItem = await this.getInventoryItem(userId, itemId);
        logger.debug(`📦 INVENTORY: inventoryItem result:`, inventoryItem);
        
        if (!inventoryItem) {
            logger.error(`❌ INVENTORY: Item ${itemId} not found for user ${userId}`);
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

        // Consume the item FIRST (audit E5). removeItemFromInventory is the
        // atomic guarded decrement (ADR-0013a), so of two concurrent uses of
        // a 1-stack exactly one passes this line — the loser throws before
        // any effect is applied. The old order (apply buff, then decrement)
        // let both racers apply the effect. If effect application below
        // fails, we compensate by re-adding the unit.
        await this.removeItemFromInventory(userId, itemId, 1);

        // Apply buff/debuff if the item is a buff or debuff type and we have the buff service
        let buffResult = null;
        if (this.buffDebuffService && this.itemService.isBuffOrDebuffItem(item)) {
            // Determine target user - should be the current streamer
            let targetUserId = userId; // Default to self if no streamer
            
            if (this.streamService && this.sessionService) {
                const currentStreamerSocketId = this.streamService.getCurrentStreamer();
                logger.debug(`🔍 INVENTORY DEBUG: Current streamer socket ID: "${currentStreamerSocketId}"`);
                logger.debug(`🔍 INVENTORY DEBUG: ViewbotService available: ${!!this.viewbotService}`);
                logger.debug(`🔍 INVENTORY DEBUG: Starting viewbot targeting logic...`);
                
                if (currentStreamerSocketId) {
                    const streamerSession = this.sessionService.getSessionBySocketId(currentStreamerSocketId);
                    logger.debug(`🔍 INVENTORY DEBUG: Streamer session found: ${!!streamerSession}`);
                    
                    if (streamerSession && streamerSession.userId) {
                        // Apply to any streamer, including anonymous/viewbot users with negative IDs
                        targetUserId = streamerSession.userId;
                        if (targetUserId < 0) {
                            logger.debug(`🎭 INVENTORY: Applying ${item.item_type} "${item.display_name}" to anonymous/viewbot streamer (synthetic ID ${targetUserId})`);
                        } else {
                            logger.debug(`🎭 INVENTORY: Applying ${item.item_type} "${item.display_name}" to current streamer (user ${targetUserId})`);
                        }
                    } else {
                        logger.debug(`🎭 INVENTORY: No session found for streamer, applying to self (user ${userId})`)
                    }
                } else {
                    logger.debug(`🎭 INVENTORY: No active streamer, applying to self (user ${userId})`);
                }
            } else {
                logger.debug(`🎭 INVENTORY: Stream/Session services not available, applying to self (user ${userId})`);
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
                logger.error(`❌ INVENTORY: Error applying ${item.item_type}:`, buffError);
                // Compensate: the unit was already consumed above, so give it
                // back before surfacing the failure (E5). If the re-add itself
                // fails we log and still rethrow the original effect error.
                try {
                    await this.addItemToInventory(userId, itemId, 1);
                } catch (restoreError) {
                    logger.error(`❌ INVENTORY: Failed to restore item ${itemId} to user ${userId} after effect failure:`, restoreError);
                }
                throw buffError; // Re-throw so the user knows the buff failed
            }
        }

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
        // Atomic (ADR-0029): remove + add commit or roll back together, so a
        // failure between them can no longer destroy the item.
        return await this._getWithTransaction()(async (tx) => {
            const fromInventory = await this.getInventoryItem(fromUserId, itemId, tx);

            if (!fromInventory || fromInventory.quantity < quantity) {
                throw new Error('Insufficient items to transfer');
            }

            await this.removeItemFromInventory(fromUserId, itemId, quantity, tx);

            await this.addItemToInventory(toUserId, itemId, quantity, tx);

            return {
                success: true,
                itemId,
                quantity,
                fromUserId,
                toUserId
            };
        });
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

    /**
     * PR 16.3: peer-to-peer gift of an inventory item. Extracted from the
     * inline /api/internal/gift-item handler in server/routes/internal.js.
     * The handler still does username → recipientId and itemName → itemId
     * resolution (HTTP-string-to-domain-id translation); this method owns
     * the eligibility checks (self-gift, is_tradeable, sufficient quantity)
     * and the swap + audit-row write.
     *
     * Transactional since ADR-0029 (audit E3): remove + add + audit INSERT
     * commit or roll back together, so a failure mid-gift can no longer
     * destroy the sender's items or mint unaudited ones.
     *
     * @throws {InventoryError} 400 self-gift, 400 not-tradeable, 400
     *                          insufficient-quantity, 404 item-not-found.
     * @returns {Promise<{ item: { id, name, emoji }, quantity }>} The same
     *          subset the pre-PR handler used to build its 200 response.
     */
    async giftItem(fromUserId, toUserId, itemId, quantity = 1) {
        if (toUserId === fromUserId) {
            throw new InventoryError(400, 'Cannot gift items to yourself');
        }

        const item = await this.itemService.getItemById(itemId);
        if (!item) {
            // The pre-PR route resolved itemId from a name lookup that
            // returned 404 with `Item '<name>' not found` before any
            // InventoryService call. This branch defends the service when
            // a caller hands in an itemId that no longer resolves (e.g.
            // an admin deleted the item between routes lookup + service
            // dispatch). Tiny window; preserve as 404.
            throw new InventoryError(404, 'Item not found');
        }

        if (!item.is_tradeable) {
            throw new InventoryError(400, `${item.display_name} cannot be gifted`);
        }

        const senderInventory = await this.getInventoryItem(fromUserId, itemId);
        if (!senderInventory || senderInventory.quantity < quantity) {
            throw new InventoryError(
                400,
                `You don't have enough ${item.display_name} to gift (have: ${senderInventory?.quantity || 0}, need: ${quantity})`
            );
        }

        await this._getWithTransaction()(async (tx) => {
            await this.removeItemFromInventory(fromUserId, itemId, quantity, tx);
            await this.addItemToInventory(toUserId, itemId, quantity, tx);

            // Audit row, through the tx handle so it rolls back with the swap.
            await tx.runAsync(
                `INSERT INTO gift_transactions (from_user_id, to_user_id, item_id, quantity, timestamp)
                 VALUES (?, ?, ?, ?, datetime('now'))`,
                [fromUserId, toUserId, itemId, quantity]
            );
        });

        return {
            item: {
                id: item.id,
                name: item.display_name,
                emoji: item.emoji,
            },
            quantity,
        };
    }

    /**
     * PR 16.3: list the user's giftable items. Extracted from the inline
     * /api/internal/giftable-items/:userId handler. Filters the full
     * inventory down to rows where the item is `is_tradeable` AND quantity
     * > 0, shaped for the chat client's gift-picker UI.
     *
     * @returns {Promise<Array<{ id, name, display_name, emoji, quantity, rarity }>>}
     */
    async getGiftableItems(userId) {
        const inventory = await this.getUserInventory(userId);
        const giftableItems = [];
        for (const invItem of inventory) {
            const item = await this.itemService.getItemById(invItem.item_id);
            if (item && item.is_tradeable && invItem.quantity > 0) {
                giftableItems.push({
                    id: item.id,
                    name: item.name,
                    display_name: item.display_name,
                    emoji: item.emoji,
                    quantity: invItem.quantity,
                    rarity: item.rarity,
                });
            }
        }
        return giftableItems;
    }
}

module.exports = InventoryService;
module.exports.InventoryError = InventoryError;
