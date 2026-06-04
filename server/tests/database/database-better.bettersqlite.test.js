/**
 * Adapter contract tests for the better-sqlite3 backend (ADR-0014).
 *
 * The 357 consumers of `runAsync` / `getAsync` / `allAsync` have an
 * implicit contract built up over years against the sqlite3 binding:
 *
 *   - runAsync resolves with `{id, changes}` where `id` is `lastInsertRowid`
 *     (an integer for AUTOINCREMENT tables, undefined otherwise).
 *   - getAsync resolves with the first row (object), or `undefined` on
 *     no-match. UPDATE/INSERT/DELETE ... RETURNING is consumed via getAsync.
 *   - allAsync resolves with an array of rows. Empty array on no-match.
 *
 * Anything the adapter does differently is a hazard at swap time. This
 * file pins the contract.
 */

const path = require('path');
const { createBetterSqlite3Adapter } = require('../../database/database-better');

describe('better-sqlite3 adapter — contract', () => {
    let adapter;

    beforeEach(() => {
        adapter = createBetterSqlite3Adapter(':memory:');
        adapter.db.exec(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                points_balance INTEGER DEFAULT 0,
                label TEXT
            );
            CREATE TABLE no_pk (
                key TEXT,
                value INTEGER
            );
        `);
    });

    afterEach(() => {
        adapter.close();
    });

    describe('runAsync', () => {
        test('INSERT resolves with {id, changes}', async () => {
            const result = await adapter.runAsync(
                'INSERT INTO t (user_id, points_balance, label) VALUES (?, ?, ?)',
                [1, 100, 'first']
            );
            expect(result.changes).toBe(1);
            expect(result.id).toBe(1);
        });

        test('UPDATE resolves with changes count, id = lastInsertRowid (0 for non-INSERT)', async () => {
            await adapter.runAsync('INSERT INTO t (user_id, points_balance) VALUES (?, ?)', [1, 50]);
            await adapter.runAsync('INSERT INTO t (user_id, points_balance) VALUES (?, ?)', [1, 50]);
            const result = await adapter.runAsync(
                'UPDATE t SET points_balance = ? WHERE user_id = ?',
                [99, 1]
            );
            expect(result.changes).toBe(2);
            // better-sqlite3 returns lastInsertRowid = 0 on UPDATEs (no new row).
            // sqlite3 returns the rowid of the LAST INSERT ever on this handle.
            // Callers that consume runAsync's `id` after an UPDATE are buggy on
            // either backend — neither value is meaningful — so the test pins
            // that the field exists and is a number; it doesn't pin a value.
            expect(typeof result.id).toBe('number');
        });

        test('DELETE resolves with changes count', async () => {
            await adapter.runAsync('INSERT INTO t (user_id) VALUES (?)', [1]);
            await adapter.runAsync('INSERT INTO t (user_id) VALUES (?)', [2]);
            const result = await adapter.runAsync('DELETE FROM t WHERE user_id = ?', [1]);
            expect(result.changes).toBe(1);
        });

        test('rejects on SQL syntax error', async () => {
            // better-sqlite3 throws synchronously inside db.prepare(), which
            // the adapter wraps in a try/catch and converts to Promise.reject.
            // Deterministic — no flake from shared state across tests.
            await expect(adapter.runAsync('NOT SQL', [])).rejects.toThrow();
        });

        test('zero-param call works without throwing on params spread', async () => {
            const result = await adapter.runAsync(`INSERT INTO no_pk (key, value) VALUES ('k', 1)`);
            expect(result.changes).toBe(1);
        });
    });

    describe('getAsync', () => {
        test('SELECT first row resolves with the row object', async () => {
            await adapter.runAsync('INSERT INTO t (user_id, points_balance) VALUES (?, ?)', [42, 500]);
            const row = await adapter.getAsync('SELECT * FROM t WHERE user_id = ?', [42]);
            expect(row).toMatchObject({ user_id: 42, points_balance: 500 });
        });

        test('SELECT with no match resolves with undefined (not null)', async () => {
            const row = await adapter.getAsync('SELECT * FROM t WHERE user_id = ?', [999]);
            expect(row).toBeUndefined();
        });

        test('UPDATE ... RETURNING resolves with the returning row (PR 5.1 contract)', async () => {
            await adapter.runAsync('INSERT INTO t (user_id, points_balance) VALUES (?, ?)', [7, 10]);
            const row = await adapter.getAsync(
                'UPDATE t SET points_balance = points_balance + ? WHERE user_id = ? RETURNING points_balance',
                [5, 7]
            );
            expect(row).toEqual({ points_balance: 15 });
        });

        test('UPDATE ... RETURNING with no match resolves with undefined', async () => {
            const row = await adapter.getAsync(
                'UPDATE t SET points_balance = points_balance + ? WHERE user_id = ? RETURNING points_balance',
                [5, 999]
            );
            expect(row).toBeUndefined();
        });

        test('Guarded UPDATE ... RETURNING with floor that fails resolves undefined (PR 5.1 subtract contract)', async () => {
            await adapter.runAsync('INSERT INTO t (user_id, points_balance) VALUES (?, ?)', [7, 10]);
            const row = await adapter.getAsync(
                'UPDATE t SET points_balance = points_balance - ? WHERE user_id = ? AND points_balance >= ? RETURNING points_balance',
                [100, 7, 100]
            );
            expect(row).toBeUndefined();
        });
    });

    describe('allAsync', () => {
        test('SELECT * returns an array of rows', async () => {
            await adapter.runAsync('INSERT INTO t (user_id, label) VALUES (?, ?)', [1, 'a']);
            await adapter.runAsync('INSERT INTO t (user_id, label) VALUES (?, ?)', [1, 'b']);
            await adapter.runAsync('INSERT INTO t (user_id, label) VALUES (?, ?)', [2, 'c']);
            const rows = await adapter.allAsync('SELECT label FROM t WHERE user_id = ? ORDER BY id', [1]);
            expect(rows).toEqual([{ label: 'a' }, { label: 'b' }]);
        });

        test('SELECT with no match returns empty array (not undefined, not null)', async () => {
            const rows = await adapter.allAsync('SELECT * FROM t WHERE user_id = ?', [999]);
            expect(rows).toEqual([]);
        });
    });

    describe('prepared-statement cache', () => {
        test('repeated identical SQL hits the cache', async () => {
            await adapter.runAsync('INSERT INTO t (user_id) VALUES (?)', [1]);
            const statsAfterFirst = adapter.cacheStats();
            await adapter.runAsync('INSERT INTO t (user_id) VALUES (?)', [1]);
            await adapter.runAsync('INSERT INTO t (user_id) VALUES (?)', [1]);
            const statsAfter = adapter.cacheStats();
            // First call: miss. Two subsequent calls with the same SQL: hits.
            expect(statsAfter.hits - statsAfterFirst.hits).toBe(2);
            // Cache size shouldn't grow on hits.
            expect(statsAfter.size).toBe(statsAfterFirst.size);
        });

        test('different SQL strings populate distinct cache entries', async () => {
            await adapter.runAsync('INSERT INTO t (user_id) VALUES (?)', [1]);
            await adapter.runAsync('INSERT INTO t (user_id, label) VALUES (?, ?)', [2, 'x']);
            const stats = adapter.cacheStats();
            expect(stats.size).toBeGreaterThanOrEqual(2);
        });

        test('cache respects stmtCacheLimit (insertion-order eviction)', async () => {
            const small = createBetterSqlite3Adapter(':memory:', { stmtCacheLimit: 2 });
            try {
                small.db.exec('CREATE TABLE x (n INTEGER)');
                await small.runAsync('INSERT INTO x (n) VALUES (1)');
                await small.runAsync('INSERT INTO x (n) VALUES (2)');
                await small.runAsync('INSERT INTO x (n) VALUES (3)');
                // Cache is at capacity (2); the oldest SQL has been evicted.
                expect(small.cacheStats().size).toBe(2);
            } finally {
                small.close();
            }
        });
    });

    describe('PRAGMAs match the applyPragmas.js contract', () => {
        test('journal_mode=WAL applied', () => {
            // :memory: doesn't support WAL — it stays in "memory" mode. To
            // verify the WAL pragma, open against a real file.
            const tmpFile = path.join(require('os').tmpdir(),
                `better-sqlite3-test-${process.pid}-${Date.now()}.db`);
            const fileAdapter = createBetterSqlite3Adapter(tmpFile);
            try {
                const mode = fileAdapter.db.pragma('journal_mode', { simple: true });
                expect(mode).toBe('wal');
                expect(fileAdapter.walActive).toBe(true);
            } finally {
                fileAdapter.close();
                require('fs').rmSync(tmpFile, { force: true });
                require('fs').rmSync(tmpFile + '-shm', { force: true });
                require('fs').rmSync(tmpFile + '-wal', { force: true });
            }
        });

        test('foreign_keys ON, busy_timeout 5000', () => {
            const fk = adapter.db.pragma('foreign_keys', { simple: true });
            const bt = adapter.db.pragma('busy_timeout', { simple: true });
            expect(fk).toBe(1);
            expect(bt).toBe(5000);
        });

        test('tuneForLargeReads applies mmap_size + cache_size when set', () => {
            // mmap_size and cache_size are only meaningful on file-backed
            // databases — :memory: silently ignores the writes.
            const tmpFile = path.join(require('os').tmpdir(),
                `better-sqlite3-tune-${process.pid}-${Date.now()}.db`);
            const tuned = createBetterSqlite3Adapter(tmpFile, { tuneForLargeReads: true });
            try {
                expect(tuned.db.pragma('mmap_size', { simple: true })).toBe(268435456);
                expect(tuned.db.pragma('cache_size', { simple: true })).toBe(-64000);
                expect(tuned.db.pragma('temp_store', { simple: true })).toBe(2); // MEMORY
            } finally {
                tuned.close();
                require('fs').rmSync(tmpFile, { force: true });
                require('fs').rmSync(tmpFile + '-shm', { force: true });
                require('fs').rmSync(tmpFile + '-wal', { force: true });
            }
        });
    });
});
