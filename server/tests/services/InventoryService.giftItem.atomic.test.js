/**
 * giftItem / transferItem atomicity (ADR-0029, audit E3).
 *
 * Pre-refactor, giftItem did remove → add → audit-INSERT as three bare
 * sequential writes: a failure after the remove destroyed the sender's items
 * (or minted unaudited ones). Now all three share one withTransaction scope.
 *
 * Real in-memory connection, both backends, real repos — the fault is
 * injected at the repository prototype (tx-scoped repos, so instance mocks
 * wouldn't intercept).
 */

const sqlite3 = require('sqlite3').verbose();
const { createBetterSqlite3Adapter } = require('../../database/database-better');
const { createWithTransaction } = require('../../database/transaction');

const UserInventoryRepository = require('../../database/repository/UserInventoryRepository');
const ItemTransactionRepository = require('../../database/repository/ItemTransactionRepository');
const InventoryService = require('../../services/InventoryService');

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
        CREATE TABLE gift_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_user_id INTEGER NOT NULL,
            to_user_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            timestamp DATETIME
        )
    `);
    await primitives.runAsync(
        `INSERT INTO items (id, name, display_name, emoji, is_tradeable) VALUES (7, 'rose', 'Rose', '🌹', 1)`);
    await primitives.runAsync(
        'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (42, 7, 5)');
}

function makeService(primitives) {
    const repoDeps = {
        getAsync: primitives.getAsync,
        runAsync: primitives.runAsync,
        allAsync: primitives.allAsync,
    };
    const itemService = {
        async getItemById(id) {
            return await primitives.getAsync('SELECT * FROM items WHERE id = ?', [id]);
        },
    };
    return new InventoryService(itemService, null, {
        userInventoryRepository: new UserInventoryRepository(repoDeps),
        itemTransactionRepository: new ItemTransactionRepository(repoDeps),
        withTransaction: createWithTransaction(repoDeps),
    });
}

describe.each([
    { flag: 'true', make: makeBetterPrimitives },
    { flag: 'false', make: makeSqlite3Primitives },
])('InventoryService.giftItem / transferItem atomicity (USE_BETTER_SQLITE3=$flag)', ({ flag, make }) => {
    let savedFlag;
    let primitives;
    let svc;

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
        svc = makeService(primitives);
    });

    afterEach(async () => {
        await primitives.close();
    });

    it('giftItem happy path: moves items and writes the audit row, all committed together', async () => {
        const result = await svc.giftItem(42, 99, 7, 2);
        expect(result).toEqual({ item: { id: 7, name: 'Rose', emoji: '🌹' }, quantity: 2 });

        const sender = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 42 AND item_id = 7');
        expect(sender.quantity).toBe(3);
        const recipient = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 99 AND item_id = 7');
        expect(recipient.quantity).toBe(2);
        const audit = await primitives.allAsync('SELECT * FROM gift_transactions');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ from_user_id: 42, to_user_id: 99, item_id: 7, quantity: 2 });
    });

    it('giftItem crash injection: recipient-credit failure restores the sender inventory (audit E3)', async () => {
        const incSpy = jest.spyOn(UserInventoryRepository.prototype, 'incrementQuantity')
            .mockRejectedValue(new Error('simulated credit failure'));

        await expect(svc.giftItem(42, 99, 7, 2)).rejects.toThrow('simulated credit failure');

        const sender = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 42 AND item_id = 7');
        expect(sender.quantity).toBe(5); // remove rolled back
        const audit = await primitives.allAsync('SELECT * FROM gift_transactions');
        expect(audit).toEqual([]);

        incSpy.mockRestore();
    });

    it('transferItem crash injection: recipient-credit failure restores the sender inventory', async () => {
        const incSpy = jest.spyOn(UserInventoryRepository.prototype, 'incrementQuantity')
            .mockRejectedValue(new Error('simulated credit failure'));

        await expect(svc.transferItem(42, 99, 7, 2)).rejects.toThrow('simulated credit failure');

        const sender = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 42 AND item_id = 7');
        expect(sender.quantity).toBe(5);

        incSpy.mockRestore();
    });

    it('transferItem happy path stays intact', async () => {
        const result = await svc.transferItem(42, 99, 7, 1);
        expect(result).toMatchObject({ success: true, itemId: 7, quantity: 1 });
        const recipient = await primitives.getAsync(
            'SELECT quantity FROM user_inventory WHERE user_id = 99 AND item_id = 7');
        expect(recipient.quantity).toBe(1);
    });
});
