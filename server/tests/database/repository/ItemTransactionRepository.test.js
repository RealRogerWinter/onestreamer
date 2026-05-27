const ItemTransactionRepository = require('../../../database/repository/ItemTransactionRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new ItemTransactionRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('ItemTransactionRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
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
    // Inserts (one per transaction_type)
    // ============================================================

    describe('insertPurchase', () => {
        it("INSERTs with transaction_type='purchase' baked in, all eight columns populated", async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 17, changes: 1 });

            const result = await repo.insertPurchase({
                userId: 7,
                itemId: 3,
                quantity: 2,
                pricePerItem: 100,
                totalCost: 200,
                pointsBefore: 500,
                pointsAfter: 300,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO item_transactions ' +
                '(user_id, item_id, transaction_type, quantity, price_per_item, total_cost, points_before, points_after) ' +
                "VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?)"
            );
            expect(params).toEqual([7, 3, 2, 100, 200, 500, 300]);
            expect(result).toEqual({ id: 17, changes: 1 });
        });
    });

    describe('insertSell', () => {
        it("INSERTs with transaction_type='sell' baked in", async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 18, changes: 1 });

            await repo.insertSell({
                userId: 7,
                itemId: 3,
                quantity: 1,
                pricePerItem: 50,
                totalCost: 50,
                pointsBefore: 300,
                pointsAfter: 350,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO item_transactions ' +
                '(user_id, item_id, transaction_type, quantity, price_per_item, total_cost, points_before, points_after) ' +
                "VALUES (?, ?, 'sell', ?, ?, ?, ?, ?)"
            );
            expect(params).toEqual([7, 3, 1, 50, 50, 300, 350]);
        });
    });

    describe('insertAdminGrant', () => {
        it("INSERTs six columns with transaction_type='admin_grant' + price_per_item=0 + total_cost=0 baked in", async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 19, changes: 1 });

            await repo.insertAdminGrant({
                userId: 7,
                itemId: 3,
                quantity: 5,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO item_transactions ' +
                '(user_id, item_id, transaction_type, quantity, price_per_item, total_cost) ' +
                "VALUES (?, ?, 'admin_grant', ?, 0, 0)"
            );
            expect(params).toEqual([7, 3, 5]);
        });
    });

    // ============================================================
    // Selects
    // ============================================================

    describe('findHistoryForUser', () => {
        it('SELECTs it.* + item display columns, ORDER BY created_at DESC, LIMIT bound', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1, transaction_type: 'purchase' }]);

            const rows = await repo.findHistoryForUser(7, 20);

            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT it.*, i.name, i.display_name, i.emoji ' +
                'FROM item_transactions it ' +
                'JOIN items i ON it.item_id = i.id ' +
                'WHERE it.user_id = ? ' +
                'ORDER BY it.created_at DESC ' +
                'LIMIT ?'
            );
            expect(params).toEqual([7, 20]);
            expect(rows).toEqual([{ id: 1, transaction_type: 'purchase' }]);
        });
    });

    describe('aggregateForShop', () => {
        it("SELECTs unique_buyers + total_transactions + revenue/buyback split by CASE, filtered to purchase+sell", async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ unique_buyers: 10, total_transactions: 25, total_revenue: 2500, total_buyback: 100 });

            const row = await repo.aggregateForShop();

            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT COUNT(DISTINCT user_id) as unique_buyers, ' +
                'COUNT(*) as total_transactions, ' +
                "SUM(CASE WHEN transaction_type = 'purchase' THEN total_cost ELSE 0 END) as total_revenue, " +
                "SUM(CASE WHEN transaction_type = 'sell' THEN total_cost ELSE 0 END) as total_buyback " +
                'FROM item_transactions ' +
                "WHERE transaction_type IN ('purchase', 'sell')"
            );
            expect(params).toBeUndefined();
            expect(row).toEqual({ unique_buyers: 10, total_transactions: 25, total_revenue: 2500, total_buyback: 100 });
        });
    });

    describe('findPopularItems', () => {
        it('SELECTs purchase-only top-N by GROUP BY item_id + LIMIT', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ display_name: 'Pizza', emoji: '🍕', purchase_count: 4, total_quantity: 6 }]);

            const rows = await repo.findPopularItems(10);

            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT i.display_name, i.emoji, COUNT(*) as purchase_count, ' +
                'SUM(it.quantity) as total_quantity ' +
                'FROM item_transactions it ' +
                'JOIN items i ON it.item_id = i.id ' +
                "WHERE it.transaction_type = 'purchase' " +
                'GROUP BY it.item_id ' +
                'ORDER BY purchase_count DESC ' +
                'LIMIT ?'
            );
            expect(params).toEqual([10]);
            expect(rows).toEqual([{ display_name: 'Pizza', emoji: '🍕', purchase_count: 4, total_quantity: 6 }]);
        });
    });

    // ============================================================
    // Constructor wiring
    // ============================================================

    describe('constructor', () => {
        it('falls back to the module-level primitives when deps omitted', () => {
            const repo = new ItemTransactionRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('honors injected primitives when supplied', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new ItemTransactionRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
