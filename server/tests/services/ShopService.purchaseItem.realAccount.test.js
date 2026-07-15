/**
 * Real-AccountService integration test (PR 7.4).
 *
 * The companion file (`ShopService.purchaseItem.atomic.test.js`) uses a
 * stub AccountService bound to the test connection — it proves the
 * `withTransaction` mechanics work but DOES NOT prove the load-bearing
 * production assumption: that `AccountService`'s module-level
 * `runAsync` / `getAsync` (captured at require time) route through the
 * same connection the helper's `BEGIN IMMEDIATE` opened on.
 *
 * This file closes that gap. It uses `jest.mock('../../database/database')`
 * to redirect the module-level wrappers AND the `withTransaction` export
 * to a slot we populate per-test against an in-memory connection. A
 * REAL `AccountService` constructed against the mocked module ends up
 * running its UPDATE + INSERT against the same connection the helper
 * holds the writer lock on. When the body throws, ROLLBACK undoes both
 * AccountService's writes AND the surrounding inventory + audit writes.
 *
 * If you change AccountService.subtractPoints's SQL shape, the schema
 * fixture here will need a matching update.
 */

const sqlite3 = require('sqlite3').verbose();
const { createWithTransaction } = require('../../database/transaction');

// jest.mock is hoisted. Use a deferred-binding slot pattern: the mock
// exports getters/proxies that read from the slot at call time, so each
// test can swap in fresh in-memory primitives via the slot.
const dbSlot = {
    runAsync: null,
    getAsync: null,
    allAsync: null,
    withTransaction: null,
};

jest.mock('../../database/database', () => ({
    get db() { return null; },
    runAsync: (...args) => dbSlot.runAsync(...args),
    getAsync: (...args) => dbSlot.getAsync(...args),
    allAsync: (...args) => dbSlot.allAsync(...args),
    withTransaction: (...args) => dbSlot.withTransaction(...args),
    _betterAdapter: () => null,
}));

// Requires AFTER jest.mock so the mocked module is what they see.
const AccountService = require('../../services/AccountService');
const InventoryService = require('../../services/InventoryService');
const ShopService = require('../../services/ShopService');
const UserRepository = require('../../database/repository/UserRepository');
const ShopRepository = require('../../database/repository/ShopRepository');
const ItemTransactionRepository = require('../../database/repository/ItemTransactionRepository');
const UserInventoryRepository = require('../../database/repository/UserInventoryRepository');

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

async function bootstrapSchema(primitives) {
    // Mirrors the columns the production AccountService + ShopService touch.
    // If you add a column to either service's SQL, add it here too.
    await primitives.runAsync(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            username TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE user_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            total_stream_time INTEGER DEFAULT 0,
            total_view_time INTEGER DEFAULT 0,
            stream_count INTEGER DEFAULT 0,
            chat_message_count INTEGER DEFAULT 0,
            points_balance INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE points_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            type TEXT NOT NULL,
            description TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            emoji TEXT NOT NULL,
            description TEXT NOT NULL,
            item_type TEXT NOT NULL,
            category TEXT,
            rarity TEXT NOT NULL,
            base_price INTEGER NOT NULL DEFAULT 0,
            is_purchasable BOOLEAN DEFAULT 1,
            is_active BOOLEAN DEFAULT 1,
            cooldown_seconds INTEGER DEFAULT 0,
            max_stack INTEGER DEFAULT 0
        )
    `);
    await primitives.runAsync(`
        CREATE TABLE shop_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            price INTEGER NOT NULL,
            discount_percentage INTEGER DEFAULT 0,
            is_featured BOOLEAN DEFAULT 0,
            stock_limit INTEGER DEFAULT 0,
            available_from DATETIME,
            available_until DATETIME
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
        "INSERT INTO users (id, email, username) VALUES (?, ?, ?)",
        [42, 'tester@example.com', 'tester']
    );
    await primitives.runAsync(
        'INSERT INTO user_stats (user_id, points_balance) VALUES (?, ?)',
        [42, 1000]
    );
    await primitives.runAsync(
        `INSERT INTO items (id, name, display_name, emoji, description, item_type, rarity, base_price, max_stack)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [7, 'pizza', 'Pizza', '🍕', 'A slice of pizza', 'buff', 'common', 100, 5]
    );
    await primitives.runAsync(
        `INSERT INTO shop_items (id, item_id, price, discount_percentage, is_featured, stock_limit)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [1, 7, 100, 0, 0, 10]
    );
}

