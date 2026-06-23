const BuffRepository = require('../../../database/repository/BuffRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new BuffRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('BuffRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
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
    // CRUD
    // ============================================================

    describe('insertBuff', () => {
        it('INSERTs 7 columns; uses `duration` for BOTH duration_seconds and remaining_seconds', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 42, changes: 1 });

            const result = await repo.insertBuff({
                userId: 9,
                itemId: 7,
                appliedByUserId: 9,
                buffType: 'positive',
                duration: 600,
                metadata: '{"src":"shop"}',
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO active_buffs ( user_id, item_id, applied_by_user_id, buff_type, duration_seconds, remaining_seconds, metadata ) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            // duration is bound twice (duration_seconds + remaining_seconds).
            expect(params).toEqual([9, 7, 9, 'positive', 600, 600, '{"src":"shop"}']);
            expect(result).toEqual({ id: 42, changes: 1 });
        });

        it('passes null metadata through verbatim (caller pre-stringifies or passes null)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertBuff({
                userId: 1, itemId: 1, appliedByUserId: 1,
                buffType: 'negative', duration: 30, metadata: null,
            });
            const [, params] = runAsync.mock.calls[0];
            expect(params[6]).toBeNull();
        });
    });

    describe('getById', () => {
        it('SELECTs raw active_buffs row by id (no JOIN)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 42, user_id: 9 });
            const row = await repo.getById(42);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM active_buffs WHERE id = ?');
            expect(params).toEqual([42]);
            expect(row).toEqual({ id: 42, user_id: 9 });
        });
    });

    describe('getByIdWithItem', () => {
        it('SELECTs ab.* + item display columns via JOIN', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 42, item_name: 'speed_boost' });
            await repo.getByIdWithItem(42);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data ' +
                'FROM active_buffs ab JOIN items i ON ab.item_id = i.id WHERE ab.id = ?'
            );
            expect(params).toEqual([42]);
        });
    });

    describe('updateRemainingSeconds', () => {
        it('UPDATEs remaining_seconds + bumps last_updated', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.updateRemainingSeconds(42, 300);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE active_buffs SET remaining_seconds = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?'
            );
            // remainingSeconds is the LEADING param, id is the trailing param.
            expect(params).toEqual([300, 42]);
        });
    });

    describe('markInactive', () => {
        it('UPDATEs is_active=0 + remaining_seconds=0 + bumps last_updated', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.markInactive(42);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE active_buffs SET is_active = 0, remaining_seconds = 0, last_updated = CURRENT_TIMESTAMP WHERE id = ?'
            );
            expect(params).toEqual([42]);
        });
    });

    describe('incrementStreamingTime', () => {
        it('uses relative arithmetic (streaming_time_used + 1) so the statement is single-shot', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.incrementStreamingTime(42);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE active_buffs SET streaming_time_used = streaming_time_used + 1 WHERE id = ?'
            );
            expect(params).toEqual([42]);
        });
    });

    // ============================================================
    // Listings
    // ============================================================

    describe('listActiveWithItems', () => {
        it('SELECTs active rows + JOIN items; no ORDER BY (cache builder)', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1 }]);
            const rows = await repo.listActiveWithItems();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data ' +
                'FROM active_buffs ab JOIN items i ON ab.item_id = i.id ' +
                'WHERE ab.is_active = 1 AND ab.remaining_seconds > 0'
            );
            expect(params).toBeUndefined();
            expect(rows).toHaveLength(1);
        });
    });

    describe('listActiveForUser', () => {
        it('SELECTs active rows for one user + JOIN items ORDER BY applied_at DESC', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listActiveForUser(9);
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data ' +
                'FROM active_buffs ab JOIN items i ON ab.item_id = i.id ' +
                'WHERE ab.user_id = ? AND ab.is_active = 1 AND ab.remaining_seconds > 0 ' +
                'ORDER BY ab.applied_at DESC'
            );
            expect(params).toEqual([9]);
        });
    });

    describe('getActiveByUserAndItem', () => {
        it('returns the most-recent active buff for (user, item)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 42 });
            await repo.getActiveByUserAndItem(9, 7);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM active_buffs WHERE user_id = ? AND item_id = ? ' +
                'AND is_active = 1 AND remaining_seconds > 0 ' +
                'ORDER BY applied_at DESC LIMIT 1'
            );
            expect(params).toEqual([9, 7]);
        });
    });

    describe('findExpired', () => {
        it('SELECTs id-only for buffs still flagged active but with remaining_seconds <= 0', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1 }, { id: 2 }]);
            const rows = await repo.findExpired();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT id FROM active_buffs WHERE is_active = 1 AND remaining_seconds <= 0'
            );
            expect(params).toBeUndefined();
            expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
        });
    });

    // ============================================================
    // Analytics
    // ============================================================

    describe('getStatsLast7Days', () => {
        it('GROUPs by item over the last 7 days with the documented aggregate set', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.getStatsLast7Days();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT i.name, i.display_name, i.emoji, i.item_type as buff_type, ' +
                'COUNT(*) as total_applications, ' +
                'COUNT(DISTINCT ab.user_id) as unique_users, ' +
                'AVG(ab.duration_seconds) as avg_duration, ' +
                'AVG(ab.streaming_time_used) as avg_streaming_time_used ' +
                'FROM active_buffs ab JOIN items i ON ab.item_id = i.id ' +
                "WHERE ab.applied_at >= datetime('now', '-7 days') " +
                'GROUP BY ab.item_id ORDER BY total_applications DESC'
            );
            expect(params).toBeUndefined();
        });
    });

    // ============================================================
    // Constructor / dep injection
    // ============================================================

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new BuffRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new BuffRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
