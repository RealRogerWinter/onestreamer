const { runAsync, getAsync, allAsync, withTransaction } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');
const ShopRepository = require('../database/repository/ShopRepository');
const ItemTransactionRepository = require('../database/repository/ItemTransactionRepository');

const logger = require('../bootstrap/logger').child({ svc: 'ShopService' });
class ShopService {
    constructor(itemService, inventoryService, accountService, io = null, deps = {}) {
        this.itemService = itemService;
        this.inventoryService = inventoryService;
        this.accountService = accountService;
        this.io = io;
        this.userRepository = deps.userRepository || new UserRepository({ getAsync, runAsync, allAsync });
        this.shopRepository = deps.shopRepository || new ShopRepository();
        this.itemTransactionRepository = deps.itemTransactionRepository || new ItemTransactionRepository();
        // Injected for testability — withTransaction is normally the module
        // singleton from database.js. Tests override with an isolated helper
        // bound to an in-memory connection (see purchaseItem.atomic.test.js).
        this.withTransaction = deps.withTransaction || withTransaction;
        this.initializeShop();
    }

    setSocketIO(io) {
        this.io = io;
    }

    async initializeShop() {
        try {
            const shopItems = await this.getShopItems();
            if (shopItems.length === 0) {
                await this.populateDefaultShop();
            }
        } catch (error) {
            logger.error('Error initializing shop:', error);
        }
    }

    async populateDefaultShop() {
        const items = await this.itemService.getAllItems();
        
        for (const item of items) {
            if (item.is_purchasable) {
                await this.addItemToShop(item.id, item.base_price, {
                    is_featured: item.rarity === 'epic' || item.rarity === 'legendary'
                });
            }
        }
        
        logger.debug('Shop populated with default items');
    }

    async getShopItems() {
        const shopItems = await this.shopRepository.findActiveItemsForCustomer();

        return shopItems.map(item => ({
            ...item,
            final_price: this.calculateFinalPrice(item.price, item.discount_percentage)
        }));
    }

    async getAllShopItems() {
        // Admin version - returns ALL shop items without availability filters
        const shopItems = await this.shopRepository.findAllItemsForAdmin();

        return shopItems.map(item => ({
            ...item,
            final_price: this.calculateFinalPrice(item.price, item.discount_percentage),
            item: {
                id: item.item_id,
                name: item.name,
                display_name: item.display_name,
                emoji: item.emoji,
                description: item.description,
                item_type: item.item_type,
                rarity: item.rarity,
                cooldown_seconds: item.cooldown_seconds,
                max_stack: item.max_stack
            }
        }));
    }

    calculateFinalPrice(basePrice, discountPercentage) {
        if (!discountPercentage || discountPercentage === 0) {
            return basePrice;
        }
        return Math.floor(basePrice * (1 - discountPercentage / 100));
    }

    async addItemToShop(itemId, price, options = {}) {
        const {
            discount_percentage = 0,
            is_featured = false,
            stock_limit = 0,
            available_from = null,
            available_until = null
        } = options;

        const existing = await this.shopRepository.findShopItemIdByItemId(itemId);

        if (existing) {
            return await this.updateShopItem(existing.id, { price, ...options });
        }

        const result = await this.shopRepository.insertShopItem({
            itemId,
            price,
            discountPercentage: discount_percentage,
            isFeatured: is_featured,
            stockLimit: stock_limit,
            availableFrom: available_from,
            availableUntil: available_until,
        });

        return { id: result.id, itemId, price, ...options };
    }

    async updateShopItem(shopItemId, updates) {
        const allowedFields = [
            'price', 'discount_percentage', 'is_featured',
            'stock_limit', 'available_from', 'available_until'
        ];

        const fields = {};
        for (const key of Object.keys(updates)) {
            if (allowedFields.includes(key)) fields[key] = updates[key];
        }
        if (Object.keys(fields).length === 0) {
            throw new Error('No valid fields to update');
        }

        await this.shopRepository.updateShopItemFields(shopItemId, fields);

        return { success: true };
    }

    async removeItemFromShop(shopItemId) {
        await this.shopRepository.deleteShopItemById(shopItemId);
        return { success: true };
    }

