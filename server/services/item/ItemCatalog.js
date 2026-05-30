/**
 * ItemCatalog.js - catalog CRUD/reads extracted from ItemService.
 *
 * Owns item creation, lookups, listing, category reshaping, updates and
 * soft-delete. Reads owner.itemRepository via the `owner` back-reference so
 * behavior is byte-identical to the in-service form — only `this.`→`owner.`.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'ItemService' });

class ItemCatalog {
    constructor(owner) {
        this.owner = owner;
    }

    async createItem(itemData) {
        const owner = this.owner;
        const {
            name,
            display_name,
            emoji,
            description,
            item_type,
            category = 'misc',
            rarity,
            base_price = 0,
            is_purchasable = true,
            is_active = true,
            cooldown_seconds = 0,
            max_stack = 0,
            duration_seconds = 0,
            effect_data = null,
            stack_behavior = 'replace'
        } = itemData;

        try {
            const result = await owner.itemRepository.create({
                name, display_name, emoji, description, item_type, category,
                rarity, base_price, is_purchasable, is_active,
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            });

            return {
                id: result.id,
                ...itemData
            };
        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                logger.debug(`Item ${name} already exists`);
                return await owner.getItemByName(name);
            }
            throw error;
        }
    }

    async getItemById(itemId) {
        const owner = this.owner;
        return await owner.itemRepository.getById(itemId);
    }

    async getItemByName(name) {
        const owner = this.owner;
        return await owner.itemRepository.getByName(name);
    }

    async getAllItems() {
        const owner = this.owner;
        return await owner.itemRepository.listAllActive();
    }

    async getItemsByType(itemType) {
        const owner = this.owner;
        return await owner.itemRepository.listByType(itemType);
    }

    async getItemsByCategory(category) {
        const owner = this.owner;
        return await owner.itemRepository.listByCategory(category);
    }

    async getAllCategories() {
        const owner = this.owner;
        const result = await owner.itemRepository.listDistinctCategories();

        // Transform to a more useful format
        const categories = result.map(row => ({
            value: row.category,
            label: row.category.split('_').map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' '),
            count: 0
        }));

        // Get counts for each category
        for (const cat of categories) {
            const countResult = await owner.itemRepository.countByCategory(cat.value);
            cat.count = countResult.count;
        }

        return categories;
    }

    async updateItem(itemId, updates) {
        const owner = this.owner;
        const allowedFields = [
            'display_name', 'emoji', 'description', 'base_price',
            'is_purchasable', 'is_active', 'cooldown_seconds', 'max_stack',
            'duration_seconds', 'item_type', 'rarity', 'name', 'category'
        ];

        const filteredEntries = Object.entries(updates).filter(([field]) => allowedFields.includes(field));
        if (filteredEntries.length === 0) {
            throw new Error('No valid fields to update');
        }

        const filteredUpdates = Object.fromEntries(filteredEntries);
        await owner.itemRepository.update(itemId, filteredUpdates);

        return await owner.getItemById(itemId);
    }

    async deleteItem(itemId) {
        const owner = this.owner;
        await owner.itemRepository.softDelete(itemId);
    }
}

module.exports = ItemCatalog;
