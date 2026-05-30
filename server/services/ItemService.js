const { runAsync, getAsync, allAsync } = require('../database/database');
const ItemRepository = require('../database/repository/ItemRepository');

const ItemCatalog = require('./item/ItemCatalog');
const CooldownTracker = require('./item/CooldownTracker');
const EffectApplier = require('./item/EffectApplier');
const DefaultItemSeeder = require('./item/DefaultItemSeeder');

const logger = require('../bootstrap/logger').child({ svc: 'ItemService' });
class ItemService {
    /**
     * @param {object} [deps]
     * @param {ItemRepository} [deps.itemRepository] - inject a custom repo
     *   (useful for tests). Defaults to a fresh `ItemRepository()` so the
     *   `new ItemService()` callsites scattered throughout the codebase
     *   continue to work unchanged.
     */
    constructor({ itemRepository } = {}) {
        this.itemRepository = itemRepository || new ItemRepository({ getAsync, runAsync, allAsync });

        // Cohesive collaborators (PR-itemservice-decompose). Each holds an
        // `owner` back-reference to this service; ALL state stays on the
        // service and the public methods below are thin delegators with
        // identical signatures. Routing internal cross-calls through `owner.`
        // preserves spy/override semantics for callers and tests.
        this.catalog = new ItemCatalog(this);
        this.cooldownTracker = new CooldownTracker(this);
        this.effectApplier = new EffectApplier(this);
        this.defaultItemSeeder = new DefaultItemSeeder(this);

        this.initializeDefaultItems();
    }

    async initializeDefaultItems() {
        return this.defaultItemSeeder.initializeDefaultItems();
    }

    async createDefaultItems() {
        return this.defaultItemSeeder.createDefaultItems();
    }

    async createItem(itemData) {
        return this.catalog.createItem(itemData);
    }

    async getItemById(itemId) {
        return this.catalog.getItemById(itemId);
    }

    async getItemByName(name) {
        return this.catalog.getItemByName(name);
    }

    async getAllItems() {
        return this.catalog.getAllItems();
    }

    async getItemsByType(itemType) {
        return this.catalog.getItemsByType(itemType);
    }

    async getItemsByCategory(category) {
        return this.catalog.getItemsByCategory(category);
    }

    async getAllCategories() {
        return this.catalog.getAllCategories();
    }

    async updateItem(itemId, updates) {
        return this.catalog.updateItem(itemId, updates);
    }

    async deleteItem(itemId) {
        return this.catalog.deleteItem(itemId);
    }

    async validateItemUsage(userId, itemId) {
        return this.cooldownTracker.validateItemUsage(userId, itemId);
    }

    async applyItemCooldown(userId, itemId, streamId = null) {
        return this.cooldownTracker.applyItemCooldown(userId, itemId, streamId);
    }

    async getItemCooldowns(userId) {
        return this.cooldownTracker.getItemCooldowns(userId);
    }

    async resetAllItemCooldowns() {
        return this.cooldownTracker.resetAllItemCooldowns();
    }

    async resetUserItemCooldowns(userId) {
        return this.cooldownTracker.resetUserItemCooldowns(userId);
    }

    async getItemStats() {
        return this.cooldownTracker.getItemStats();
    }

    // Apply buff/debuff item (requires BuffDebuffService to be injected)
    async applyBuffDebuffItem(userId, itemId, appliedByUserId, buffDebuffService, skipCooldownValidation = false, streamId = null) {
        return this.effectApplier.applyBuffDebuffItem(userId, itemId, appliedByUserId, buffDebuffService, skipCooldownValidation, streamId);
    }

    // Check if item is a buff or debuff
    isBuffOrDebuffItem(item) {
        return this.effectApplier.isBuffOrDebuffItem(item);
    }

    // Check if item affects cooldowns
    isCooldownModifierItem(item) {
        return this.effectApplier.isCooldownModifierItem(item);
    }

    // Apply cooldown modifier item (requires TakeoverService to be injected)
    async applyCooldownModifierItem(userId, itemId, appliedByUserId, takeoverService, skipCooldownValidation = false) {
        return this.effectApplier.applyCooldownModifierItem(userId, itemId, appliedByUserId, takeoverService, skipCooldownValidation);
    }

    // Get current global cooldown info (requires TakeoverService)
    async getGlobalCooldownInfo(takeoverService) {
        return this.effectApplier.getGlobalCooldownInfo(takeoverService);
    }
}

module.exports = ItemService;
