/**
 * Integration test for the PR 7.4 atomic purchaseItem refactor.
 *
 * Unlike the repository-level tests (which mock DB primitives and assert
 * SQL text), this file exercises the full money-flow under a real
 * `withTransaction` scope against a real in-memory connection. It is
 * the proof that the atomic guarantee in CHANGELOG.md and ADR-0015
 * survives contact with actual SQL.
 *
 * Test scenarios:
 *   - Happy path: purchase commits — points debited exactly once,
 *     inventory row inserted, audit row written, stock decremented.
 *   - Rollback on body throw: simulated I/O failure on
 *     `decrementStockLimit` mid-tx → points NOT debited, inventory
 *     NOT credited, audit row NOT written. The "user paid for nothing"
 *     hazard from the Phase 7 roadmap.
 *   - Pre-tx failure (`Insufficient points`) — atomic guard inside
 *     subtractPoints surfaces as the same user-visible error even
 *     after a stale balance read; no inventory/audit side effects.
 *
 * Runs under both backends (`USE_BETTER_SQLITE3=true | false`) per the
 * test-env-flag matrix. The `withTransaction` helper is constructed
 * fresh per-test against the local in-memory primitives so we don't
 * collide with the module-level singleton in `database.js`.
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
    // points_transactions exists so the real AccountService (when used) can
    // INSERT its own audit row inside the same tx. The stub AccountService
    // path doesn't touch it but creating it costs nothing.
    await primitives.runAsync(`
        CREATE TABLE points_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            transaction_type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            description TEXT,
            metadata TEXT,
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

function makeServices(primitives) {
    const repoDeps = {
        getAsync: primitives.getAsync,
        runAsync: primitives.runAsync,
        allAsync: primitives.allAsync,
    };
    const userRepository = new UserRepository(repoDeps);
    const shopRepository = new ShopRepository(repoDeps);
    const itemTransactionRepository = new ItemTransactionRepository(repoDeps);
    const userInventoryRepository = new UserInventoryRepository(repoDeps);

    const itemService = {
        async getItemById(id) {
            return await primitives.getAsync('SELECT * FROM items WHERE id = ?', [id]);
        },
        async validateItemUsage() { return { valid: true }; },
        isBuffOrDebuffItem() { return false; },
        async applyItemCooldown() {},
        async getAllItems() { return await primitives.allAsync('SELECT * FROM items'); },
    };

    // Minimal AccountService stub that uses the test's primitives (so the
    // points UPDATE lands inside our withTransaction scope on the same
    // connection). Production AccountService captures the module-level
    // wrappers via destructuring at require time; the relevant property
    // here is "uses the same primitives the helper is constructed with".
    const accountService = {
        async getPointsBalance(userId) {
            const row = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?',
                [userId]
            );
            return row?.points_balance || 0;
        },
        async subtractPoints(userId, amount) {
            const updated = await primitives.getAsync(
                `UPDATE user_stats
                    SET points_balance = points_balance - ?,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE user_id = ? AND points_balance >= ?
              RETURNING points_balance`,
                [amount, userId, amount]
            );
            if (!updated) {
                throw new Error('Insufficient points balance');
            }
            return updated.points_balance;
        },
    };

    const inventoryService = new InventoryService(itemService, null, {
        userInventoryRepository,
        itemTransactionRepository,
    });

    // Build withTransaction bound to THESE primitives — not the module
    // singleton in database.js (which is bound to the real DB handle).
    const withTransaction = createWithTransaction(repoDeps);

    const shopService = new ShopService(itemService, inventoryService, accountService, null, {
        userRepository,
        shopRepository,
        itemTransactionRepository,
        withTransaction,
    });

    return { shopService, shopRepository, itemTransactionRepository, userInventoryRepository, accountService };
}

describe.each([
    { flag: 'true', make: makeBetterPrimitives },
    { flag: 'false', make: makeSqlite3Primitives },
])('ShopService.purchaseItem atomicity (USE_BETTER_SQLITE3=$flag)', ({ flag, make }) => {
    let savedFlag;
    let primitives;
    let services;

    beforeAll(() => {
        savedFlag = process.env.USE_BETTER_SQLITE3;
        process.env.USE_BETTER_SQLITE3 = flag;
    });
    afterAll(() => {
        if (savedFlag === undefined) delete process.env.USE_BETTER_SQLITE3;
        else process.env.USE_BETTER_SQLITE3 = savedFlag;
    });

    let originalConsoleError;
    beforeEach(async () => {
        primitives = make();
        await bootstrapSchema(primitives);
        // ShopService.initializeShop() fires from the constructor and isn't
        // awaitable from the outside. Suppress any stray console.error during
        // its async fire-and-forget, then explicitly invoke it once more — it's
        // idempotent (early-returns when shop_items already has rows) and
        // gives us a deterministic await point.
        originalConsoleError = console.error;
        console.error = jest.fn();
        services = makeServices(primitives);
        await services.shopService.initializeShop();
    });

    afterEach(async () => {
        console.error = originalConsoleError;
        await primitives.close();
    });

    describe('happy path', () => {
        it('debits points, credits inventory, writes audit row, decrements stock — all visible after commit', async () => {
            const result = await services.shopService.purchaseItem(42, 7, 2);

            expect(result.success).toBe(true);
            expect(result.totalCost).toBe(200);
            expect(result.remainingPoints).toBe(800);

            const balanceRow = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balanceRow.points_balance).toBe(800);

            const invRow = await primitives.getAsync(
                'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
            expect(invRow.quantity).toBe(2);

            const txRows = await primitives.allAsync(
                'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
            expect(txRows).toHaveLength(1);
            expect(txRows[0]).toMatchObject({
                user_id: 42,
                item_id: 7,
                transaction_type: 'purchase',
                quantity: 2,
                price_per_item: 100,
                total_cost: 200,
                points_before: 1000,
                points_after: 800,
            });

            const stockRow = await primitives.getAsync(
                'SELECT stock_limit FROM shop_items WHERE id = ?', [1]);
            expect(stockRow.stock_limit).toBe(8);
        });
    });

    describe('rollback', () => {
        it('rolls back EVERYTHING when a body statement throws mid-tx — points NOT debited, inventory NOT credited, audit NOT written', async () => {
            // Inject a failing decrementStockLimit AFTER inventory + audit
            // have already written, simulating the worst-case mid-tx
            // failure (last statement of the tx body).
            const originalDecrement = services.shopRepository.decrementStockLimit.bind(services.shopRepository);
            services.shopRepository.decrementStockLimit = jest.fn(async () => {
                throw new Error('simulated I/O failure on stock decrement');
            });

            await expect(services.shopService.purchaseItem(42, 7, 2)).rejects.toThrow('simulated I/O failure');

            // Everything must look exactly as it did before the call.
            const balanceRow = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balanceRow.points_balance).toBe(1000); // not debited

            const invRow = await primitives.getAsync(
                'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
            expect(invRow).toBeUndefined(); // no row

            const txRows = await primitives.allAsync(
                'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
            expect(txRows).toEqual([]); // no audit row

            const stockRow = await primitives.getAsync(
                'SELECT stock_limit FROM shop_items WHERE id = ?', [1]);
            expect(stockRow.stock_limit).toBe(10); // unchanged

            // restore for any subsequent tests in the block
            services.shopRepository.decrementStockLimit = originalDecrement;
        });

        it('rolls back when the audit-write step throws — points NOT debited, inventory NOT credited', async () => {
            const original = services.itemTransactionRepository.insertPurchase.bind(services.itemTransactionRepository);
            services.itemTransactionRepository.insertPurchase = jest.fn(async () => {
                throw new Error('simulated audit-write failure');
            });

            await expect(services.shopService.purchaseItem(42, 7, 1)).rejects.toThrow('simulated audit-write failure');

            const balanceRow = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balanceRow.points_balance).toBe(1000);

            const invRow = await primitives.getAsync(
                'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
            expect(invRow).toBeUndefined();

            services.itemTransactionRepository.insertPurchase = original;
        });
    });

    describe('pre-tx guards', () => {
        it('rejects insufficient-balance purchases without opening a tx (no side effects)', async () => {
            await expect(services.shopService.purchaseItem(42, 7, 100)).rejects.toThrow('Insufficient points');

            const balanceRow = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balanceRow.points_balance).toBe(1000);

            const txRows = await primitives.allAsync(
                'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
            expect(txRows).toEqual([]);
        });

        it('rejects max-stack overflow purchases without opening a tx', async () => {
            // First fill up to 4/5
            await services.shopService.purchaseItem(42, 7, 4);

            // Now trying to buy 2 more would exceed max_stack=5
            await expect(services.shopService.purchaseItem(42, 7, 2)).rejects.toThrow('Cannot exceed maximum stack');

            // The first purchase's side effects survive; the second leaves no trace.
            const invRow = await primitives.getAsync(
                'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
            expect(invRow.quantity).toBe(4);

            const txRows = await primitives.allAsync(
                'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
            expect(txRows).toHaveLength(1); // only the first purchase's audit row
        });
    });

    describe('intra-tx guards (race protection)', () => {
        it('rolls back when the guarded stock decrement returns no row (concurrent purchase consumed the last unit)', async () => {
            // Simulate the race: the pre-tx stock check sees enough stock,
            // but between then and our decrement another purchase has cleaned
            // the shelf. Stub decrementStockLimit to return undefined.
            const original = services.shopRepository.decrementStockLimit.bind(services.shopRepository);
            services.shopRepository.decrementStockLimit = jest.fn(async () => undefined);

            await expect(services.shopService.purchaseItem(42, 7, 1)).rejects.toThrow('Insufficient stock');

            // Points NOT debited; no inventory row; no audit row.
            const balanceRow = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balanceRow.points_balance).toBe(1000);

            const invRow = await primitives.getAsync(
                'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
            expect(invRow).toBeUndefined();

            const txRows = await primitives.allAsync(
                'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
            expect(txRows).toEqual([]);

            services.shopRepository.decrementStockLimit = original;
        });

        it('rolls back when the inside-tx max-stack re-check fails (concurrent credit pushed inventory past cap)', async () => {
            // Pre-tx: user has 0/5. Concurrent credit happens between the
            // pre-check and the tx body's re-check — simulate by mocking
            // getInventoryItem (the InventoryService method) to return 4
            // when called from inside the tx but not when called by the
            // pre-check. Easier: just credit the user directly via the
            // primitives before the call.
            await primitives.runAsync(
                'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)',
                [42, 7, 4]
            );

            // Pre-tx check (run inside the service) sees 4 already, so a
            // qty=2 purchase would trip the *pre-tx* guard. To force the
            // intra-tx path, sneak the inventory in AFTER the pre-check by
            // making getInventoryItem return 0 the first time (pre-check)
            // and the real value (4) the second time (intra-tx).
            const originalFind = services.userInventoryRepository.findInventoryItem.bind(services.userInventoryRepository);
            let callCount = 0;
            services.userInventoryRepository.findInventoryItem = jest.fn(async (...args) => {
                callCount++;
                if (callCount === 1) return undefined; // pre-check sees nothing
                return await originalFind(...args);
            });

            await expect(services.shopService.purchaseItem(42, 7, 2)).rejects.toThrow('Cannot exceed maximum stack');

            const balanceRow = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balanceRow.points_balance).toBe(1000); // not debited

            const txRows = await primitives.allAsync(
                'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
            expect(txRows).toEqual([]); // no audit row written

            services.userInventoryRepository.findInventoryItem = originalFind;
        });
    });
});
