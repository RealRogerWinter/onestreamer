/**
 * Shared contract suite for addPoints auto-tx (DB7-remainder, audit Plan 04).
 *
 * addPoints without a caller-supplied tx handle must still commit its
 * balance UPDATE + audit INSERT atomically. The timer/chat/buff writers
 * (TimeTrackingService), /award-points, and admin grants all call
 * accountService.addPoints with no tx; pre-fix those two statements ran
 * bare, so a crash between them left a credit with no ledger row.
 * PointsManager.addPoints now opens its own withTransaction scope when tx
 * is null.
 *
 * Split into per-backend legs like _with-transaction-contract.js: the two
 * native SQLite bindings corrupt each other's error handling when loaded in
 * one process (better-sqlite3 stops throwing — which silently defuses the
 * rollback regression pin below), so:
 *   - the node-sqlite3 leg lives in AccountService.addPoints.autoTx.test.js
 *     (main jest.config.js);
 *   - the better-sqlite3 leg lives in
 *     AccountService.addPoints.autoTx.bettersqlite.test.js
 *     (config/jest/jest.bettersqlite.config.js, isolated process — run via
 *     `npm run test:bettersqlite`).
 *
 * Both legs jest.mock server/database/database with the dbSlot forwarder
 * pattern (see routes.internal.points.integration.test.js): AccountService
 * captures the module primitives at require time, and PointsManager
 * lazy-requires withTransaction from the same (mocked) module.
 *
 * Schema: minimal hand DDL for the three tables the ledger touches (same
 * approach as ShopService.sellItem.atomic.test.js) — including the
 * UNIQUE(user_id) the upsert's ON CONFLICT clause needs (audit DB5 /
 * ADR-0035). The full prod-schema fidelity net is fresh-boot-schema.test.js.
 *
 * Not named `*.test.js`, so jest never collects this file directly.
 */

const { createWithTransaction } = require('../../database/transaction');

async function bootstrapLedgerSchema(primitives) {
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
            user_id INTEGER NOT NULL UNIQUE,
            points_balance INTEGER DEFAULT 0,
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
    await primitives.runAsync(
        "INSERT INTO users (id, email, username) VALUES (42, 't@e.com', 'tester')");
    await primitives.runAsync(
        'INSERT INTO user_stats (user_id, points_balance) VALUES (42, 1000)');
}

/**
 * @param {'true'|'false'} flag  value to pin USE_BETTER_SQLITE3 to
 * @param {() => {db, runAsync, getAsync, allAsync, close}} makePrimitives
 * @param {object} dbSlot  the leg's jest.mock forwarder target
 */
function defineAddPointsAutoTxContract(flag, makePrimitives, dbSlot) {
    // Required lazily INSIDE the suite so the leg's jest.mock of
    // server/database/database is in place first.
    const AccountService = require('../../services/AccountService');

    describe(`addPoints auto-tx (audit DB7, USE_BETTER_SQLITE3=${flag})`, () => {
        let savedFlag;
        let primitives;
        let accountService;
        let withTransactionSpy;

        beforeAll(() => {
            savedFlag = process.env.USE_BETTER_SQLITE3;
            process.env.USE_BETTER_SQLITE3 = flag;
        });
        afterAll(() => {
            if (savedFlag === undefined) delete process.env.USE_BETTER_SQLITE3;
            else process.env.USE_BETTER_SQLITE3 = savedFlag;
        });

        beforeEach(async () => {
            primitives = makePrimitives();
            await bootstrapLedgerSchema(primitives);

            dbSlot.runAsync = primitives.runAsync;
            dbSlot.getAsync = primitives.getAsync;
            dbSlot.allAsync = primitives.allAsync;
            withTransactionSpy = jest.fn(createWithTransaction({
                runAsync: primitives.runAsync,
                getAsync: primitives.getAsync,
                allAsync: primitives.allAsync,
            }));
            dbSlot.withTransaction = withTransactionSpy;

            accountService = new AccountService();
        });

        afterEach(async () => {
            dbSlot.runAsync = null;
            dbSlot.getAsync = null;
            dbSlot.allAsync = null;
            dbSlot.withTransaction = null;
            await primitives.close();
        });

        it('a non-tx call opens its own scope: balance credited + exactly one audit row', async () => {
            const newBalance = await accountService.addPoints(42, 250, 'award', 'test credit');
            expect(newBalance).toBe(1250);
            expect(withTransactionSpy).toHaveBeenCalledTimes(1);

            const balance = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balance.points_balance).toBe(1250);

            const audit = await primitives.allAsync(
                'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
            expect(audit).toHaveLength(1);
            expect(audit[0]).toMatchObject({ amount: 250, balance_after: 1250, type: 'award' });
        });

        it('REGRESSION PIN: a failed audit INSERT rolls the balance UPDATE back (no unledgered credit)', async () => {
            // Force the second statement of the pair to fail.
            await primitives.runAsync('DROP TABLE points_transactions');

            await expect(
                accountService.addPoints(42, 250, 'award', 'doomed credit')
            ).rejects.toThrow(/points_transactions/);

            // Pre-fix, the bare UPDATE had already committed: 1250. Now the
            // scope rolls back and the balance is untouched.
            const balance = await primitives.getAsync(
                'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
            expect(balance.points_balance).toBe(1000);
        });

        it('a caller-supplied tx handle is honored unchanged (no nested scope, joins the caller tx)', async () => {
            const newBalance = await withTransactionSpy(async (tx) =>
                accountService.addPoints(42, 100, 'award', 'in caller scope', null, tx)
            );
            expect(newBalance).toBe(1100);
            // Only the caller's scope — addPoints must not have opened a
            // second one (nesting withTransaction deadlocks).
            expect(withTransactionSpy).toHaveBeenCalledTimes(1);

            const audit = await primitives.allAsync(
                'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
            expect(audit).toHaveLength(1);
        });

        it('first-credit upsert path (no user_stats row yet) is atomic too', async () => {
            await primitives.runAsync(
                'INSERT INTO users (id, email, username) VALUES (?, ?, ?)',
                [77, 'fresh@e.com', 'fresh']);

            const newBalance = await accountService.addPoints(77, 30, 'award', 'first credit');
            expect(newBalance).toBe(30);

            const audit = await primitives.allAsync(
                'SELECT * FROM points_transactions WHERE user_id = ?', [77]);
            expect(audit).toHaveLength(1);
            expect(audit[0]).toMatchObject({ amount: 30, balance_after: 30 });
        });
    });
}

module.exports = { defineAddPointsAutoTxContract, bootstrapLedgerSchema };
