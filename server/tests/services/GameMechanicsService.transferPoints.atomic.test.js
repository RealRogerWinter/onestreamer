/**
 * transferPoints atomicity (ADR-0029, audit E2).
 *
 * Pre-refactor, transferPoints did debit-then-credit as two bare writes with
 * no transaction — a failure between them destroyed the sender's points. Now
 * both (plus their points_transactions audit rows) share one withTransaction
 * scope, threaded through the REAL AccountService → PointsManager →
 * tx-scoped AccountStatsRepository plumbing.
 *
 * Real in-memory connection, both backends, REAL AccountService constructed
 * over injected repos (no jest.mock of the database module needed).
 */

const sqlite3 = require('sqlite3').verbose();
const { createBetterSqlite3Adapter } = require('../../database/database-better');
const { createWithTransaction } = require('../../database/transaction');

const AccountStatsRepository = require('../../database/repository/AccountStatsRepository');
const UserRepository = require('../../database/repository/UserRepository');
const AccountService = require('../../services/AccountService');
const GameMechanicsService = require('../../services/GameMechanicsService');

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
            password TEXT,
            last_login DATETIME,
            is_verified BOOLEAN DEFAULT 0,
            is_admin BOOLEAN DEFAULT 0,
            is_moderator BOOLEAN DEFAULT 0,
            is_banned BOOLEAN DEFAULT 0,
            account_status TEXT DEFAULT 'active',
            oauth_provider TEXT,
            username_changed BOOLEAN DEFAULT 0,
            avatar_url TEXT,
            description TEXT,
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
            balance_after INTEGER,
            type TEXT,
            description TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await primitives.runAsync(
        "INSERT INTO users (id, email, username) VALUES (42, 's@e.com', 'sender')");
    await primitives.runAsync(
        "INSERT INTO users (id, email, username) VALUES (99, 'r@e.com', 'recipient')");
    await primitives.runAsync(
        'INSERT INTO user_stats (user_id, points_balance) VALUES (42, 1000)');
    // Recipient deliberately has NO user_stats row — exercises the
    // insertStatsWithBalance fallback inside the tx.
}

function makeService(primitives) {
    const repoDeps = {
        getAsync: primitives.getAsync,
        runAsync: primitives.runAsync,
        allAsync: primitives.allAsync,
    };
    const accountService = new AccountService({
        userRepository: new UserRepository(repoDeps),
        accountStatsRepository: new AccountStatsRepository(repoDeps),
        userSessionRepository: {},
    });
    return new GameMechanicsService({
        accountService,
        userBonusCooldowns: new Map(),
        withTransaction: createWithTransaction(repoDeps),
    });
}

describe.each([
    { flag: 'true', make: makeBetterPrimitives },
    { flag: 'false', make: makeSqlite3Primitives },
])('GameMechanicsService.transferPoints atomicity (USE_BETTER_SQLITE3=$flag)', ({ flag, make }) => {
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

    it('happy path: debit + credit (fallback-insert) + both audit rows commit together', async () => {
        const result = await svc.transferPoints(42, 'recipient', 300, 'sender');
        expect(result).toMatchObject({
            senderNewBalance: 700,
            recipientNewBalance: 300,
            recipientUserId: 99,
        });

        const sender = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = 42');
        expect(sender.points_balance).toBe(700);
        const recipient = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = 99');
        expect(recipient.points_balance).toBe(300);

        const audits = await primitives.allAsync(
            'SELECT user_id, amount, balance_after, type FROM points_transactions ORDER BY id');
        expect(audits).toEqual([
            { user_id: 42, amount: -300, balance_after: 700, type: 'transfer_out' },
            { user_id: 99, amount: 300, balance_after: 300, type: 'transfer_in' },
        ]);
    });

    it('crash injection on the recipient credit: sender balance restored, ZERO audit rows (audit E2)', async () => {
        // The recipient has no stats row, so the credit goes through
        // insertStatsWithBalance — fail it after the sender debit landed.
        const insertSpy = jest.spyOn(AccountStatsRepository.prototype, 'insertStatsWithBalance')
            .mockRejectedValue(new Error('simulated credit failure'));

        await expect(svc.transferPoints(42, 'recipient', 300, 'sender'))
            .rejects.toThrow('simulated credit failure');

        const sender = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = 42');
        expect(sender.points_balance).toBe(1000); // debit rolled back

        const audits = await primitives.allAsync('SELECT * FROM points_transactions');
        expect(audits).toEqual([]); // not even the transfer_out audit row survived

        insertSpy.mockRestore();
    });

    it('crash injection on the audit INSERT: both balances restored', async () => {
        await primitives.runAsync(
            'INSERT INTO user_stats (user_id, points_balance) VALUES (99, 50)');
        // Fail the SECOND audit insert (recipient's transfer_in row).
        const originalInsert = AccountStatsRepository.prototype.insertTransaction;
        let calls = 0;
        const insertSpy = jest.spyOn(AccountStatsRepository.prototype, 'insertTransaction')
            .mockImplementation(function (...args) {
                calls++;
                if (calls === 2) return Promise.reject(new Error('simulated audit failure'));
                return originalInsert.apply(this, args);
            });

        await expect(svc.transferPoints(42, 'recipient', 300, 'sender'))
            .rejects.toThrow('simulated audit failure');

        const sender = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = 42');
        expect(sender.points_balance).toBe(1000);
        const recipient = await primitives.getAsync(
            'SELECT points_balance FROM user_stats WHERE user_id = 99');
        expect(recipient.points_balance).toBe(50);

        insertSpy.mockRestore();
    });

    it('in-scope insufficient-funds (atomic guard beat the pre-check) rolls back cleanly', async () => {
        // Pre-check passes (balance 1000), then the guard inside the scope
        // fails because a concurrent debit landed first — simulate by making
        // the guarded UPDATE return no row.
        const subSpy = jest.spyOn(AccountStatsRepository.prototype, 'atomicSubtractPoints')
            .mockResolvedValue(undefined);

        await expect(svc.transferPoints(42, 'recipient', 300, 'sender'))
            .rejects.toThrow('Insufficient points balance');

        const audits = await primitives.allAsync('SELECT * FROM points_transactions');
        expect(audits).toEqual([]);

        subSpy.mockRestore();
    });
});
