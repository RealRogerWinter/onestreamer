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
 * Schema source (ADR-0030): the bootstrap functions run the REAL production
 * init path — `initializeSchema` exported by server/database/database.js —
 * against the test's :memory: connection. The fixture used to hand-copy an
 * "approximation" of the money-flow subset, which is exactly the drift trap
 * audit findings DB1/DB3 called out (the copy invented columns prod never
 * created, masking a fresh-boot-breaks-the-economy bug). Do NOT add CREATE
 * TABLE statements here; add them to database.js (+ a numbered migration)
 * and every consumer of this fixture picks them up.
 *
 * `bootstrapMoneyFlowSchema` / `bootstrapRecordingSchema` are kept as named
 * aliases of the same full prod-path boot so existing call sites read
 * unchanged.
 *
 * Test-env-flag matrix (per Phase 13 plan): `forEachBackend(fn)` calls `fn`
 * twice — once with the sqlite3 primitives, once with the better-sqlite3
 * primitives — and sets/restores USE_BETTER_SQLITE3 accordingly. Use it at
 * describe-time, not inside an it(). See routes.shop.purchase.integration.test.js
 * for the canonical usage pattern.
 */

const sqlite3 = require('sqlite3').verbose();
const { createBetterSqlite3Adapter } = require('../../../database/database-better');
// NOTE: require the side-effect-free schema module, NOT database/database —
// requiring the latter self-boots against the real data file and its async
// bootstrap can outlive fast test files (jest "import after teardown").
const { initializeSchema } = require('../../../database/schema');

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
 * Wrap a raw better-sqlite3 Database in the minimal callback-style surface
 * `initializeSchema` needs (`serialize(fn)` + `run(sql[, params][, cb])`).
 * better-sqlite3 is synchronous, so "serialize" is a plain invoke and each
 * run executes eagerly; errors go to the callback when one is provided
 * (matching sqlite3's contract — the migrations' duplicate-column swallowing
 * depends on receiving the error, and better-sqlite3 uses the same
 * "duplicate column" message text).
 */
function makeBetterSchemaShim(rawBetterDb) {
    return {
        serialize(fn) {
            if (typeof fn === 'function') fn();
        },
        run(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = undefined;
            }
            let err = null;
            try {
                const stmt = rawBetterDb.prepare(sql);
                const args = params === undefined ? [] : Array.isArray(params) ? params : [params];
                if (stmt.reader) stmt.all(...args);
                else stmt.run(...args);
            } catch (e) {
                err = e;
            }
            if (typeof cb === 'function') cb.call({}, err);
            else if (err) throw err;
        },
        // Migration 202605270010 probes sqlite_master via db.get() before its
        // addColumn. The shim's original serialize+run surface silently broke
        // it here ("db.get is not a function", swallowed by the pre-DB6
        // runner); with fail-loud migrations (ADR-0035) that throw aborts the
        // bootstrap, so the shim must cover the full surface migrations use.
        get(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = undefined;
            }
            let err = null;
            let row;
            try {
                const stmt = rawBetterDb.prepare(sql);
                const args = params === undefined ? [] : Array.isArray(params) ? params : [params];
                row = stmt.get(...args);
            } catch (e) {
                err = e;
            }
            if (typeof cb === 'function') cb.call({}, err, row);
            else if (err) throw err;
        },
    };
}

/**
 * Boot the FULL production schema (database.js `initializeSchema`, incl. the
 * numbered migrations and seeds) against the test's :memory: connection.
 * Works for both backends: sqlite3 primitives expose the callback API
 * natively; better-sqlite3 goes through `makeBetterSchemaShim`.
 */
async function bootstrapProductionSchema(primitives) {
    const quietLogger = {
        error: (...args) => console.error('[db-fixture initializeSchema]', ...args),
        debug: () => {},
    };
    // Backend detection: better-sqlite3's Database exposes `.pragma`
    // (sqlite3's does not — and BOTH have `.serialize`, with different
    // meanings, so that is NOT a usable discriminator).
    const handle = typeof primitives.db.pragma === 'function'
        ? makeBetterSchemaShim(primitives.db)
        : primitives.db;
    await initializeSchema(handle, quietLogger);
}

/**
 * Historical name — Phase 13 tests bootstrapped only a hand-copied
 * "money-flow subset". Now the full prod schema (ADR-0030).
 */
async function bootstrapMoneyFlowSchema(primitives) {
    await bootstrapProductionSchema(primitives);
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

/**
 * Historical name — PR 13.3 tests bootstrapped only a hand-copied recording
 * subset (`recording_sessions`, `session_chat_messages`,
 * `admin_review_settings` + its seed). Now the full prod schema (ADR-0030);
 * the admin_review_settings defaults come from database.js's own seed.
 */
async function bootstrapRecordingSchema(primitives) {
    await bootstrapProductionSchema(primitives);
}

/**
 * Insert a recording_sessions row with sensible defaults. Caller can
 * override any column. Returns the inserted row's session_id.
 */
async function seedRecordingSession(primitives, overrides = {}) {
    const row = {
        session_id: 'session-' + Date.now() + '-' + Math.floor(Math.random() * 100000),
        streamer_identity: 'tester',
        streamer_user_id: null,
        streamer_username: 'tester',
        start_time: Date.now() - 60_000,
        end_time: Date.now(),
        duration_ms: 60_000,
        status: 'completed',
        local_path: null,
        b2_file_id: null,
        b2_file_name: null,
        file_size_bytes: 0,
        segment_count: 1,
        chat_message_count: 0,
        metadata_json: null,
        ...overrides,
    };
    await primitives.runAsync(
        `INSERT INTO recording_sessions
            (session_id, streamer_identity, streamer_user_id, streamer_username,
             start_time, end_time, duration_ms, status, local_path,
             b2_file_id, b2_file_name, file_size_bytes, segment_count,
             chat_message_count, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.session_id, row.streamer_identity, row.streamer_user_id, row.streamer_username,
            row.start_time, row.end_time, row.duration_ms, row.status, row.local_path,
            row.b2_file_id, row.b2_file_name, row.file_size_bytes, row.segment_count,
            row.chat_message_count, row.metadata_json,
        ]
    );
    return row.session_id;
}

module.exports = {
    makeSqlite3Primitives,
    makeBetterPrimitives,
    makeBetterSchemaShim,
    bootstrapProductionSchema,
    bootstrapMoneyFlowSchema,
    bootstrapRecordingSchema,
    seedUserAndItem,
    seedRecordingSession,
    forEachBackend,
};
