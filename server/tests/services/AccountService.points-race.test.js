/**
 * AccountService.addPoints / subtractPoints — atomic-SQL regression gate.
 *
 * Pre-PR-5.1, addPoints/subtractPoints were a read-compute-write loop:
 * SELECT points_balance → JS arithmetic → UPDATE … = ? (absolute). Two
 * concurrent callers both read the same balance, both computed, both
 * wrote, second write overwrote first — points lost.
 *
 * PR 5.1 (ADR-0013) collapsed both code paths to a single atomic SQL:
 *   UPDATE user_stats
 *      SET points_balance = points_balance + ?   -- or `- ?` for subtract
 *    WHERE user_id = ?                            -- + AND points_balance >= ?
 *  RETURNING points_balance;
 *
 * This test is now the regression gate for that invariant: concurrent
 * addPoints/subtractPoints under microtask interleaving must produce the
 * EXACT atomic-arithmetic answer. If anyone reintroduces a JS-side
 * read-compute-write path, the `toBe(...)` assertions below will fail.
 *
 * The DB layer is mocked with an in-memory implementation whose `getAsync`
 * / `runAsync` each `await Promise.resolve()` once, so concurrent awaits
 * interleave through the microtask queue. The mock implements the
 * relative-arithmetic UPDATE … RETURNING semantics that real sqlite3
 * applies atomically per-statement.
 */

// Mock the DB primitives BEFORE any require that pulls them in.
jest.mock('../../database/database', () => {
    // In-memory store mimicking the user_stats and points_transactions tables.
    const userStats = new Map(); // userId -> { user_id, points_balance, ... }
    const transactions = [];

    // Real sqlite3 yields on I/O; Promise.resolve()'s microtask suffices to
    // expose the race in a single-thread Node environment.
    async function runAsync(sql, params = []) {
        await Promise.resolve();
        if (/INSERT\s+INTO\s+user_stats/i.test(sql)) {
            const [userId, balance] = params;
            userStats.set(userId, { user_id: userId, points_balance: balance });
            return { changes: 1, lastID: userId };
        }
        if (/INSERT\s+INTO\s+points_transactions/i.test(sql)) {
            transactions.push(params);
            return { changes: 1, lastID: transactions.length };
        }
        return { changes: 0, lastID: undefined };
    }

    async function getAsync(sql, params = []) {
        await Promise.resolve();

        // PR 5.1: atomic guarded subtract — must come before the plain
        // add/subtract regexes so the guarded variant matches first.
        if (/UPDATE\s+user_stats\s+SET\s+points_balance\s*=\s*points_balance\s*-\s*\?[\s\S]*WHERE\s+user_id\s*=\s*\?\s+AND\s+points_balance\s*>=\s*\?[\s\S]*RETURNING\s+points_balance/i.test(sql)) {
            const [amount, userId, minBalance] = params;
            const row = userStats.get(userId);
            if (!row || row.points_balance < minBalance) {
                return undefined;
            }
            row.points_balance -= amount;
            userStats.set(userId, row);
            return { points_balance: row.points_balance };
        }

        // PR 5.1: atomic add — relative-arithmetic UPDATE … RETURNING.
        if (/UPDATE\s+user_stats\s+SET\s+points_balance\s*=\s*points_balance\s*\+\s*\?[\s\S]*WHERE\s+user_id\s*=\s*\?[\s\S]*RETURNING\s+points_balance/i.test(sql)) {
            const [amount, userId] = params;
            const row = userStats.get(userId);
            if (!row) {
                return undefined;
            }
            row.points_balance += amount;
            userStats.set(userId, row);
            return { points_balance: row.points_balance };
        }

        if (/SELECT\s+\*\s+FROM\s+user_stats\s+WHERE\s+user_id\s*=\s*\?/i.test(sql)) {
            return userStats.get(params[0]) || null;
        }
        if (/SELECT\s+points_balance\s+FROM\s+user_stats\s+WHERE\s+user_id\s*=\s*\?/i.test(sql)) {
            return userStats.get(params[0]) || null;
        }
        return null;
    }

    async function allAsync() {
        await Promise.resolve();
        return [];
    }

    return {
        db: {},
        runAsync,
        getAsync,
        allAsync,
        // Test-only handle so individual tests can seed and inspect state.
        __testStore: { userStats, transactions },
    };
});

// Mock UserRepository — AccountService instantiates it in its constructor
// and we don't care about its behaviour for this race test.
jest.mock('../../database/repository/UserRepository', () => {
    return class UserRepository {
        constructor() {}
    };
});

const AccountService = require('../../services/AccountService');
const { __testStore } = require('../../database/database');

describe('AccountService — points-balance atomicity (ADR-0013)', () => {
    beforeEach(() => {
        __testStore.userStats.clear();
        __testStore.transactions.length = 0;
        // Silence the "Added N points..." console.log that addPoints emits
        // — the race fires 20 calls and the noise drowns the test report.
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('addPoints is ATOMIC under concurrent calls (PR 5.1 contract)', async () => {
        const account = new AccountService();
        const userId = 42;

        // Seed an existing stats row so addPoints takes the UPDATE path
        // (not the INSERT-then-UPDATE path on first-call).
        __testStore.userStats.set(userId, { user_id: userId, points_balance: 0 });

        const N = 20;
        const amount = 5;
        const expectedIfAtomic = N * amount; // 100

        // Fire N concurrent addPoints calls. They interleave through the
        // microtask queue; each one's UPDATE is a single relative-arithmetic
        // statement against the live row, so every increment must land.
        await Promise.all(
            Array.from({ length: N }, () =>
                account.addPoints(userId, amount, 'test', 'atomic-contract')
            )
        );

        const final = __testStore.userStats.get(userId).points_balance;

        // No lost updates. Exact arithmetic answer.
        expect(final).toBe(expectedIfAtomic);
    });

    test('subtractPoints is ATOMIC under concurrent calls (PR 5.1 contract)', async () => {
        const account = new AccountService();
        const userId = 99;

        // Seed a fat balance so all subtractions succeed without hitting
        // the insufficient-balance guard.
        const seed = 10_000;
        __testStore.userStats.set(userId, { user_id: userId, points_balance: seed });

        const N = 20;
        const amount = 5;
        const expectedIfAtomic = seed - N * amount; // 9900

        await Promise.all(
            Array.from({ length: N }, () =>
                account.subtractPoints(userId, amount, 'test', 'atomic-contract')
            )
        );

        const final = __testStore.userStats.get(userId).points_balance;

        // No lost updates. Exact arithmetic answer.
        expect(final).toBe(expectedIfAtomic);
    });

    test('addPoints is CORRECT under sequential calls (proves the race is the bug, not the math)', async () => {
        const account = new AccountService();
        const userId = 7;
        __testStore.userStats.set(userId, { user_id: userId, points_balance: 0 });

        const N = 20;
        const amount = 5;

        // Sequential, not Promise.all: each addPoints awaits the
        // previous one. No race possible. Final balance is exact.
        for (let i = 0; i < N; i++) {
            await account.addPoints(userId, amount, 'test', 'sequential-control');
        }

        const final = __testStore.userStats.get(userId).points_balance;
        expect(final).toBe(N * amount); // 100, exactly.
    });
});
