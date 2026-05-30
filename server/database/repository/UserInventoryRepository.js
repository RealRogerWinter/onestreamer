/**
 * UserInventoryRepository
 *
 * Pure SQL wrapper for the user_inventory table:
 *   - user_inventory          (per-user item counts + last-used timestamp)
 *
 * Several methods JOIN to `items` for display data and aggregate columns.
 * The JOIN is anchored on user_inventory and the SELECT shape is
 * inventory-centric, so the JOIN lives here rather than crossing over
 * to ItemRepository — same precedent as BuffRepository (PR 6.2), which
 * also JOINs to items for its buff-display columns.
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Stack-limit clamping, cooldown
 * application, and the result projection that InventoryService returns
 * to its callers all stay in InventoryService.
 *
 * The `item_transactions` INSERT in InventoryService.grantItemsToUser is
 * deliberately NOT extracted by this repo — it targets a different table
 * (item_transactions) and will be extracted by PR 7.3's
 * ItemTransactionRepository.
 *
 * Constructor mirrors the UserRepository / ChatBotRepository /
 * ViewBotRepository / BuffRepository pattern: deps may be injected for
 * unit-test mocking; when omitted the repo falls back to the real
 * primitives from `server/database/database.js`.
 *
 * Extracted from `server/services/InventoryService.js` in PR 7.2.
 * Pre-extraction: 11 inline call-sites against user_inventory.
 */
class UserInventoryRepository {
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
    // Read queries (JOIN items)
    // ============================================================

    /**
     * Active inventory rows for a user, JOIN'd with item display columns.
     * Excludes zero-quantity rows and inactive items. Ordered for UI:
     * rarity DESC (legendary first by string ordering — preserved from
     * the pre-extraction query shape), then name.
     */
    async findInventoryWithItemsForUser(userId) {
        return await this.allAsync(
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
                i.category,
                i.rarity,
                i.cooldown_seconds,
                i.max_stack
             FROM user_inventory ui
             JOIN items i ON ui.item_id = i.id
             WHERE ui.user_id = ? AND ui.quantity > 0 AND i.is_active = 1
             ORDER BY i.rarity DESC, i.name`,
            [userId]
        );
    }

    /**
     * Single inventory row for a (user, item) pair, JOIN'd with item
     * display columns. Returns `undefined` if no row exists. Note the
     * `ui.*` projection — callers consume both inventory columns
     * (quantity, last_used_at, acquired_at) and item columns (name,
     * cooldown_seconds, max_stack).
     */
    async findInventoryItem(userId, itemId) {
        return await this.getAsync(
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

    /**
     * Aggregate inventory value for a user — total_value (quantity ×
     * base_price summed), unique_items (distinct item_ids), total_items
     * (sum of quantities). Excludes zero-quantity rows.
     */
    async aggregateValueForUser(userId) {
        return await this.getAsync(
            `SELECT
                SUM(ui.quantity * i.base_price) as total_value,
                COUNT(DISTINCT ui.item_id) as unique_items,
                SUM(ui.quantity) as total_items
             FROM user_inventory ui
             JOIN items i ON ui.item_id = i.id
             WHERE ui.user_id = ? AND ui.quantity > 0`,
            [userId]
        );
    }

    /**
     * Per-rarity rollup of a user's inventory. Returns one row per
     * distinct rarity that has at least one item, ordered
     * legendary → epic → rare → uncommon → common via an explicit CASE
     * (string-ordering the rarity column would put 'common' first).
     */
    async aggregateByRarity(userId) {
        return await this.allAsync(
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
    }

    /**
     * Most-recently-used inventory rows for a user, capped at `limit`.
     * Filters out rows that have never been used (last_used_at IS NULL)
     * and JOINs items for display data.
     */
    async findRecentlyUsed(userId, limit) {
        return await this.allAsync(
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
    }

    // ============================================================
    // Write queries (user_inventory only)
    // ============================================================

    /**
     * Insert a new (user, item) row with an initial quantity. The
     * UNIQUE(user_id, item_id) constraint on user_inventory means this
     * fails if a row already exists — callers check via
     * `findInventoryItem` before deciding insert vs. update.
     */
    async insertItem(userId, itemId, quantity) {
        return await this.runAsync(
            'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)',
            [userId, itemId, quantity]
        );
    }

    /**
     * Set the quantity for an existing (user, item) row. Both
     * "increase" (after adding to an existing stack) and "decrease"
     * (after consuming items) paths use this same shape.
     */
    async updateQuantity(userId, itemId, quantity) {
        return await this.runAsync(
            'UPDATE user_inventory SET quantity = ? WHERE user_id = ? AND item_id = ?',
            [quantity, userId, itemId]
        );
    }

    /**
     * Atomically decrement a (user, item) quantity by `amount`, but ONLY if the
     * row currently holds at least `amount`, returning the post-write quantity
     * in a single statement (mirrors AccountStatsRepository.atomicSubtractPoints,
     * ADR-0013a). Returns `undefined` on no-match — the row is missing OR holds
     * less than `amount` — so a caller can detect a lost race instead of a
     * read-modify-write that two concurrent removes could both pass, thereby
     * double-spending a single stack. Single statement, so it composes safely
     * inside an outer withTransaction scope (no nested BEGIN).
     *
     * **DO NOT** refactor to a read-compute-write. The guard is the fence.
     */
    async decrementQuantity(userId, itemId, amount) {
        return await this.getAsync(
            `UPDATE user_inventory
                SET quantity = quantity - ?
              WHERE user_id = ? AND item_id = ? AND quantity >= ?
          RETURNING quantity`,
            [amount, userId, itemId, amount]
        );
    }

    /**
     * Stamp last_used_at = CURRENT_TIMESTAMP for a (user, item) row.
     * Called after a useItem invocation succeeds.
     */
    async markUsed(userId, itemId) {
        return await this.runAsync(
            'UPDATE user_inventory SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND item_id = ?',
            [userId, itemId]
        );
    }

    /**
     * Delete the (user, item) row entirely. Used when a quantity-zero
     * state would otherwise persist after removeItemFromInventory.
     */
    async deleteItem(userId, itemId) {
        return await this.runAsync(
            'DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?',
            [userId, itemId]
        );
    }

    /**
     * Wipe all inventory rows for a user. Admin / test-fixture path.
     */
    async deleteAllForUser(userId) {
        return await this.runAsync(
            'DELETE FROM user_inventory WHERE user_id = ?',
            [userId]
        );
    }
}

module.exports = UserInventoryRepository;