    async purchaseItem(userId, itemId, quantity = 1) {
        // Pre-tx validation. Read-only checks for fast-fail on common errors
        // (no points, no stock, max-stack exceeded). The atomic-guard SQL inside
        // subtractPoints (ADR-0013a) is the source of truth — these pre-checks
        // just give the user a clean error before we pay the tx-open cost.
        const user = await this.userRepository.getById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        const shopItem = await this.shopRepository.findItemForPurchase(itemId);
        if (!shopItem) {
            throw new Error('Item not available in shop');
        }

        const finalPrice = this.calculateFinalPrice(shopItem.price, shopItem.discount_percentage);
        const totalCost = finalPrice * quantity;

        const currentBalance = await this.accountService.getPointsBalance(userId);
        if (currentBalance < totalCost) {
            throw new Error('Insufficient points');
        }

        if (shopItem.stock_limit !== 0 && shopItem.stock_limit < quantity) {
            throw new Error('Insufficient stock');
        }

        const currentInventory = await this.inventoryService.getInventoryItem(userId, itemId);
        const currentQuantity = currentInventory ? currentInventory.quantity : 0;
        const maxStack = parseInt(shopItem.max_stack) || 0;
        if (maxStack > 0 && currentQuantity + quantity > maxStack) {
            throw new Error(`Cannot exceed maximum stack of ${maxStack}`);
        }

        // Atomic money flow (ADR-0015). Wraps, in order:
        //   1. subtractPoints       — debit user_stats (atomic per ADR-0013a;
        //                             inside the tx so a downstream throw rolls it back)
        //   2. decrementStockLimit  — guarded UPDATE; throws "Insufficient stock"
        //                             inside the tx if a concurrent purchase consumed
        //                             the last unit between our pre-check and our debit
        //   3. inventory cap re-check — re-reads inventory inside the scope; the pre-check
        //                             at the top of this method is a fast-fail UX hint,
        //                             this re-check is the source of truth
        //   4. addItemToInventory   — credit user_inventory
        //   5. insertPurchase       — audit row in item_transactions
        //
        // If any step throws (e.g. SQLite I/O error mid-tx, or the server crashes),
        // the connection rolls back on next open / on the next withTransaction call
        // and the user is NOT debited. See ADR-0015 for the crash-recovery story.
        //
        // Every write goes through the `tx` handle (ADR-0029): the service/repo
        // layers accept a per-call tx and build tx-scoped repos from it, so
        // atomicity no longer depends on the shared-connection implicit join
        // (which the gated module wrappers have closed — audit DB2).
        const newBalance = await this.withTransaction(async (tx) => {
            const balanceAfter = await this.accountService.subtractPoints(
                userId,
                totalCost,
                'purchase',
                `Purchased ${quantity}x ${shopItem.display_name}`,
                { itemId, quantity, pricePerItem: finalPrice },
                tx
            );

            // Guarded stock decrement happens BEFORE inventory credit so a
            // SQLITE-level race against a concurrent purchaser surfaces as a
            // user-facing "Insufficient stock" before we've started writing
            // inventory rows. The guard returns no row when stock_limit < quantity;
            // we throw, the tx rolls back, no one is debited.
            if (shopItem.stock_limit !== 0) {
                const after = await new ShopRepository(tx).decrementStockLimit(shopItem.id, quantity);
                if (!after) {
                    throw new Error('Insufficient stock');
                }
            }

            // Inventory cap re-check inside the scope. The pre-tx check at the
            // top of purchaseItem is a UX fast-fail; this is the source of truth.
            // addItemToInventory itself silently clamps to max_stack rather than
            // throwing, so without this check a user purchasing past their cap
            // would get debited the full price but receive only (cap - currentQty)
            // items. Throwing here triggers ROLLBACK.
            const inventoryNow = await this.inventoryService.getInventoryItem(userId, itemId, tx);
            const quantityNow = inventoryNow ? inventoryNow.quantity : 0;
            if (maxStack > 0 && quantityNow + quantity > maxStack) {
                throw new Error(`Cannot exceed maximum stack of ${maxStack}`);
            }

            await this.inventoryService.addItemToInventory(userId, itemId, quantity, tx);

            // Compute pointsBefore from the exact-subtract relationship:
            // subtractPoints succeeded iff balanceAfter = oldBalance - totalCost,
            // so oldBalance = balanceAfter + totalCost. This is more accurate
            // than the pre-tx `currentBalance` read, which can race with
            // concurrent debits/credits from other code paths.
            await new ItemTransactionRepository(tx).insertPurchase({
                userId,
                itemId,
                quantity,
                pricePerItem: finalPrice,
                totalCost,
                pointsBefore: balanceAfter + totalCost,
                pointsAfter: balanceAfter,
            });

            return balanceAfter;
        });

        // Side effects after commit. Emitting the socket event inside the tx
        // would surface "points-updated" to the client before COMMIT — if the
        // tx then rolled back, the client would show a balance that didn't
        // actually exist. Outside the tx, ordering is: tx commits → emit.
        if (this.io) {
            this.io.emit('points-updated', {
                userId,
                points: newBalance,
                updateType: 'purchase',
                item: shopItem.display_name,
                quantity,
                totalCost,
                timestamp: Date.now()
            });
        }

        return {
            success: true,
            item: shopItem.display_name,
            quantity,
            totalCost,
            remainingPoints: newBalance
        };
    }

