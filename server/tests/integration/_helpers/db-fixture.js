/**
 * In-memory DB primitives + schema bootstrap shared by Phase 13 integration
 * tests.
 *
 * Why this exists: the per-test bootstrap blocks copy-pasted across
 * ShopService.purchaseItem.atomic.test.js and ShopService.purchaseItem.realAccount.test.js
 * are ~80 lines apiece of identical CREATE TABLE / seed-data wiring. PR 13.1
 * adds two integration test files that need the same schema PLUS a real
 * Express app, so the bootstrap moves here and the test files stay focused on
 * the actual HTTP round-trips they're proving.
 *
 * What this is NOT: a general-purpose schema framework. The CREATE TABLE
 * shapes here mirror exactly the columns the production AccountService /
 * ShopService / InventoryService SQL touches — and only those. If a service's
 * SQL grows a new column, add it here (and to any sibling per-test bootstraps
 * that haven't migrated yet). The single source of truth for the live schema
 * is server/database/database.js; this fixture is an integration-test
 * approximation of the subset money-flow code paths touch.
 *
 * Test-env-flag matrix (per Phase 13 plan): `forEachBackend(fn)` calls `fn`
 * twice — once with the sqlite3 primitives, once with the better-sqlite3
 * primitives — and sets/restores USE_BETTER_SQLITE3 accordingly. Use it at
 * describe-time, not inside an it(). See routes.shop.purchase.integration.test.js
 * for the canonical usage pattern.
 */

const sqlite3 = require('sqlite3').verbose();
const { createBetterSqlite3Adapter } = require('../../../database/database-better');

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

/**
 * Create the subset of the production schema that money-flow services touch.
 * Mirrors columns in ShopService, AccountService, InventoryService.
 */
async function bootstrapMoneyFlowSchema(primitives) {
    await primitives.runAsync(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            username TEXT UNIQUE NOT NULL,
            password TEXT,
            is_verified BOOLEAN DEFAULT 0,
            is_admin BOOLEAN DEFAULT 0,
            is_moderator BOOLEAN DEFAULT 0,
            is_banned BOOLEAN DEFAULT 0,
            account_status TEXT,
            oauth_provider TEXT,
            oauth_id TEXT,
            verification_token TEXT,
            display_name TEXT,
            avatar_url TEXT,
            bio TEXT,
            website TEXT,
            location TEXT,
            description TEXT,
            username_changed BOOLEAN DEFAULT 0,
            last_login DATETIME,
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
            last_stream_at DATETIME,
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
            max_stack INTEGER DEFAULT 0,
            effect_data TEXT
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
}

/**
 * Insert a user with a given starting balance and one shop item.
 * Returns the ids that were assigned, so tests can assert on them.
 */
async function seedUserAndItem(primitives, {
    userId = 42,
    username = 'tester',
    email = 'tester@example.com',
    balance = 1000,
    itemId = 7,
    itemName = 'pizza',
    itemPrice = 100,
    maxStack = 5,
    stockLimit = 10,
} = {}) {
    await primitives.runAsync(
        'INSERT INTO users (id, email, username) VALUES (?, ?, ?)',
        [userId, email, username]
    );
    await primitives.runAsync(
        'INSERT INTO user_stats (user_id, points_balance) VALUES (?, ?)',
        [userId, balance]
    );
    await primitives.runAsync(
        `INSERT INTO items (id, name, display_name, emoji, description, item_type, rarity, base_price, max_stack)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, itemName, 'Pizza', '🍕', 'A slice of pizza', 'buff', 'common', itemPrice, maxStack]
    );
    await primitives.runAsync(
        `INSERT INTO shop_items (id, item_id, price, discount_percentage, is_featured, stock_limit)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [1, itemId, itemPrice, 0, 0, stockLimit]
    );
    return { userId, itemId };
}

/**
 * Run a describe block once per DB backend (sqlite3, better-sqlite3),
 * setting USE_BETTER_SQLITE3 around each block. Keeps the matrix wrapper
 * out of every test file.
 *
 * Usage:
 *   forEachBackend(({ make }) => {
 *     describe('my integration suite', () => {
 *       let primitives;
 *       beforeEach(async () => {
 *         primitives = make();
 *         await bootstrapMoneyFlowSchema(primitives);
 *         // ...
 *       });
 *       afterEach(async () => { await primitives.close(); });
 *
 *       it('does the thing', async () => { ... });
 *     });
 *   });
 */
function forEachBackend(fn) {
    const backends = [
        { flag: 'true', label: 'better-sqlite3', make: makeBetterPrimitives },
        { flag: 'false', label: 'sqlite3', make: makeSqlite3Primitives },
    ];
    for (const backend of backends) {
        describe(`[USE_BETTER_SQLITE3=${backend.flag} → ${backend.label}]`, () => {
            let saved;
            beforeAll(() => {
                saved = process.env.USE_BETTER_SQLITE3;
                process.env.USE_BETTER_SQLITE3 = backend.flag;
            });
            afterAll(() => {
                if (saved === undefined) delete process.env.USE_BETTER_SQLITE3;
                else process.env.USE_BETTER_SQLITE3 = saved;
            });
            fn(backend);
        });
    }
}

module.exports = {
    makeSqlite3Primitives,
    makeBetterPrimitives,
    bootstrapMoneyFlowSchema,
    seedUserAndItem,
    forEachBackend,
};
