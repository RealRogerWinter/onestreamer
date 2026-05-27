/**
 * ShopRepository
 *
 * Pure SQL wrapper for the shop_items table:
 *   - shop_items              (per-item pricing, availability windows, stock)
 *
 * Read-only methods landed in PR 7.3; write methods (insert, update,
 * delete, stock decrement) landed in PR 7.4 alongside the atomic
 * purchaseItem refactor.
 *
 * Every method JOINs to `items` for display columns. The SELECT shape
 * is shop-centric (anchored on `shop_items`, ordered by
 * `is_featured / rarity / name` for the customer views), so the JOIN
 * lives in this repo rather than crossing over to ItemRepository —
 * same precedent as BuffRepository (PR 6.2) and UserInventoryRepository
 * (PR 7.2).
 *
 * No business logic — `calculateFinalPrice(price, discount)` projection
 * stays in ShopService. Repo methods return raw row shapes; service
 * mutates them.
 *
 * Constructor mirrors the precedent shape across the seven prior repos:
 * deps may be injected for unit-test mocking; when omitted the repo
 * falls back to the real primitives from `server/database/database.js`.
 *
 * Extracted from `server/services/ShopService.js` in PR 7.3.
 */
class ShopRepository {
    /**
     * @param {object} [deps]
     * @param {Function} [deps.getAsync] - (sql, params) => Promise<row|undefined>
     * @param {Function} [deps.runAsync] - (sql, params) => Promise<{ id, changes }>
     * @param {Function} [deps.allAsync] - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        const fallback = require('./../database');
        this.getAsync = deps.getAsync || fallback.getAsync;
        this.runAsync = deps.runAsync || fallback.runAsync;
        this.allAsync = deps.allAsync || fallback.allAsync;
    }

    // ============================================================
    // Customer-facing shop view
    // ============================================================

    /**
     * Customer-facing shop list. Filters to active + purchasable items
     * within their availability window (available_from / available_until
     * NULL-treated as "always"). Ordered featured-first, then rarity DESC,
     * then name. JOINs items for display columns.
     */
    async findActiveItemsForCustomer() {
        return await this.allAsync(
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
    }

    // ============================================================
    // Admin-facing shop view
    // ============================================================

    /**
     * Admin-facing shop list. No availability filter — returns every
     * shop_items row JOIN'd with items. The shop_id column is aliased
     * as `shop_item_id` here (vs `shop_id` in the customer view) and
     * `stock_limit` is aliased as `stock` — both match the legacy
     * getAllShopItems return shape.
     */
    async findAllItemsForAdmin() {
        return await this.allAsync(
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
    }

    // ============================================================
    // Single-row lookups (existence check / purchase-time fetch)
    // ============================================================

    /**
     * Existence check used by ShopService.addItemToShop before deciding
     * insert vs. update. Returns `{id}` of the shop_items row, or
     * `undefined` if no such row exists for `itemId`. Note: returns the
     * shop_items.id, not the items.id — the caller uses it as the FK
     * for the subsequent UPDATE.
     */
    async findShopItemIdByItemId(itemId) {
        return await this.getAsync(
            'SELECT id FROM shop_items WHERE item_id = ?',
            [itemId]
        );
    }

    /**
     * Single-row purchase-time fetch. JOINs items and filters by
     * `is_purchasable = 1` — an item that's been disabled at the items
     * level disappears from this lookup even if a stale shop_items row
     * still references it. The `si.*` projection captures price,
     * discount_percentage, stock_limit, etc.; the items JOIN adds
     * max_stack (for the stack-cap check) and display_name (for error
     * messages and the success response).
     */
    async findItemForPurchase(itemId) {
        return await this.getAsync(
            `SELECT si.*, i.max_stack, i.display_name
             FROM shop_items si
             JOIN items i ON si.item_id = i.id
             WHERE si.item_id = ? AND i.is_purchasable = 1`,
            [itemId]
        );
    }

    // ============================================================
    // Sub-view queries (featured / discounted)
    // ============================================================

    /**
     * Featured items. Filters to is_featured = 1 + active items, ordered
     * by rarity DESC. JOINs item display columns.
     */
    async findFeaturedItems() {
        return await this.allAsync(
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

    /**
     * Discounted items. Filters to discount_percentage > 0 + active
     * items, ordered by discount magnitude DESC. JOINs item display
     * columns.
     */
    async findDiscountedItems() {
        return await this.allAsync(
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

    // ============================================================
    // Write methods (PR 7.4)
    // ============================================================

    /**
     * INSERT a new shop_items row. Seven-column shape matching the legacy
     * `addItemToShop` SQL. Caller (ShopService.addItemToShop) handles the
     * existence-check + dispatch-to-update path.
     */
    async insertShopItem({ itemId, price, discountPercentage, isFeatured, stockLimit, availableFrom, availableUntil }) {
        return await this.runAsync(
            `INSERT INTO shop_items
                (item_id, price, discount_percentage, is_featured, stock_limit, available_from, available_until)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [itemId, price, discountPercentage, isFeatured, stockLimit, availableFrom, availableUntil]
        );
    }

    /**
     * UPDATE selected fields on a shop_items row, identified by `id`.
     * Builds the SET clause dynamically from the keys of `fields`.
     *
     * The repo owns the field-name allowlist (defense in depth — even
     * if a future route handler forwards user input straight in,
     * unsanitized keys are rejected here, not just at the service
     * layer). The allowlist matches the legacy `allowedFields` set
     * from `ShopService.updateShopItem` exactly.
     *
     * Throws if `fields` is empty OR if any key falls outside the
     * allowlist — same as the legacy service-level "No valid fields to
     * update" guard.
     */
    async updateShopItemFields(shopItemId, fields) {
        const allowedFields = [
            'price', 'discount_percentage', 'is_featured',
            'stock_limit', 'available_from', 'available_until',
        ];
        const keys = Object.keys(fields);
        if (keys.length === 0) {
            throw new Error('updateShopItemFields: no fields supplied');
        }
        for (const k of keys) {
            if (!allowedFields.includes(k)) {
                throw new Error(`updateShopItemFields: field not allowed: ${k}`);
            }
        }
        const setClause = keys.map((k) => `${k} = ?`).join(', ');
        const values = keys.map((k) => fields[k]);
        values.push(shopItemId);
        return await this.runAsync(
            `UPDATE shop_items SET ${setClause} WHERE id = ?`,
            values
        );
    }

    /**
     * DELETE a shop_items row by id.
     */
    async deleteShopItemById(shopItemId) {
        return await this.runAsync(
            'DELETE FROM shop_items WHERE id = ?',
            [shopItemId]
        );
    }

    /**
     * Guarded atomic stock decrement: UPDATE shop_items SET stock_limit
     * = stock_limit - ? WHERE id = ? AND stock_limit >= ? RETURNING
     * stock_limit. The guard prevents stock from going negative when
     * two concurrent purchases pass the pre-tx stock check at the
     * service layer; the inner-of-the-two debits gets rolled back via
     * the throw → withTransaction's ROLLBACK path.
     *
     * Returns `undefined` if the guard fails (no row updated); caller
     * is expected to throw a user-facing "Insufficient stock" error in
     * that case so the surrounding transaction rolls back.
     *
     * stock_limit = 0 is the "unlimited stock" sentinel. Callers must
     * skip the decrement entirely for unlimited rows; the guard would
     * succeed (0 >= 0) but the decrement would land at -1.
     */
    async decrementStockLimit(shopItemId, quantity) {
        return await this.getAsync(
            'UPDATE shop_items SET stock_limit = stock_limit - ? WHERE id = ? AND stock_limit >= ? RETURNING stock_limit',
            [quantity, shopItemId, quantity]
        );
    }
}

module.exports = ShopRepository;
