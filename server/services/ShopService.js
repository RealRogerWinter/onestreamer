const { runAsync, getAsync, allAsync } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');
const ShopRepository = require('../database/repository/ShopRepository');
const ItemTransactionRepository = require('../database/repository/ItemTransactionRepository');

class ShopService {
    constructor(itemService, inventoryService, accountService, io = null, deps = {}) {
        this.itemService = itemService;
        this.inventoryService = inventoryService;
        this.accountService = accountService;
        this.io = io;
        this.userRepository = deps.userRepository || new UserRepository({ getAsync, runAsync, allAsync });
        this.shopRepository = deps.shopRepository || new ShopRepository();
        this.itemTransactionRepository = deps.itemTransactionRepository || new ItemTransactionRepository();
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
            console.error('Error initializing shop:', error);
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
        
        console.log('Shop populated with default items');
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

        const result = await runAsync(
            `INSERT INTO shop_items 
             (item_id, price, discount_percentage, is_featured, stock_limit, available_from, available_until)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [itemId, price, discount_percentage, is_featured, stock_limit, available_from, available_until]
        );

        return { id: result.id, itemId, price, ...options };
    }

    async updateShopItem(shopItemId, updates) {
        const allowedFields = [
            'price', 'discount_percentage', 'is_featured', 
            'stock_limit', 'available_from', 'available_until'
        ];

        const fields = Object.keys(updates).filter(field => allowedFields.includes(field));
        if (fields.length === 0) {
            throw new Error('No valid fields to update');
        }

        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const values = fields.map(field => updates[field]);
        values.push(shopItemId);

        await runAsync(
            `UPDATE shop_items SET ${setClause} WHERE id = ?`,
            values
        );

        return { success: true };
    }

    async removeItemFromShop(shopItemId) {
        await runAsync('DELETE FROM shop_items WHERE id = ?', [shopItemId]);
        return { success: true };
    }

    async purchaseItem(userId, itemId, quantity = 1) {
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

        // Check current balance
        const currentBalance = await this.accountService.getPointsBalance(userId);
        if (currentBalance < totalCost) {
            throw new Error('Insufficient points');
        }

        if (shopItem.stock_limit !== 0 && shopItem.stock_limit < quantity) {
            throw new Error('Insufficient stock');
        }

        const currentInventory = await this.inventoryService.getInventoryItem(userId, itemId);
        const currentQuantity = currentInventory ? currentInventory.quantity : 0;
        
        // Convert to integer to handle potential string values from database
        const maxStack = parseInt(shopItem.max_stack) || 0;
        if (maxStack > 0 && currentQuantity + quantity > maxStack) {
            throw new Error(`Cannot exceed maximum stack of ${maxStack}`);
        }

        // Deduct points using new method
        const newBalance = await this.accountService.subtractPoints(
            userId,
            totalCost,
            'purchase',
            `Purchased ${quantity}x ${shopItem.display_name}`,
            { itemId, quantity, pricePerItem: finalPrice }
        );

        await this.inventoryService.addItemToInventory(userId, itemId, quantity);

        await this.itemTransactionRepository.insertPurchase({
            userId,
            itemId,
            quantity,
            pricePerItem: finalPrice,
            totalCost,
            pointsBefore: currentBalance,
            pointsAfter: newBalance,
        });

        if (shopItem.stock_limit !== 0) {
            await runAsync(
                'UPDATE shop_items SET stock_limit = stock_limit - ? WHERE id = ?',
                [quantity, shopItem.id]
            );
        }

        // Emit socket event for real-time update
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

        // Get current balance before adding
        const currentBalance = await this.accountService.getPointsBalance(userId);

        await this.inventoryService.removeItemFromInventory(userId, itemId, quantity);

        // Add points using new method
        const newBalance = await this.accountService.addPoints(
            userId,
            totalEarnings,
            'sell',
            `Sold ${quantity}x ${item.display_name}`,
            { itemId, quantity, pricePerItem: sellPrice }
        );

        await this.itemTransactionRepository.insertSell({
            userId,
            itemId,
            quantity,
            pricePerItem: sellPrice,
            totalCost: totalEarnings,
            pointsBefore: currentBalance,
            pointsAfter: newBalance,
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