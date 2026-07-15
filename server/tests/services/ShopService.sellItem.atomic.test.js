/**
 * sellItem atomicity (ADR-0029, audit E3).
 *
 * Pre-refactor, sellItem did remove → addPoints → insertSell as three bare
 * sequential writes: a failure after the remove destroyed the items without
 * paying. Now the three writes share one withTransaction scope, and a
 * zero-earnings sell (base_price 0/1 floors to 0) is rejected BEFORE any
 * mutation.
 *
 * Same harness as ShopService.purchaseItem.atomic.test.js: real in-memory
 * connection, both backends, real repos + InventoryService, stub
 * AccountService honoring the per-call tx handle.
 */

const sqlite3 = require('sqlite3').verbose();
const { createBetterSqlite3Adapter } = require('../../database/database-better');
const { createWithTransaction } = require('../../database/transaction');

const UserRepository = require('../../database/repository/UserRepository');
const ShopRepository = require('../../database/repository/ShopRepository');
const ItemTransactionRepository = require('../../database/repository/ItemTransactionRepository');
const UserInventoryRepository = require('../../database/repository/UserInventoryRepository');

const InventoryService = require('../../services/InventoryService');
const ShopService = require('../../services/ShopService');

function makeSqlite3Primitives() {
    const db = new sqlite3.Database(':memory:');
    const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
    const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
    const allAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    return { db, runAsync, getAsync, allAsync, close: () => new Promise((r) => db.close(r)) };
}

function makeBetterPrimitives() {
    const adapter = createBetterSqlite3Adapter(':memory:');
    return {
        db: adapter.db,
        runAsync: adapter.runAsync,
        getAsync: adapter.getAsync,
        allAsync: adapter.allAsync,
        close: () => { adapter.close(); return Promise.resolve(); },
    };
}

async function bootstrapSchema(primitives) {
    await primitives.runAsync(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            username TEXT UNIQUE NOT NULL
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE user_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            points_balance INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            emoji TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            item_type TEXT NOT NULL DEFAULT 'buff',
            category TEXT,
            rarity TEXT NOT NULL DEFAULT 'common',
            base_price INTEGER NOT NULL DEFAULT 0,
            is_purchasable BOOLEAN DEFAULT 1,
            is_active BOOLEAN DEFAULT 1,
            is_tradeable BOOLEAN DEFAULT 1,
            cooldown_seconds INTEGER DEFAULT 0,
            max_stack INTEGER DEFAULT 0
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE user_inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0,
            acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME,
            UNIQUE(user_id, item_id)
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE item_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            transaction_type TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            price_per_item INTEGER,
            total_cost INTEGER,
            points_before INTEGER,
            points_after INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await primitives.runAsync(
        "INSERT INTO users (id, email, username) VALUES (42, 't@e.com', 'tester')");
    await primitives.runAsync(
        'INSERT INTO user_stats (user_id, points_balance) VALUES (42, 1000)');
    await primitives.runAsync(
        `INSERT INTO items (id, name, display_name, base_price) VALUES (7, 'pizza', 'Pizza', 100)`);
    await primitives.runAsync(
        `INSERT INTO items (id, name, display_name, base_price) VALUES (8, 'crumb', 'Crumb', 1)`); // floor(0.5)=0
    await primitives.runAsync(
        'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (42, 7, 5)');
    await primitives.runAsync(
        'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (42, 8, 3)');
}

function makeServices(primitives) {
    const repoDeps = {
        getAsync: primitives.getAsync,
        runAsync: primitives.runAsync,
        allAsync: primitives.allAsync,
    };
    const itemService = {
        async getItemById(id) {
            return await primitives.getAsync('SELECT * FROM items WHERE id = ?', [id]);
        },
        async getAllItems() { return await primitives.allAsync('SELECT * FROM items'); },
    };
    const accountService = {
        async getPointsBalance(userId) {
            const row = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [userId]);
            return row?.points_balance || 0;
        },
        async addPoints(userId, amount, type, description, metadata, tx = null) {
            const getAsync = tx ? tx.getAsync : repoDeps.getAsync;
            const updated = await getAsync(
                `UPDATE user_stats
                    SET points_balance = points_balance + ?, updated_at = CURRENT_TIMESTAMP
                  WHERE user_id = ?
              RETURNING points_balance`,
                [amount, userId]
            );
            return updated.points_balance;
        },
    };
    const inventoryService = new InventoryService(itemService, null, {
        userInventoryRepository: new UserInventoryRepository(repoDeps),
        itemTransactionRepository: new ItemTransactionRepository(repoDeps),
    });
    const shopService = new ShopService(itemService, inventoryService, accountService, null, {
        userRepository: new UserRepository(repoDeps),
        shopRepository: new ShopRepository(repoDeps),
        itemTransactionRepository: new ItemTransactionRepository(repoDeps),
        withTransaction: createWithTransaction(repoDeps),
    });
    return { shopService };
}

