/**
 * AccountService.addPoints / subtractPoints — concurrent lost-update bug.
 *
 * Documents a real pre-Phase-5 defect: `addPoints` (server/services/
 * AccountService.js:226-254) is a read-compute-write loop that issues
 * `UPDATE user_stats SET points_balance = ?` with the absolute new value
 * computed in JS. Two concurrent callers both read the same balance, both
 * compute, both write — second write overwrites first. Points are lost.
 *
 * The fix (Phase 5) is a single atomic SQL:
 *   UPDATE user_stats
 *      SET points_balance = points_balance + ?
 *    WHERE user_id = ?
 * RETURNING points_balance;
 *
 * This test deliberately demonstrates the bug. The headline assertion is
 * `toBeLessThan(N * amount)` — i.e. "we lose points" — so the test PASSES
 * today (the bug is live) and would FAIL once Phase 5's atomic UPDATE
 * lands. When that PR fixes the race, flip the assertion to `toBe(N *
 * amount)` in the same diff that lands the SQL change. Until then, this
 * test is the regression gate: if anyone tries to "optimise" the
 * read-compute-write code path without making it atomic, the assertion
 * still holds and we keep the bug documented.
 *
 * The DB layer is mocked with an in-memory implementation whose `getAsync`
 * / `runAsync` each `await Promise.resolve()` once, so concurrent awaits
 * interleave through the microtask queue. That faithfully reproduces what
 * real sqlite3 (which yields on actual I/O) does today.
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
        if (/UPDATE\s+user_stats\s+SET\s+points_balance\s*=\s*\?/i.test(sql)) {
            const [newBalance, userId] = params;
            const row = userStats.get(userId) || { user_id: userId };
            row.points_balance = newBalance;
            userStats.set(userId, row);
            return { changes: 1, lastID: undefined };
        }
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
        if (/SELECT\s+\*\s+FROM\s+user_stats\s+WHERE\s+user_id\s*=\s*\?/i.test(sql)) {
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

describe('AccountService — points-balance race (PRE-PHASE-5 BUG)', () => {
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

    test('addPoints LOSES POINTS under concurrent calls (read-compute-write race)', async () => {
        const account = new AccountService();
        const userId = 42;

        // Seed an existing stats row so addPoints takes the UPDATE path
        // (not the INSERT-then-UPDATE path on first-call).
        __testStore.userStats.set(userId, { user_id: userId, points_balance: 0 });

        const N = 20;
        const amount = 5;
        const expectedIfAtomic = N * amount; // 100

        // Fire N concurrent addPoints calls. They all enter the
        // read-compute-write loop at roughly the same microtask tick;
        // because the SQL UPDATE uses an absolute value computed in JS,
        // late writers overwrite earlier ones.
        await Promise.all(
            Array.from({ length: N }, () =>
                account.addPoints(userId, amount, 'test', 'race-documentation')
            )
        );

        const final = __testStore.userStats.get(userId).points_balance;

        // Headline assertion: today's read-compute-write code path LOSES
        // updates. final is STRICTLY LESS than what an atomic increment
        // would produce. When Phase 5 lands `UPDATE … SET balance =
        // balance + ?`, flip this to `toBe(expectedIfAtomic)`.
        expect(final).toBeLessThan(expectedIfAtomic);

        // Belt-and-braces: at least one call's amount survived, so the
        // bug is "lost updates" rather than "no updates land at all."
        expect(final).toBeGreaterThan(0);
    });

    test('subtractPoints LOSES POINTS under concurrent calls (same race shape)', async () => {
        const account = new AccountService();
        const userId = 99;

        // Seed a fat balance so all subtractions can succeed without
        // hitting any insufficient-balance branch (there isn't one in
        // the current code — that's a separate issue worth fixing in
        // the same Phase 5 atomic UPDATE).
        const seed = 10_000;
        __testStore.userStats.set(userId, { user_id: userId, points_balance: seed });

        const N = 20;
        const amount = 5;
        const expectedIfAtomic = seed - N * amount; // 9900

        await Promise.all(
            Array.from({ length: N }, () =>
                account.subtractPoints(userId, amount, 'test', 'race-documentation')
            )
        );

        const final = __testStore.userStats.get(userId).points_balance;

        // Same shape as addPoints: late writers overwrite earlier ones,
        // so `final` is HIGHER than the atomic-arithmetic answer.
        expect(final).toBeGreaterThan(expectedIfAtomic);
        // Sanity: the seed wasn't completely untouched.
        expect(final).toBeLessThan(seed);
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
