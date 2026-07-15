/**
 * Fresh-boot schema regression net for audit findings DB1 + DB3.
 *
 * DB1: a fresh onestreamer.db (clone / DR restore) used to boot with NO
 * working economy — user_stats.points_balance, points_transactions,
 * transcriptions/transcription_chunks and 13 load-bearing users columns were
 * only ever created by legacy scripts outside the boot path (or by nothing
 * at all), so every purchase, points tick, and even the login-path SELECT
 * threw "no such column". Only hand-copied test fixtures masked it.
 *
 * DB3: the schema had four unsynchronized DDL sources; recording_events had
 * two conflicting boot definitions.
 *
 * This file boots a :memory: DB through the REAL production init path
 * (`initializeSchema` exported from server/database/database.js — the same
 * function module boot calls, CREATE TABLEs + seeds + numbered migrations)
 * and pins:
 *   1. every promoted shape, byte-matched to the live DB (captured read-only
 *      from prod during the DB1 investigation);
 *   2. recording_events has exactly ONE definition (DB3);
 *   3. the DB1 acceptance criterion: a REAL ShopService.purchaseItem runs
 *      end-to-end against the fresh-booted schema — debit + inventory credit
 *      + both audit rows — plus a UserRepository.getByUsername call (the
 *      login-path pin).
 *
 * Deliberate exclusion (allowlist): the live DB also carries
 * `users.points_balance` — pure legacy dead weight from the pre-2026 points
 * system, referenced by NO code (the real balance lives on
 * user_stats.points_balance). Fresh boot intentionally does NOT create it;
 * it is tolerated live-only drift, documented in ADR-0030. If you add a
 * users column, do not "fix" this gap.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// The boot DDL comes from the side-effect-free schema module (ADR-0030).
const { initializeSchema } = require('../../database/schema');

// The repositories below unconditionally `require('../database')` in their
// constructors, which self-boots database.js against the real data file.
// Pre-require it here with sqlite3.Database monkey-patched to :memory: so
// the cached module instance the repos will see never touches that file
// (and its async bootstrap completes harmlessly during this suite's run).
const originalSqliteDatabase = sqlite3.Database;
function PatchedDatabase(_filename, ...rest) {
    return new originalSqliteDatabase(':memory:', ...rest);
}
PatchedDatabase.prototype = originalSqliteDatabase.prototype;
sqlite3.Database = PatchedDatabase;
try {
    require('../../database/database');
} finally {
    sqlite3.Database = originalSqliteDatabase;
}

const { createWithTransaction } = require('../../database/transaction');
const UserRepository = require('../../database/repository/UserRepository');
const ShopRepository = require('../../database/repository/ShopRepository');
const ItemTransactionRepository = require('../../database/repository/ItemTransactionRepository');
const UserInventoryRepository = require('../../database/repository/UserInventoryRepository');
const AccountStatsRepository = require('../../database/repository/AccountStatsRepository');
const InventoryService = require('../../services/InventoryService');
const ShopService = require('../../services/ShopService');

function makeLogger() {
    const calls = { error: [] };
    return {
        error: (...args) => calls.error.push(args),
        debug: () => {},
        _calls: calls,
    };
}

function makePrimitives(db) {
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
    return { runAsync, getAsync, allAsync };
}

describe('fresh :memory: boot via the production init path (DB1 + DB3)', () => {
    let db;
    let logger;
    let primitives;

    const tableInfo = async (table) => {
        const cols = await primitives.allAsync(`PRAGMA table_info(${table})`);
        const byName = {};
        for (const c of cols) byName[c.name] = c;
        return byName;
    };

    beforeAll(async () => {
        db = new sqlite3.Database(':memory:');
        logger = makeLogger();
        await initializeSchema(db, logger);
        primitives = makePrimitives(db);
    }, 15_000);

    afterAll((done) => {
        db.close(done);
    });

    it('boots with zero migration/bootstrap errors', () => {
        expect(logger._calls.error).toEqual([]);
    });

    describe('DB1 — promoted shapes match the live DB byte-for-byte', () => {
        it('user_stats carries points_balance INTEGER DEFAULT 0', async () => {
            const cols = await tableInfo('user_stats');
            expect(cols.points_balance).toMatchObject({
                type: 'INTEGER',
                dflt_value: '0',
                notnull: 0,
            });
        });

        it('points_transactions exists with the live shape + both live indexes', async () => {
            const cols = await tableInfo('points_transactions');
            expect(cols.user_id).toMatchObject({ type: 'INTEGER', notnull: 1 });
            expect(cols.amount).toMatchObject({ type: 'INTEGER', notnull: 1 });
            expect(cols.balance_after).toMatchObject({ type: 'INTEGER', notnull: 1 });
            expect(cols.type).toMatchObject({ type: 'VARCHAR(50)', notnull: 1 });
            expect(cols.description).toMatchObject({ type: 'TEXT' });
            expect(cols.metadata).toMatchObject({ type: 'TEXT' });
            expect(cols.created_at).toMatchObject({ type: 'DATETIME', dflt_value: 'CURRENT_TIMESTAMP' });

            const indexes = (await primitives.allAsync(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='points_transactions'"
            )).map((r) => r.name);
            expect(indexes).toEqual(expect.arrayContaining([
                'idx_points_transactions_user_id',
                'idx_points_transactions_created_at',
            ]));
        });

        it('transcriptions matches the live shape (TEXT id, INTEGER epoch times, strftime default) — NOT the deleted legacy script\'s shape', async () => {
            const cols = await tableInfo('transcriptions');
            expect(cols.id).toMatchObject({ type: 'TEXT', pk: 1 });
            expect(cols.streamer_id).toMatchObject({ type: 'TEXT' });
            expect(cols.start_time).toMatchObject({ type: 'INTEGER' });
            expect(cols.end_time).toMatchObject({ type: 'INTEGER' });
            expect(cols.status).toMatchObject({ type: 'TEXT', dflt_value: "'active'" });
            expect(cols.created_at).toMatchObject({
                type: 'INTEGER',
                dflt_value: "strftime('%s', 'now')",
            });
            expect(cols.stream_id).toMatchObject({ type: 'TEXT' });
            // The legacy setup-transcription-tables.js's extra tables never
            // existed on the live DB and must not be created fresh either.
            const legacyTables = (await primitives.allAsync(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('transcription_events', 'transcription_settings')"
            ));
            expect(legacyTables).toEqual([]);
        });

        it('transcription_chunks matches the live shape, and the three live transcription indexes exist', async () => {
            const cols = await tableInfo('transcription_chunks');
            expect(cols.id).toMatchObject({ type: 'INTEGER', pk: 1 });
            expect(cols.transcription_id).toMatchObject({ type: 'TEXT' });
            expect(cols.chunk_number).toMatchObject({ type: 'INTEGER' });
            expect(cols.confidence).toMatchObject({ type: 'REAL' });
            expect(cols.created_at).toMatchObject({
                type: 'INTEGER',
                dflt_value: "strftime('%s', 'now')",
            });
            expect(cols.word_count).toMatchObject({ type: 'INTEGER', dflt_value: '0' });

            const indexes = (await primitives.allAsync(
                "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_transcriptions_streamer', 'idx_transcriptions_created', 'idx_chunks_transcription')"
            )).map((r) => r.name);
            expect(indexes.sort()).toEqual([
                'idx_chunks_transcription',
                'idx_transcriptions_created',
                'idx_transcriptions_streamer',
            ]);
        });

        it('users carries the login-path, profile, and deletion-lifecycle columns', async () => {
            const cols = await tableInfo('users');
            // Login path (UserRepository.getByUsername SELECT list)
            expect(cols.username_changed).toMatchObject({ type: 'BOOLEAN', dflt_value: '0' });
            expect(cols.avatar_url).toMatchObject({ type: 'TEXT' });
            expect(cols.description).toMatchObject({ type: 'TEXT' });
            // Deletion lifecycle
            expect(cols.account_status).toMatchObject({ type: 'TEXT', dflt_value: "'active'" });
            for (const c of ['deletion_requested_at', 'deletion_confirmed_at', 'deletion_scheduled_for', 'deletion_token_expires']) {
                expect(cols[c]).toBeDefined();
            }
            expect(cols.deletion_token).toMatchObject({ type: 'TEXT' });
            // Profile
            for (const c of ['bio', 'website', 'location', 'display_name']) {
                expect(cols[c]).toMatchObject({ type: 'TEXT' });
            }
            // ALLOWLIST: users.points_balance is live-only legacy dead weight
            // (no code reads it; the real counter is user_stats.points_balance).
            // Deliberately NOT created on fresh boot — see file header + ADR-0030.
            expect(cols.points_balance).toBeUndefined();

            const indexes = (await primitives.allAsync(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'"
            )).map((r) => r.name);
            expect(indexes).toEqual(expect.arrayContaining([
                'idx_users_account_status',
                'idx_users_deletion_scheduled',
            ]));
        });

        it('items carries category (live parity) and is_tradeable (gifting gate), both defaulted', async () => {
            const cols = await tableInfo('items');
            expect(cols.category).toMatchObject({ type: 'TEXT', dflt_value: "'general'" });
            // DEFAULT 0 = gifting blocked for every item, preserving prod
            // behavior; flipping items to tradeable is a product decision.
            expect(cols.is_tradeable).toMatchObject({ type: 'BOOLEAN', dflt_value: '0' });
        });

        it('recording_settings is seeded with the defaults that used to live in recording-schema.sql', async () => {
            const rows = await primitives.allAsync('SELECT key FROM recording_settings');
            const keys = rows.map((r) => r.key).sort();
            expect(keys).toEqual([
                'auto_cleanup_enabled',
                'compression_enabled',
                'compression_queue_limit',
                'default_quality',
                'disk_space_threshold',
                'max_concurrent_recordings',
                'max_recording_duration',
                'retention_days',
                'thumbnail_generation',
            ]);
        });
    });

    describe('DB3 — single DDL source', () => {
        it('recording_events appears exactly once in sqlite_master, with the database.js shape (user_id INTEGER)', async () => {
            const defs = await primitives.allAsync(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='recording_events'"
            );
            expect(defs).toHaveLength(1);
            const cols = await tableInfo('recording_events');
            // The deleted recording-schema.sql declared user_id TEXT + an FK
            // to recordings; the surviving definition is database.js's.
            expect(cols.user_id).toMatchObject({ type: 'INTEGER' });
            expect(defs[0].sql).not.toMatch(/REFERENCES recordings/);

            const indexes = (await primitives.allAsync(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='recording_events'"
            )).map((r) => r.name).sort();
            // Both idx_recording_events_recording and _recording_id exist on
            // the live DB (historical duplication), so fresh boot keeps both.
            expect(indexes).toEqual([
                'idx_recording_events_event_type',
                'idx_recording_events_recording',
                'idx_recording_events_recording_id',
                'idx_recording_events_timestamp',
            ]);
        });

        it('the conflicting recording-schema.sql DDL source is gone', () => {
            expect(fs.existsSync(
                path.join(__dirname, '..', '..', 'database', 'recording-schema.sql')
            )).toBe(false);
            expect(fs.existsSync(
                path.join(__dirname, '..', '..', 'migrations', 'setup-recording-tables.js')
            )).toBe(false);
            expect(fs.existsSync(
                path.join(__dirname, '..', '..', 'migrations', 'setup-clips-tables.js')
            )).toBe(false);
            expect(fs.existsSync(
                path.join(__dirname, '..', '..', 'migrations', 'setup-transcription-tables.js')
            )).toBe(false);
        });
    });

    describe('DB1 acceptance — the fresh-booted schema runs the real economy end-to-end', () => {
        // Service wiring mirrors ShopService.purchaseItem.atomic.test.js
        // (repos + withTransaction bound to THESE primitives, not the module
        // singleton), except accountService is backed by the REAL
        // AccountStatsRepository so the debit + points_transactions audit
        // row exercise the production SQL against the fresh-booted schema.
        function makeServices() {
            const repoDeps = {
                getAsync: primitives.getAsync,
                runAsync: primitives.runAsync,
                allAsync: primitives.allAsync,
            };
            const userRepository = new UserRepository(repoDeps);
            const shopRepository = new ShopRepository(repoDeps);
            const itemTransactionRepository = new ItemTransactionRepository(repoDeps);
            const userInventoryRepository = new UserInventoryRepository(repoDeps);
            const accountStatsRepository = new AccountStatsRepository(repoDeps);

            const itemService = {
                async getItemById(id) {
                    return await primitives.getAsync('SELECT * FROM items WHERE id = ?', [id]);
                },
                async validateItemUsage() { return { valid: true }; },
                isBuffOrDebuffItem() { return false; },
                async applyItemCooldown() {},
                async getAllItems() { return await primitives.allAsync('SELECT * FROM items'); },
            };

            // Facade mirroring PointsManager.subtractPoints byte-for-byte
            // (atomic guarded debit + audit insert), bound to the fresh boot.
            const accountService = {
                async getPointsBalance(userId) {
                    const row = await accountStatsRepository.getPointsBalanceByUserId(userId);
                    return row?.points_balance || 0;
                },
                async subtractPoints(userId, amount, type, description, metadata = null) {
                    const updated = await accountStatsRepository.atomicSubtractPoints({ userId, amount });
                    if (!updated) {
                        throw new Error('Insufficient points balance');
                    }
                    await accountStatsRepository.insertTransaction({
                        userId,
                        amount: -amount,
                        balanceAfter: updated.points_balance,
                        type,
                        description,
                        metadataJson: metadata ? JSON.stringify(metadata) : null,
                    });
                    return updated.points_balance;
                },
            };

            const inventoryService = new InventoryService(itemService, null, {
                userInventoryRepository,
                itemTransactionRepository,
            });
            const withTransaction = createWithTransaction(repoDeps);
            const shopService = new ShopService(itemService, inventoryService, accountService, null, {
                userRepository,
                shopRepository,
                itemTransactionRepository,
                withTransaction,
            });

            return { shopService, userRepository, accountStatsRepository };
        }

        let services;
        let originalConsoleError;

        beforeAll(async () => {
            await primitives.runAsync(
                'INSERT INTO users (id, email, username) VALUES (?, ?, ?)',
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
            // ShopService.initializeShop() fires from the constructor; give it
            // a deterministic await point (idempotent — early-returns because
            // shop_items already has a row) and mute its fire-and-forget noise.
            originalConsoleError = console.error;
            console.error = jest.fn();
            services = makeServices();
            await services.shopService.initializeShop();
        });

        afterAll(() => {
            console.error = originalConsoleError;
        });

        it('UserRepository.getByUsername works (the login-path SELECT names username_changed/avatar_url/description)', async () => {
            const user = await services.userRepository.getByUsername('tester');
            expect(user).toMatchObject({ id: 42, username: 'tester', username_changed: 0 });
        });

        it('a REAL ShopService.purchaseItem debits, credits inventory, and writes both audit rows — no "no such column: points_balance"', async () => {
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

            const itemTxRows = await primitives.allAsync(
                'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
            expect(itemTxRows).toHaveLength(1);
            expect(itemTxRows[0]).toMatchObject({
                user_id: 42,
                item_id: 7,
                transaction_type: 'purchase',
                quantity: 2,
                total_cost: 200,
                points_before: 1000,
                points_after: 800,
            });

            const pointsTxRows = await primitives.allAsync(
                'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
            expect(pointsTxRows).toHaveLength(1);
            expect(pointsTxRows[0]).toMatchObject({
                user_id: 42,
                amount: -200,
                balance_after: 800,
                type: 'purchase',
            });
        });
    });
});
