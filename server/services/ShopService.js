const { runAsync, getAsync, allAsync } = require('../database/database');

class ShopService {
    constructor(itemService, inventoryService, accountService, io = null) {
        this.itemService = itemService;
        this.inventoryService = inventoryService;
        this.accountService = accountService;
        this.io = io;
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
        const shopItems = await allAsync(
            `SELECT 
                si.id as shop_id,
                si.price,
                si.discount_percentage,
                si.is_featured,
                si.stock_limit,
                si.available_from,
                si.available_until,
                i.id as item_id,
                i.name,
                i.display_name,
                i.emoji,
                i.description,
                i.item_type,
                i.category,
                i.rarity,
                i.cooldown_seconds,
                i.max_stack
             FROM shop_items si
             JOIN items i ON si.item_id = i.id
             WHERE i.is_active = 1 
               AND i.is_purchasable = 1
               AND (si.available_from IS NULL OR datetime(si.available_from) <= datetime('now'))
               AND (si.available_until IS NULL OR datetime(si.available_until) > datetime('now'))
             ORDER BY si.is_featured DESC, i.rarity DESC, i.name`
        );

        return shopItems.map(item => ({
            ...item,
            final_price: this.calculateFinalPrice(item.price, item.discount_percentage)
        }));
    }

    async getAllShopItems() {
        // Admin version - returns ALL shop items without availability filters
        const shopItems = await allAsync(
            `SELECT 
                si.id as shop_item_id,
                si.price,
                si.discount_percentage,
                si.is_featured,
                si.stock_limit as stock,
                si.available_from,
                si.available_until,
                i.id as item_id,
                i.name,
                i.display_name,
                i.emoji,
                i.description,
                i.item_type,
                i.category,
                i.rarity,
                i.cooldown_seconds,
                i.max_stack
             FROM shop_items si
             JOIN items i ON si.item_id = i.id
             ORDER BY si.is_featured DESC, i.rarity DESC, i.name`
        );

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

        const existing = await getAsync(
            'SELECT id FROM shop_items WHERE item_id = ?',
            [itemId]
        );

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
        const user = await getAsync(
            'SELECT * FROM users WHERE id = ?',
            [userId]
        );

        if (!user) {
            throw new Error('User not found');
        }

        const shopItem = await getAsync(
            `SELECT si.*, i.max_stack, i.display_name 
             FROM shop_items si
             JOIN items i ON si.item_id = i.id
             WHERE si.item_id = ? AND i.is_purchasable = 1`,
            [itemId]
        );

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

        await runAsync(
            `INSERT INTO item_transactions 
             (user_id, item_id, transaction_type, quantity, price_per_item, total_cost, points_before, points_after)
             VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?)`,
            [userId, itemId, quantity, finalPrice, totalCost, currentBalance, newBalance]
        );

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
        const user = await getAsync(
            'SELECT * FROM users WHERE id = ?',
            [userId]
        );

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

        await runAsync(
            `INSERT INTO item_transactions 
             (user_id, item_id, transaction_type, quantity, price_per_item, total_cost, points_before, points_after)
             VALUES (?, ?, 'sell', ?, ?, ?, ?, ?)`,
            [userId, itemId, quantity, sellPrice, totalEarnings, currentBalance, newBalance]
        );

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
        return await allAsync(
            `SELECT 
                si.*,
                i.name,
                i.display_name,
                i.emoji,
                i.description,
                i.rarity
             FROM shop_items si
             JOIN items i ON si.item_id = i.id
             WHERE si.is_featured = 1 AND i.is_active = 1
             ORDER BY i.rarity DESC`
        );
    }

    async getDiscountedItems() {
        return await allAsync(
            `SELECT 
                si.*,
                i.name,
                i.display_name,
                i.emoji,
                i.description,
                i.rarity
             FROM shop_items si
             JOIN items i ON si.item_id = i.id
             WHERE si.discount_percentage > 0 AND i.is_active = 1
             ORDER BY si.discount_percentage DESC`
        );
    }

    async getUserTransactionHistory(userId, limit = 20) {
        return await allAsync(
            `SELECT 
                it.*,
                i.name,
                i.display_name,
                i.emoji
             FROM item_transactions it
             JOIN items i ON it.item_id = i.id
             WHERE it.user_id = ?
             ORDER BY it.created_at DESC
             LIMIT ?`,
            [userId, limit]
        );
    }

    async getShopStatistics() {
        const stats = await getAsync(
            `SELECT 
                COUNT(DISTINCT user_id) as unique_buyers,
                COUNT(*) as total_transactions,
                SUM(CASE WHEN transaction_type = 'purchase' THEN total_cost ELSE 0 END) as total_revenue,
                SUM(CASE WHEN transaction_type = 'sell' THEN total_cost ELSE 0 END) as total_buyback
             FROM item_transactions
             WHERE transaction_type IN ('purchase', 'sell')`
        );

        const popularItems = await allAsync(
            `SELECT 
                i.display_name,
                i.emoji,
                COUNT(*) as purchase_count,
                SUM(it.quantity) as total_quantity
             FROM item_transactions it
             JOIN items i ON it.item_id = i.id
             WHERE it.transaction_type = 'purchase'
             GROUP BY it.item_id
             ORDER BY purchase_count DESC
             LIMIT 10`
        );

        return {
            ...stats,
            popularItems
        };
    }
}

module.exports = ShopService;