    async sellItem(userId, itemId, quantity = 1) {
        const user = await this.userRepository.getById(userId);

        if (!user) {
            throw new Error('User not found');
        }

        const inventoryItem = await this.inventoryService.getInventoryItem(userId, itemId);
        
        if (!inventoryItem || inventoryItem.quantity < quantity) {
            throw new Error('Insufficient items to sell');
        }

        const item = await this.itemService.getItemById(itemId);
        const sellPrice = Math.floor(item.base_price * 0.5); // 50% of base price
        const totalEarnings = sellPrice * quantity;

        // Guard BEFORE removing (audit E3): a zero-value sell (base_price 0/1
        // floors to 0) used to destroy the items for no points. Reject instead.
        if (totalEarnings === 0) {
            throw new Error('Item has no resale value');
        }

        // Atomic (ADR-0029): remove + credit + audit row commit or roll back
        // together, so a failure mid-sell can no longer destroy items without
        // paying, and pointsBefore derives from the exact credit relationship
        // instead of a racy pre-read.
        const newBalance = await this.withTransaction(async (tx) => {
            await this.inventoryService.removeItemFromInventory(userId, itemId, quantity, tx);

            const balanceAfter = await this.accountService.addPoints(
                userId,
                totalEarnings,
                'sell',
                `Sold ${quantity}x ${item.display_name}`,
                { itemId, quantity, pricePerItem: sellPrice },
                tx
            );

            await new ItemTransactionRepository(tx).insertSell({
                userId,
                itemId,
                quantity,
                pricePerItem: sellPrice,
                totalCost: totalEarnings,
                pointsBefore: balanceAfter - totalEarnings,
                pointsAfter: balanceAfter,
            });

            return balanceAfter;
        });

        // Emit socket event for real-time update
        if (this.io) {
            this.io.emit('points-updated', {
                userId,
                points: newBalance,
                updateType: 'sell',
                item: item.display_name,
                quantity,
                totalEarnings,
                timestamp: Date.now()
            });
        }

        return {
            success: true,
            item: item.display_name,
            quantity,
            totalEarnings,
            remainingPoints: newBalance
        };
    }

    async getFeaturedItems() {
        return await this.shopRepository.findFeaturedItems();
    }

    async getDiscountedItems() {
        return await this.shopRepository.findDiscountedItems();
    }

    async getUserTransactionHistory(userId, limit = 20) {
        return await this.itemTransactionRepository.findHistoryForUser(userId, limit);
    }

    async getShopStatistics() {
        const stats = await this.itemTransactionRepository.aggregateForShop();
        const popularItems = await this.itemTransactionRepository.findPopularItems(10);

        return {
            ...stats,
            popularItems
        };
    }
}

module.exports = ShopService;
