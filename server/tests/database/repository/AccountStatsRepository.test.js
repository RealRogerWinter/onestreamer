const AccountStatsRepository = require('../../../database/repository/AccountStatsRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new AccountStatsRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('AccountStatsRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
    let savedFlag;
    beforeAll(() => {
        savedFlag = process.env.USE_BETTER_SQLITE3;
        process.env.USE_BETTER_SQLITE3 = flag;
    });
    afterAll(() => {
        if (savedFlag === undefined) delete process.env.USE_BETTER_SQLITE3;
        else process.env.USE_BETTER_SQLITE3 = savedFlag;
    });

    // ============================================================
    // user_stats
    // ============================================================

    describe('insertEmptyStats', () => {
        it('INSERTs (user_id) only; defaults to 0 for points_balance + counters', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.insertEmptyStats(7);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('INSERT INTO user_stats (user_id) VALUES (?)');
            expect(params).toEqual([7]);
        });
    });

    describe('insertStatsWithBalance', () => {
        it('INSERTs (user_id, points_balance) — used by the atomicAddPoints fallback', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.insertStatsWithBalance({ userId: 7, balance: 100 });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO user_stats (user_id, points_balance) VALUES (?, ?)'
            );
            expect(params).toEqual([7, 100]);
        });
    });

    describe('updateStats', () => {
        it('appends updated_at=CURRENT_TIMESTAMP + WHERE-by-user_id, trails user_id in params', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.updateStats(
                7,
                ['total_stream_time = total_stream_time + ?', 'last_stream_at = ?'],
                [300, '2026-05-27T12:00:00Z'],
            );
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE user_stats SET total_stream_time = total_stream_time + ?, ' +
                'last_stream_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
            );
            // user_id is the trailing param.
            expect(params).toEqual([300, '2026-05-27T12:00:00Z', 7]);
        });

        it('empty setFragments → no DB call, returns { changes: 0 }', async () => {
            const { repo, runAsync } = makeRepo();
            const res = await repo.updateStats(7, [], []);
            expect(res).toEqual({ changes: 0 });
            expect(runAsync).not.toHaveBeenCalled();
        });
    });

    describe('getStatsByUserId', () => {
        it('SELECTs the full user_stats row', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ user_id: 7, points_balance: 50 });
            await repo.getStatsByUserId(7);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM user_stats WHERE user_id = ?');
            expect(params).toEqual([7]);
        });
    });

    describe('getPointsBalanceByUserId', () => {
        it('SELECTs points_balance only (used by error-message disambiguation)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ points_balance: 25 });
            await repo.getPointsBalanceByUserId(7);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT points_balance FROM user_stats WHERE user_id = ?'
            );
            expect(params).toEqual([7]);
        });
    });

    describe('atomicAddPoints', () => {
        it('UPDATE … SET points_balance = points_balance + ? … RETURNING points_balance (ADR-0013a shape)', async () => {
            // This is the regression gate for the PR 5.1 / ADR-0013a atomic
            // counter. ANY change that turns this into read-compute-write
            // reintroduces the lost-update race. Fail loudly if so.
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ points_balance: 150 });
            await repo.atomicAddPoints({ userId: 7, amount: 50 });
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE user_stats SET points_balance = points_balance + ?, ' +
                'updated_at = CURRENT_TIMESTAMP WHERE user_id = ? RETURNING points_balance'
            );
            // amount first, user_id second — order matches legacy.
            expect(params).toEqual([50, 7]);
        });
    });

    describe('atomicSubtractPoints', () => {
        it('UPDATE … SET points_balance = points_balance - ? … AND points_balance >= ? … RETURNING (guarded debit)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ points_balance: 50 });
            await repo.atomicSubtractPoints({ userId: 7, amount: 100 });
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE user_stats SET points_balance = points_balance - ?, ' +
                'updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND points_balance >= ? ' +
                'RETURNING points_balance'
            );
            // amount, user_id, amount — the third bind is the guard's lower-bound.
            expect(params).toEqual([100, 7, 100]);
        });

        it('amount is bound twice (the third param is the guard, not a separate value)', async () => {
            // Pin the bind-shape — if someone "tidies" the SQL by passing
            // amount once, the guard breaks silently (the prepared statement
            // would still execute, but with stale/undefined-comparison
            // semantics).
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ points_balance: 0 });
            await repo.atomicSubtractPoints({ userId: 7, amount: 42 });
            const [, params] = getAsync.mock.calls[0];
            expect(params[0]).toBe(42);
            expect(params[2]).toBe(42);
            expect(params[0]).toBe(params[2]);
        });
    });

    describe('deleteStatsByUserId', () => {
        it('DELETEs the user_stats row', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.deleteStatsByUserId(7);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM user_stats WHERE user_id = ?');
            expect(params).toEqual([7]);
        });
    });

    // ============================================================
    // points_transactions
    // ============================================================

    describe('insertTransaction', () => {
        it('INSERTs the 6-column audit row; metadataJson passes through unchanged', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertTransaction({
                userId: 7,
                amount: 50,
                balanceAfter: 150,
                type: 'bonus',
                description: 'daily bonus',
                metadataJson: '{"source":"daily"}',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO points_transactions ' +
                '(user_id, amount, balance_after, type, description, metadata) ' +
                'VALUES (?, ?, ?, ?, ?, ?)'
            );
            expect(params).toEqual([7, 50, 150, 'bonus', 'daily bonus', '{"source":"daily"}']);
        });

        it('accepts null metadataJson (no metadata case)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertTransaction({
                userId: 7, amount: -10, balanceAfter: 90,
                type: 'purchase', description: 'buy item', metadataJson: null,
            });
            const [, params] = runAsync.mock.calls[0];
            expect(params[5]).toBeNull();
        });
    });

    describe('listTransactionsByUserId', () => {
        it('SELECTs full rows ordered by created_at DESC with LIMIT', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listTransactionsByUserId(7, 50);
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM points_transactions WHERE user_id = ? ' +
                'ORDER BY created_at DESC LIMIT ?'
            );
            expect(params).toEqual([7, 50]);
        });
    });

    // ============================================================
    // Constructor / dep injection
    // ============================================================

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new AccountStatsRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new AccountStatsRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
