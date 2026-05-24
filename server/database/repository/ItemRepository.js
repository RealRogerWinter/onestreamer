/**
 * ItemRepository
 *
 * Pure SQL wrapper for the `items` table. No business logic — methods are
 * thin shims over the DB primitives (`getAsync`, `runAsync`, `allAsync`).
 *
 * The constructor accepts `{getAsync, runAsync, allAsync}` so the repository
 * can be unit-tested with mocked DB primitives. When constructed without
 * arguments it falls back to the real primitives exported from
 * `server/database/database.js`, which preserves backwards compatibility
 * with callers that instantiate it as `new ItemRepository()`.
 *
 * Introduced in PR-Q4 — the second per-entity repository after
 * `UserRepository`. Follows the same conventions: callers that need a
 * projection or filter not yet covered here should add a dedicated method
 * rather than post-filtering the result of a generic call.
 *
 * Where the legacy inline SQL stamped `updated_at = CURRENT_TIMESTAMP`,
 * the repository preserves that exact behavior. Where it did not, the
 * repository does NOT auto-stamp.
 */
class ItemRepository {
    /**
     * @param {object} [deps]
     * @param {Function} [deps.getAsync]  - (sql, params) => Promise<row|undefined>
     * @param {Function} [deps.runAsync]  - (sql, params) => Promise<{ id, changes }>
     * @param {Function} [deps.allAsync]  - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        const fallback = require('./../database');
        this.getAsync = deps.getAsync || fallback.getAsync;
        this.runAsync = deps.runAsync || fallback.runAsync;
        this.allAsync = deps.allAsync || fallback.allAsync;
    }

    /**
     * Fetch an active item row by primary key.
     * Mirrors the legacy `ItemService.getItemById` SQL — note the
     * `AND is_active = 1` filter (soft-deletes are excluded).
     */
    async getById(id) {
        return await this.getAsync(
            `SELECT * FROM items WHERE id = ? AND is_active = 1`,
            [id]
        );
    }

    /**
     * Fetch an active item row by unique name. Like `getById`, the
     * `is_active = 1` filter is part of the legacy semantics.
     */
    async getByName(name) {
        return await this.getAsync(
            `SELECT * FROM items WHERE name = ? AND is_active = 1`,
            [name]
        );
    }

    /**
     * Raw item lookup by primary key with NO `is_active` filter. Used by
     * the few sites (e.g. BuffDebuffService anonymous-buff enrichment, the
     * `add-summon-lesser-bot-item` migration) that need to see soft-deleted
     * rows. Preserves the legacy SQL byte-for-byte.
     */
    async getByIdIncludingInactive(id) {
        return await this.getAsync(
            `SELECT * FROM items WHERE id = ?`,
            [id]
        );
    }

    /**
     * List all active items ordered by rarity then name.
     */
    async listAllActive() {
        return await this.allAsync(
            `SELECT * FROM items WHERE is_active = 1 ORDER BY rarity, name`
        );
    }

    /**
     * List all active items of a given `item_type` (e.g. 'buff', 'debuff',
     * 'utility'). No ORDER BY in the legacy SQL — preserved.
     */
    async listByType(itemType) {
        return await this.allAsync(
            `SELECT * FROM items WHERE item_type = ? AND is_active = 1`,
            [itemType]
        );
    }

    /**
     * List all active items in a given category, ordered by display_name.
     */
    async listByCategory(category) {
        return await this.allAsync(
            `SELECT * FROM items WHERE category = ? AND is_active = 1 ORDER BY display_name`,
            [category]
        );
    }

    /**
     * List distinct non-null category strings across all active items.
     * Returns the raw rows (one column: `category`). Caller is responsible
     * for any reshaping.
     */
    async listDistinctCategories() {
        return await this.allAsync(
            `SELECT DISTINCT category FROM items WHERE is_active = 1 AND category IS NOT NULL ORDER BY category`
        );
    }

    /**
     * Count of active items in a given category. Returns the raw row
     * `{ count }` (or `undefined`).
     */
    async countByCategory(category) {
        return await this.getAsync(
            `SELECT COUNT(*) as count FROM items WHERE category = ? AND is_active = 1`,
            [category]
        );
    }

    /**
     * List all active items of a given rarity (no ORDER BY in legacy SQL).
     */
    async listByRarity(rarity) {
        return await this.allAsync(
            `SELECT * FROM items WHERE rarity = ? AND is_active = 1`,
            [rarity]
        );
    }

    /**
     * Insert a new item row. Mirrors the legacy `ItemService.createItem`
     * INSERT byte-for-byte (15 columns, 15 placeholders) so callers see
     * identical behavior including the implicit default for `updated_at`.
     *
     * The legacy code accepted a single `itemData` object with these keys;
     * we preserve that shape (destructured at the callsite, passed in here
     * as named fields).
     *
     * @param {object} fields
     * @returns {Promise<{ id: number, changes: number }>}
     */
    async create({
        name,
        display_name,
        emoji,
        description,
        item_type,
        category,
        rarity,
        base_price,
        is_purchasable,
        is_active,
        cooldown_seconds,
        max_stack,
        duration_seconds,
        effect_data,
        stack_behavior
    }) {
        return await this.runAsync(
            `INSERT INTO items (
                name, display_name, emoji, description, item_type, category,
                rarity, base_price, is_purchasable, is_active,
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name, display_name, emoji, description, item_type, category,
                rarity, base_price, is_purchasable, is_active,
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            ]
        );
    }

    /**
     * Generic dynamic update by primary key. Builds
     * `UPDATE items SET ... , updated_at = CURRENT_TIMESTAMP WHERE id = ?`
     * from the provided field map.
     *
     * Keys in `fields` are used as raw SQL column names — callers MUST pass
     * a controlled, known set (the legacy ItemService.updateItem used an
     * explicit `allowedFields` allowlist; that allowlist remains the
     * caller's responsibility). We defense-in-depth reject anything that
     * doesn't look like a plain SQL identifier so a future caller can't
     * accidentally interpolate user input as a column name.
     *
     * Mirrors the legacy SQL: always stamps `updated_at = CURRENT_TIMESTAMP`.
     *
     * Returns the underlying runAsync result ({ id, changes }).
     */
    async update(id, fields) {
        const keys = Object.keys(fields);
        for (const key of keys) {
            if (!/^[a-z_][a-z0-9_]*$/i.test(key)) {
                throw new Error(`ItemRepository.update: invalid column name '${key}'`);
            }
        }
        if (keys.length === 0) {
            return { id: 0, changes: 0 };
        }

        const setClauses = keys.map((k) => `${k} = ?`);
        const values = keys.map((k) => fields[k]);
        values.push(id);

        const sql = `UPDATE items SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        return await this.runAsync(sql, values);
    }

    /**
     * Soft-delete: flip `is_active = 0` and stamp `updated_at`.
     * Mirrors the legacy `ItemService.deleteItem` SQL byte-for-byte.
     */
    async softDelete(id) {
        return await this.runAsync(
            `UPDATE items SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [id]
        );
    }
}

module.exports = ItemRepository;
