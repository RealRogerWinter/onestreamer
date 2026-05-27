const UserInventoryRepository = require('../../../database/repository/UserInventoryRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new UserInventoryRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('UserInventoryRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
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
    // Read queries (JOIN items)
    // ============================================================

    describe('findInventoryWithItemsForUser', () => {
        it('JOINs user_inventory + items, excludes empty rows and inactive items, orders rarity DESC then name', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ inventory_id: 1, quantity: 2, name: 'pizza' }]);

            const rows = await repo.findInventoryWithItemsForUser(42);

            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT ui.id as inventory_id, ui.item_id, ui.quantity, ui.acquired_at, ui.last_used_at, ' +
                'i.name, i.display_name, i.emoji, i.description, i.item_type, i.category, i.rarity, ' +
                'i.cooldown_seconds, i.max_stack ' +
                'FROM user_inventory ui JOIN items i ON ui.item_id = i.id ' +
                'WHERE ui.user_id = ? AND ui.quantity > 0 AND i.is_active = 1 ' +
                'ORDER BY i.rarity DESC, i.name'
            );
            expect(params).toEqual([42]);
            expect(rows).toEqual([{ inventory_id: 1, quantity: 2, name: 'pizza' }]);
        });
    });

    describe('findInventoryItem', () => {
        it('SELECTs ui.* + JOIN items for a single (user, item) pair', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 5, quantity: 3, max_stack: 10 });

            const row = await repo.findInventoryItem(7, 3);

            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT ui.*, i.name, i.display_name, i.emoji, i.cooldown_seconds, i.max_stack ' +
                'FROM user_inventory ui JOIN items i ON ui.item_id = i.id ' +
                'WHERE ui.user_id = ? AND ui.item_id = ?'
            );
            expect(params).toEqual([7, 3]);
            expect(row).toEqual({ id: 5, quantity: 3, max_stack: 10 });
        });

        it('returns whatever getAsync returns on no-match (undefined)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue(undefined);

            const row = await repo.findInventoryItem(7, 999);
            expect(row).toBeUndefined();
        });
    });

    describe('aggregateValueForUser', () => {
        it('SUMs quantity × base_price, COUNTs distinct items, SUMs quantities — quantity > 0 only', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ total_value: 350, unique_items: 4, total_items: 12 });

            const row = await repo.aggregateValueForUser(42);

            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT SUM(ui.quantity * i.base_price) as total_value, ' +
                'COUNT(DISTINCT ui.item_id) as unique_items, ' +
                'SUM(ui.quantity) as total_items ' +
                'FROM user_inventory ui JOIN items i ON ui.item_id = i.id ' +
                'WHERE ui.user_id = ? AND ui.quantity > 0'
            );
            expect(params).toEqual([42]);
            expect(row).toEqual({ total_value: 350, unique_items: 4, total_items: 12 });
        });
    });

    describe('aggregateByRarity', () => {
        it('GROUPs by i.rarity, ORDERs legendary → epic → rare → uncommon → common via CASE', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ rarity: 'legendary', item_count: 1, total_quantity: 1 }]);

            const rows = await repo.aggregateByRarity(42);

            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT i.rarity, COUNT(DISTINCT ui.item_id) as item_count, ' +
                'SUM(ui.quantity) as total_quantity ' +
                'FROM user_inventory ui JOIN items i ON ui.item_id = i.id ' +
                'WHERE ui.user_id = ? AND ui.quantity > 0 ' +
                'GROUP BY i.rarity ' +
                "ORDER BY CASE i.rarity WHEN 'legendary' THEN 1 WHEN 'epic' THEN 2 WHEN 'rare' THEN 3 " +
                "WHEN 'uncommon' THEN 4 WHEN 'common' THEN 5 END"
            );
            expect(params).toEqual([42]);
            expect(rows).toEqual([{ rarity: 'legendary', item_count: 1, total_quantity: 1 }]);
        });
    });

    describe('findRecentlyUsed', () => {
        it('SELECTs last-used rows with LIMIT, excludes never-used (last_used_at IS NOT NULL)', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ item_id: 1, last_used_at: '2026-05-27' }]);

            const rows = await repo.findRecentlyUsed(42, 5);

            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT ui.item_id, ui.last_used_at, i.name, i.display_name, i.emoji, i.item_type ' +
                'FROM user_inventory ui JOIN items i ON ui.item_id = i.id ' +
                'WHERE ui.user_id = ? AND ui.last_used_at IS NOT NULL ' +
                'ORDER BY ui.last_used_at DESC LIMIT ?'
            );
            expect(params).toEqual([42, 5]);
            expect(rows).toEqual([{ item_id: 1, last_used_at: '2026-05-27' }]);
        });

        it('threads the limit param through unchanged', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);

            await repo.findRecentlyUsed(7, 1);
            const [, params] = allAsync.mock.calls[0];
            expect(params).toEqual([7, 1]);
        });
    });

    // ============================================================
    // Write queries (user_inventory only — no item_transactions)
    // ============================================================

    describe('insertItem', () => {
        it('INSERTs (user_id, item_id, quantity)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 42, changes: 1 });

            const result = await repo.insertItem(7, 3, 5);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)');
            expect(params).toEqual([7, 3, 5]);
            expect(result).toEqual({ id: 42, changes: 1 });
        });
    });

    describe('updateQuantity', () => {
        it('UPDATEs quantity by (user_id, item_id) — params ordered quantity-first, matching the SET clause', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.updateQuantity(7, 3, 99);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('UPDATE user_inventory SET quantity = ? WHERE user_id = ? AND item_id = ?');
            // quantity (SET value) first, then user_id, then item_id — matching the
            // SQL placeholder order, not the human-facing arg order.
            expect(params).toEqual([99, 7, 3]);
        });
    });

    describe('markUsed', () => {
        it('UPDATEs last_used_at to CURRENT_TIMESTAMP for a (user, item) row', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.markUsed(7, 3);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE user_inventory SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND item_id = ?'
            );
            expect(params).toEqual([7, 3]);
        });
    });

    describe('deleteItem', () => {
        it('DELETEs the (user, item) row', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.deleteItem(7, 3);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?');
            expect(params).toEqual([7, 3]);
        });
    });

    describe('deleteAllForUser', () => {
        it('DELETEs every row for a user', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 4 });

            await repo.deleteAllForUser(42);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM user_inventory WHERE user_id = ?');
            expect(params).toEqual([42]);
        });
    });

    // ============================================================
    // Constructor wiring
    // ============================================================

    describe('constructor', () => {
        it('falls back to the module-level primitives when deps omitted', () => {
            const repo = new UserInventoryRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('honors injected primitives when supplied', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new UserInventoryRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
