/**
 * Shared withTransaction contract suite (ADR-0015).
 *
 * Extracted from the former transaction.test.js so the better-sqlite3 and
 * node-sqlite3 legs can run in SEPARATE jest processes. The two native SQLite
 * bindings (better-sqlite3, node-sqlite3) corrupt each other's error handling
 * when loaded in the same process — better-sqlite3 stops throwing on errors —
 * so:
 *   - the better-sqlite3 leg lives in `transaction.bettersqlite.test.js`, run
 *     by `config/jest/jest.bettersqlite.config.js` (a process that never loads
 *     node-sqlite3);
 *   - the node-sqlite3 leg lives in `transaction.sqlite3.test.js`, run by the
 *     main `jest.config.js` alongside the other node-sqlite3 prod-path tests.
 * Both call `defineWithTransactionContract()` so the test bodies stay DRY.
 *
 * Not named `*.test.js`, so jest never collects this file directly.
 */
const { createWithTransaction } = require('../../database/transaction');

/**
 * @param {'true'|'false'} flag  value to pin USE_BETTER_SQLITE3 to for the scope
 * @param {() => {db, runAsync, getAsync, allAsync, close}} makePrimitives
 *        backend factory over a fresh `:memory:` connection
 */
function defineWithTransactionContract(flag, makePrimitives) {
    describe(`withTransaction (USE_BETTER_SQLITE3=${flag})`, () => {
        let savedFlag;
        let primitives;
        let withTransaction;

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
            withTransaction = createWithTransaction({
                runAsync: primitives.runAsync,
                getAsync: primitives.getAsync,
                allAsync: primitives.allAsync,
            });
            await primitives.runAsync(`
                CREATE TABLE t (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    v INTEGER NOT NULL
                )
            `);
        });

        afterEach(async () => {
            await primitives.close();
        });

        describe('happy path', () => {
            it('runs body inside BEGIN IMMEDIATE … COMMIT and persists side effects', async () => {
                await withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [1]);
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [2]);
                });
                const rows = await primitives.allAsync('SELECT v FROM t ORDER BY v');
                expect(rows.map((r) => r.v)).toEqual([1, 2]);
            });

            it('returns the body fn\'s resolved value', async () => {
                const got = await withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [42]);
                    const row = await tx.getAsync('SELECT v FROM t WHERE v = ?', [42]);
                    return row.v;
                });
                expect(got).toBe(42);
            });

            it('exposes runAsync, getAsync, allAsync on the tx arg', async () => {
                const got = await withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [10]);
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [20]);
                    const single = await tx.getAsync('SELECT v FROM t WHERE v = ?', [10]);
                    const many = await tx.allAsync('SELECT v FROM t ORDER BY v');
                    return { single: single.v, many: many.map((r) => r.v) };
                });
                expect(got).toEqual({ single: 10, many: [10, 20] });
            });
        });

        describe('rollback', () => {
            it('rolls back when the body throws and re-throws the error', async () => {
                const err = new Error('forced');
                await expect(
                    withTransaction(async (tx) => {
                        await tx.runAsync('INSERT INTO t (v) VALUES (?)', [99]);
                        throw err;
                    })
                ).rejects.toBe(err);
                const rows = await primitives.allAsync('SELECT v FROM t');
                expect(rows).toEqual([]);
            });

            it('rolls back when a body statement throws (e.g. constraint violation)', async () => {
                await primitives.runAsync('CREATE UNIQUE INDEX ux_t_v ON t(v)');
                await primitives.runAsync('INSERT INTO t (v) VALUES (?)', [7]);
                await expect(
                    withTransaction(async (tx) => {
                        await tx.runAsync('INSERT INTO t (v) VALUES (?)', [8]);
                        await tx.runAsync('INSERT INTO t (v) VALUES (?)', [7]); // dup
                    })
                ).rejects.toThrow();
                const rows = await primitives.allAsync('SELECT v FROM t ORDER BY v');
                expect(rows.map((r) => r.v)).toEqual([7]); // only the pre-tx row survives
            });

            it('still works after a rollback (mutex released, next scope opens cleanly)', async () => {
                await expect(
                    withTransaction(async (tx) => {
                        await tx.runAsync('INSERT INTO t (v) VALUES (?)', [1]);
                        throw new Error('boom');
                    })
                ).rejects.toThrow('boom');
                await withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [2]);
                });
                const rows = await primitives.allAsync('SELECT v FROM t');
                expect(rows.map((r) => r.v)).toEqual([2]);
            });
        });

        describe('serialization (mutex)', () => {
            it('two concurrent scopes run sequentially — second waits for first to commit', async () => {
                // Order log: each scope writes its label twice with a microtask
                // yield between writes. Without the mutex, the labels would
                // interleave (A,B,A,B). With the mutex, scopes serialize
                // (A,A,B,B).
                const order = [];
                const scopeA = withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [1]);
                    order.push('A1');
                    await new Promise((r) => setImmediate(r));
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [2]);
                    order.push('A2');
                });
                const scopeB = withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [3]);
                    order.push('B1');
                    await new Promise((r) => setImmediate(r));
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [4]);
                    order.push('B2');
                });
                await Promise.all([scopeA, scopeB]);
                expect(order).toEqual(['A1', 'A2', 'B1', 'B2']);
                const rows = await primitives.allAsync('SELECT v FROM t ORDER BY v');
                expect(rows.map((r) => r.v)).toEqual([1, 2, 3, 4]);
            });

            it('if scope A throws, scope B still runs (mutex released on error)', async () => {
                const scopeA = withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [1]);
                    throw new Error('A failed');
                }).catch(() => 'A-rejected');
                const scopeB = withTransaction(async (tx) => {
                    await tx.runAsync('INSERT INTO t (v) VALUES (?)', [2]);
                    return 'B-ok';
                });
                const [aResult, bResult] = await Promise.all([scopeA, scopeB]);
                expect(aResult).toBe('A-rejected');
                expect(bResult).toBe('B-ok');
                const rows = await primitives.allAsync('SELECT v FROM t');
                expect(rows.map((r) => r.v)).toEqual([2]); // A rolled back, B committed
            });
        });

        describe('busy_timeout', () => {
            it('applies the requested busy_timeout for the scope and restores the prior value on success', async () => {
                await primitives.runAsync('PRAGMA busy_timeout = 3000');
                await withTransaction(async (tx) => {
                    const row = await tx.getAsync('PRAGMA busy_timeout');
                    expect(row.timeout).toBe(250);
                }, { busyTimeoutMs: 250 });
                const after = await primitives.getAsync('PRAGMA busy_timeout');
                expect(after.timeout).toBe(3000);
            });

            it('restores the prior busy_timeout even when the body throws', async () => {
                await primitives.runAsync('PRAGMA busy_timeout = 7000');
                await expect(
                    withTransaction(async (tx) => {
                        const row = await tx.getAsync('PRAGMA busy_timeout');
                        expect(row.timeout).toBe(250);
                        throw new Error('boom');
                    }, { busyTimeoutMs: 250 })
                ).rejects.toThrow('boom');
                const after = await primitives.getAsync('PRAGMA busy_timeout');
                expect(after.timeout).toBe(7000);
            });
        });
    });
}

module.exports = { defineWithTransactionContract };