describe('ShopService.purchaseItem atomicity with REAL AccountService (USE_BETTER_SQLITE3=false)', () => {
    let primitives;
    let shopService;
    let shopRepository;
    let itemTransactionRepository;
    let userInventoryRepository;
    let originalConsoleLog;
    let originalConsoleError;

    beforeEach(async () => {
        primitives = makeSqlite3Primitives();
        await bootstrapSchema(primitives);

        // Populate the slot the mocked database.js delegates to.
        dbSlot.runAsync = primitives.runAsync;
        dbSlot.getAsync = primitives.getAsync;
        dbSlot.allAsync = primitives.allAsync;
        dbSlot.withTransaction = createWithTransaction({
            runAsync: primitives.runAsync,
            getAsync: primitives.getAsync,
            allAsync: primitives.allAsync,
        });

        // Real AccountService — it captures module-level wrappers at require
        // time, which through the mock become dbSlot proxies pointing at our
        // primitives. Construct WITHOUT an injected UserRepository so it
        // uses the default — which also picks up the mock.
        const accountService = new AccountService();

        const itemService = {
            async getItemById(id) { return await primitives.getAsync('SELECT * FROM items WHERE id = ?', [id]); },
            async validateItemUsage() { return { valid: true }; },
            isBuffOrDebuffItem() { return false; },
            async applyItemCooldown() {},
            async getAllItems() { return await primitives.allAsync('SELECT * FROM items'); },
        };

        shopRepository = new ShopRepository();
        itemTransactionRepository = new ItemTransactionRepository();
        userInventoryRepository = new UserInventoryRepository();
        const userRepository = new UserRepository();

        const inventoryService = new InventoryService(itemService, null, {
            userInventoryRepository,
            itemTransactionRepository,
        });

        originalConsoleLog = console.log;
        originalConsoleError = console.error;
        console.log = jest.fn();
        console.error = jest.fn();

        shopService = new ShopService(itemService, inventoryService, accountService, null, {
            userRepository,
            shopRepository,
            itemTransactionRepository,
        });
        await shopService.initializeShop();
    });

    afterEach(async () => {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        dbSlot.runAsync = null;
        dbSlot.getAsync = null;
        dbSlot.allAsync = null;
        dbSlot.withTransaction = null;
        await primitives.close();
    });

    it('happy path commits BOTH AccountService writes (UPDATE + audit row) and the inventory + item-tx writes', async () => {
        const result = await shopService.purchaseItem(42, 7, 2);
        expect(result.remainingPoints).toBe(800);

        // AccountService's UPDATE landed.
        const balanceRow = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
        expect(balanceRow.points_balance).toBe(800);

        // AccountService's audit-row INSERT landed in points_transactions.
        const ptxRows = await primitives.allAsync(
            'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
        expect(ptxRows).toHaveLength(1);
        expect(ptxRows[0]).toMatchObject({
            user_id: 42,
            amount: -200,
            balance_after: 800,
            type: 'purchase',
        });

        // ShopService's audit-row INSERT landed in item_transactions.
        const itxRows = await primitives.allAsync(
            'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
        expect(itxRows).toHaveLength(1);
        expect(itxRows[0]).toMatchObject({ total_cost: 200, points_before: 1000, points_after: 800 });
    });

    it('THE CRITICAL TEST — body throw after AccountService writes rolls back EVERYTHING, including the points_transactions INSERT', async () => {
        // Force a failure AFTER both AccountService writes have landed
        // (UPDATE user_stats + INSERT points_transactions) but BEFORE the
        // tx commits. The decrementStockLimit throw triggers ROLLBACK,
        // which must undo AccountService's writes too — proving the
        // module-level wrappers route through our open tx.
        // Prototype-level spy: purchaseItem builds a tx-scoped ShopRepository
        // inside the scope (ADR-0029), so instance-level mocks no longer
        // intercept the in-scope call.
        const decrementSpy = jest.spyOn(ShopRepository.prototype, 'decrementStockLimit')
            .mockRejectedValue(new Error('simulated I/O failure mid-tx'));

        await expect(shopService.purchaseItem(42, 7, 2)).rejects.toThrow('simulated I/O failure');

        // user_stats UPDATE rolled back: balance unchanged.
        const balanceRow = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
        expect(balanceRow.points_balance).toBe(1000);

        // points_transactions INSERT rolled back: no audit row.
        // THIS is what would NOT pass if AccountService's wrappers were
        // somehow not part of our tx (the precise hazard B1 flagged in
        // PR review).
        const ptxRows = await primitives.allAsync(
            'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
        expect(ptxRows).toEqual([]);

        // item_transactions INSERT rolled back: no audit row there either.
        const itxRows = await primitives.allAsync(
            'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
        expect(itxRows).toEqual([]);

        // user_inventory row rolled back.
        const invRow = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
        expect(invRow).toBeUndefined();

        decrementSpy.mockRestore();
    });
});