describe.each([
    { flag: 'true', make: makeBetterPrimitives },
    { flag: 'false', make: makeSqlite3Primitives },
])('ShopService.sellItem atomicity (USE_BETTER_SQLITE3=$flag)', ({ flag, make }) => {
    let savedFlag;
    let primitives;
    let services;
    let originalConsoleError;

    beforeAll(() => {
        savedFlag = process.env.USE_BETTER_SQLITE3;
        process.env.USE_BETTER_SQLITE3 = flag;
    });
    afterAll(() => {
        if (savedFlag === undefined) delete process.env.USE_BETTER_SQLITE3;
        else process.env.USE_BETTER_SQLITE3 = savedFlag;
    });

    beforeEach(async () => {
        primitives = make();
        await bootstrapSchema(primitives);
        originalConsoleError = console.error;
        console.error = jest.fn();
        services = makeServices(primitives);
        await services.shopService.initializeShop();
    });

    afterEach(async () => {
        console.error = originalConsoleError;
        await primitives.close();
    });

    it('happy path: removes items, credits points, writes the sell audit row — all committed together', async () => {
        const result = await services.shopService.sellItem(42, 7, 2);

        expect(result.success).toBe(true);
        expect(result.totalEarnings).toBe(100); // 2 × floor(100·0.5)
        expect(result.remainingPoints).toBe(1100);

        const inv = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 42 AND item_id = 7');
        expect(inv.quantity).toBe(3);

        const bal = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = 42');
        expect(bal.points_balance).toBe(1100);

        const rows = await primitives.allAsync(
            "SELECT * FROM item_transactions WHERE user_id = 42 AND transaction_type = 'sell'");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            item_id: 7, quantity: 2, price_per_item: 50, total_cost: 100,
            points_before: 1000, points_after: 1100,
        });
    });

    it('crash injection: audit-write failure rolls back the remove AND the credit (items retained, no points)', async () => {
        const insertSpy = jest.spyOn(ItemTransactionRepository.prototype, 'insertSell')
            .mockRejectedValue(new Error('simulated audit-write failure'));

        await expect(services.shopService.sellItem(42, 7, 2)).rejects.toThrow('simulated audit-write failure');

        const inv = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 42 AND item_id = 7');
        expect(inv.quantity).toBe(5); // items NOT removed

        const bal = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = 42');
        expect(bal.points_balance).toBe(1000); // points NOT credited

        insertSpy.mockRestore();
    });

    it('rejects a zero-earnings sell BEFORE any mutation (audit E3 guard)', async () => {
        await expect(services.shopService.sellItem(42, 8, 3)).rejects.toThrow('Item has no resale value');

        const inv = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 42 AND item_id = 8');
        expect(inv.quantity).toBe(3); // items retained

        const rows = await primitives.allAsync(
            "SELECT * FROM item_transactions WHERE user_id = 42 AND transaction_type = 'sell'");
        expect(rows).toEqual([]);
    });

    it('rejects an over-quantity sell with no side effects', async () => {
        await expect(services.shopService.sellItem(42, 7, 50)).rejects.toThrow('Insufficient items to sell');
        const inv = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 42 AND item_id = 7');
        expect(inv.quantity).toBe(5);
    });
});
