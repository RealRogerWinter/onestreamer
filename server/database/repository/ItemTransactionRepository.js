/**
 * ItemTransactionRepository
 *
 * Pure SQL wrapper for the item_transactions table:
 *   - item_transactions       (per-event audit log of every item flow)
 *
 * The table is append-only by design: every purchase, sell, admin grant,
 * and (future) gift writes a row capturing user, item, quantity, prices,
 * and the points balance before/after the operation. There are no
 * UPDATEs or DELETEs against this table anywhere in the codebase, and
 * this repo does not expose any. If a future PR ever needs to mutate
 * existing rows, that's a schema-design conversation, not a repo
 * convenience.
 *
 * Three INSERT shapes:
 *   - insertPurchase  — full eight-column shape used by ShopService.purchaseItem
 *                       (points_before, points_after captured for audit)
 *   - insertSell      — same eight-column shape used by ShopService.sellItem
 *                       (the price_per_item is the sell-back price, not the
 *                       original purchase price)
 *   - insertAdminGrant — six-column shape used by InventoryService.grantItemsToUser
 *                       (price_per_item=0, total_cost=0; points_before/after
 *                       are NULL because no balance change occurs)
 *
 * Three SELECT shapes:
 *   - findHistoryForUser   — paged history view, JOIN items for display data
 *   - aggregateForShop     — admin-facing rollup (unique buyers, totals)
 *   - findPopularItems     — top-N purchased items, JOIN items for display data
 *
 * No business logic — display projection (`item.display_name`,
 * `Math.floor(base_price * 0.5)` sell-price calc, the per-transaction
 * description string) stays in the calling service.
 *
 * Constructor mirrors the precedent shape across the seven prior repos:
 * deps may be injected for unit-test mocking; when omitted the repo
 * falls back to the real primitives from `server/database/database.js`.
 *
 * Extracted from `server/services/ShopService.js` + `server/services/InventoryService.js`
 * in PR 7.3.
 */
class ItemTransactionRepository {
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
    // Inserts (one per transaction_type)
    // ============================================================

    /**
     * Purchase audit row. All eight observed columns populated. Caller
     * (ShopService.purchaseItem) is responsible for providing the
     * points_before / points_after values it captured around the
     * subtractPoints call.
     */
    async insertPurchase({ userId, itemId, quantity, pricePerItem, totalCost, pointsBefore, pointsAfter }) {
        return await this.runAsync(
            `INSERT INTO item_transactions
                (user_id, item_id, transaction_type, quantity, price_per_item, total_cost, points_before, points_after)
             VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?)`,
            [userId, itemId, quantity, pricePerItem, totalCost, pointsBefore, pointsAfter]
        );
    }

    /**
     * Sell-back audit row. Same shape as `insertPurchase`. The
     * transaction_type='sell' value is the only fixed column; everything
     * else is per-call.
     */
    async insertSell({ userId, itemId, quantity, pricePerItem, totalCost, pointsBefore, pointsAfter }) {
        return await this.runAsync(
            `INSERT INTO item_transactions
                (user_id, item_id, transaction_type, quantity, price_per_item, total_cost, points_before, points_after)
             VALUES (?, ?, 'sell', ?, ?, ?, ?, ?)`,
            [userId, itemId, quantity, pricePerItem, totalCost, pointsBefore, pointsAfter]
        );
    }

    /**
     * Admin-grant audit row. Six columns: price_per_item and total_cost
     * are pinned to 0 in the SQL (the legacy InventoryService.grantItemsToUser
     * SQL bound 0 literally; preserved as a literal here rather than
     * accepting per-call values that would always be 0). points_before /
     * points_after are not bound — the column defaults are used (NULL).
     */
    async insertAdminGrant({ userId, itemId, quantity }) {
        return await this.runAsync(
            `INSERT INTO item_transactions
                (user_id, item_id, transaction_type, quantity, price_per_item, total_cost)
             VALUES (?, ?, 'admin_grant', ?, 0, 0)`,
            [userId, itemId, quantity]
        );
    }

    // ============================================================
    // Selects
    // ============================================================

    /**
     * Per-user transaction history with item display columns JOIN'd.
     * Newest first, capped at `limit`. Preserves the pre-extraction
     * SELECT shape (`it.*` + item display fields).
     */
    async findHistoryForUser(userId, limit) {
        return await this.allAsync(
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

    /**
     * Admin-facing shop aggregates over the full item_transactions table
     * (filtered to purchase + sell — the two transaction types that
     * move points). Returns one row: unique_buyers, total_transactions,
     * total_revenue (purchase total_costs), total_buyback (sell
     * total_costs).
     */
    async aggregateForShop() {
        return await this.getAsync(
            `SELECT
                COUNT(DISTINCT user_id) as unique_buyers,
                COUNT(*) as total_transactions,
                SUM(CASE WHEN transaction_type = 'purchase' THEN total_cost ELSE 0 END) as total_revenue,
                SUM(CASE WHEN transaction_type = 'sell' THEN total_cost ELSE 0 END) as total_buyback
             FROM item_transactions
             WHERE transaction_type IN ('purchase', 'sell')`
        );
    }

    /**
     * Top-N most-purchased items by transaction count. JOIN items for
     * display data (display_name, emoji). Used by ShopService.getShopStatistics.
     */
    async findPopularItems(limit) {
        return await this.allAsync(
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
             LIMIT ?`,
            [limit]
        );
    }
}

module.exports = ItemTransactionRepository;
