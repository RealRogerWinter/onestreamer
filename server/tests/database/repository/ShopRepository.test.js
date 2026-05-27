const ShopRepository = require('../../../database/repository/ShopRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new ShopRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('ShopRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
    let savedFlag;
    beforeAll(() => {
        savedFlag = process.env.USE_BETTER_SQLITE3;
        process.env.USE_BETTER_SQLITE3 = flag;
    });
    afterAll(() => {
        if (savedFlag === undefined) delete process.env.USE_BETTER_SQLITE3;
        else process.env.USE_BETTER_SQLITE3 = savedFlag;
    });

    // ============================================================
    // Customer-facing
    // ============================================================

    describe('findActiveItemsForCustomer', () => {
        it('JOINs shop_items + items, filters availability windows, ORDERs featured DESC / rarity DESC / name', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ shop_id: 1, price: 100 }]);

            const rows = await repo.findActiveItemsForCustomer();

            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT si.id as shop_id, si.price, si.discount_percentage, si.is_featured, ' +
                'si.stock_limit, si.available_from, si.available_until, ' +
                'i.id as item_id, i.name, i.display_name, i.emoji, i.description, ' +
                'i.item_type, i.category, i.rarity, i.cooldown_seconds, i.max_stack ' +
                'FROM shop_items si JOIN items i ON si.item_id = i.id ' +
                'WHERE i.is_active = 1 AND i.is_purchasable = 1 ' +
                "AND (si.available_from IS NULL OR datetime(si.available_from) <= datetime('now')) " +
                "AND (si.available_until IS NULL OR datetime(si.available_until) > datetime('now')) " +
                'ORDER BY si.is_featured DESC, i.rarity DESC, i.name'
            );
            expect(params).toBeUndefined();
            expect(rows).toEqual([{ shop_id: 1, price: 100 }]);
        });
    });

    // ============================================================
    // Admin-facing
    // ============================================================

    describe('findAllItemsForAdmin', () => {
        it('JOINs shop_items + items without filters, aliases shop_item_id and stock', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ shop_item_id: 1, stock: 5 }]);

            const rows = await repo.findAllItemsForAdmin();

            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT si.id as shop_item_id, si.price, si.discount_percentage, si.is_featured, ' +
                'si.stock_limit as stock, si.available_from, si.available_until, ' +
                'i.id as item_id, i.name, i.display_name, i.emoji, i.description, ' +
                'i.item_type, i.category, i.rarity, i.cooldown_seconds, i.max_stack ' +
                'FROM shop_items si JOIN items i ON si.item_id = i.id ' +
                'ORDER BY si.is_featured DESC, i.rarity DESC, i.name'
            );
            expect(rows).toEqual([{ shop_item_id: 1, stock: 5 }]);
        });
    });

    // ============================================================
    // Single-row lookups
    // ============================================================

    describe('findShopItemIdByItemId', () => {
        it('SELECTs the shop_items.id by item_id (used as existence check)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 42 });

            const row = await repo.findShopItemIdByItemId(7);

            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT id FROM shop_items WHERE item_id = ?');
            expect(params).toEqual([7]);
            expect(row).toEqual({ id: 42 });
        });

        it('returns whatever getAsync returns on no-match (undefined)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue(undefined);

            const row = await repo.findShopItemIdByItemId(999);
            expect(row).toBeUndefined();
        });
    });

    describe('findItemForPurchase', () => {
        it('SELECTs si.* + max_stack + display_name, filters is_purchasable=1', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 1, price: 100, max_stack: 5, display_name: 'Pizza' });

            const row = await repo.findItemForPurchase(3);

            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT si.*, i.max_stack, i.display_name ' +
                'FROM shop_items si JOIN items i ON si.item_id = i.id ' +
                'WHERE si.item_id = ? AND i.is_purchasable = 1'
            );
            expect(params).toEqual([3]);
            expect(row).toEqual({ id: 1, price: 100, max_stack: 5, display_name: 'Pizza' });
        });
    });

    // ============================================================
    // Sub-views
    // ============================================================

    describe('findFeaturedItems', () => {
        it('SELECTs si.* + item display, filters is_featured=1 + is_active=1, ORDER rarity DESC', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1, rarity: 'legendary' }]);

            const rows = await repo.findFeaturedItems();

            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT si.*, i.name, i.display_name, i.emoji, i.description, i.rarity ' +
                'FROM shop_items si JOIN items i ON si.item_id = i.id ' +
                'WHERE si.is_featured = 1 AND i.is_active = 1 ' +
                'ORDER BY i.rarity DESC'
            );
            expect(rows).toEqual([{ id: 1, rarity: 'legendary' }]);
        });
    });

    describe('findDiscountedItems', () => {
        it('SELECTs si.* + item display, filters discount_percentage>0 + is_active=1, ORDER discount DESC', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1, discount_percentage: 50 }]);

            const rows = await repo.findDiscountedItems();

            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT si.*, i.name, i.display_name, i.emoji, i.description, i.rarity ' +
                'FROM shop_items si JOIN items i ON si.item_id = i.id ' +
                'WHERE si.discount_percentage > 0 AND i.is_active = 1 ' +
                'ORDER BY si.discount_percentage DESC'
            );
            expect(rows).toEqual([{ id: 1, discount_percentage: 50 }]);
        });
    });

    // ============================================================
    // Write methods (PR 7.4)
    // ============================================================

    describe('insertShopItem', () => {
        it('INSERTs the 7-column shape with bind-order item_id, price, discount_percentage, is_featured, stock_limit, available_from, available_until', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 99, changes: 1 });

            const result = await repo.insertShopItem({
                itemId: 3,
                price: 100,
                discountPercentage: 10,
                isFeatured: false,
                stockLimit: 0,
                availableFrom: null,
                availableUntil: null,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO shop_items ' +
                '(item_id, price, discount_percentage, is_featured, stock_limit, available_from, available_until) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            expect(params).toEqual([3, 100, 10, false, 0, null, null]);
            expect(result).toEqual({ id: 99, changes: 1 });
        });
    });

    describe('updateShopItemFields', () => {
        it('builds the SET clause dynamically from fields keys; appends shopItemId as last param', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.updateShopItemFields(42, { price: 150, discount_percentage: 20 });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('UPDATE shop_items SET price = ?, discount_percentage = ? WHERE id = ?');
            expect(params).toEqual([150, 20, 42]);
        });

        it('throws on empty fields object', async () => {
            const { repo } = makeRepo();
            await expect(repo.updateShopItemFields(42, {})).rejects.toThrow('no fields supplied');
        });

        it('throws on a field outside the allowlist (defense in depth)', async () => {
            const { repo, runAsync } = makeRepo();
            await expect(repo.updateShopItemFields(42, { totally_evil: 1 }))
                .rejects.toThrow('field not allowed: totally_evil');
            expect(runAsync).not.toHaveBeenCalled();
        });

        it('accepts every legacy-allowlisted field', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.updateShopItemFields(42, {
                price: 1,
                discount_percentage: 1,
                is_featured: 1,
                stock_limit: 1,
                available_from: null,
                available_until: null,
            });
            expect(runAsync).toHaveBeenCalledTimes(1);
        });
    });

    describe('deleteShopItemById', () => {
        it('DELETEs the row by id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.deleteShopItemById(42);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM shop_items WHERE id = ?');
            expect(params).toEqual([42]);
        });
    });

    describe('decrementStockLimit', () => {
        it('UPDATEs stock_limit -= ? with a guarded WHERE clause + RETURNING (ADR-0013a relative-arithmetic + guard)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ stock_limit: 7 });

            const after = await repo.decrementStockLimit(42, 3);

            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE shop_items SET stock_limit = stock_limit - ? WHERE id = ? AND stock_limit >= ? RETURNING stock_limit'
            );
            // bind order: decrement amount, row id, guard amount
            expect(params).toEqual([3, 42, 3]);
            expect(after).toEqual({ stock_limit: 7 });
        });

        it('returns undefined when the guard fails (no row updated; caller throws)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue(undefined);

            const after = await repo.decrementStockLimit(42, 999);
            expect(after).toBeUndefined();
        });
    });

    // ============================================================
    // Constructor wiring
    // ============================================================

    describe('constructor', () => {
        it('falls back to the module-level primitives when deps omitted', () => {
            const repo = new ShopRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('honors injected primitives when supplied', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new ShopRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
