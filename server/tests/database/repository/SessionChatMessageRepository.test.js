const SessionChatMessageRepository = require('../../../database/repository/SessionChatMessageRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new SessionChatMessageRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('SessionChatMessageRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
    let savedFlag;
    beforeAll(() => {
        savedFlag = process.env.USE_BETTER_SQLITE3;
        process.env.USE_BETTER_SQLITE3 = flag;
    });
    afterAll(() => {
        if (savedFlag === undefined) delete process.env.USE_BETTER_SQLITE3;
        else process.env.USE_BETTER_SQLITE3 = savedFlag;
    });

    describe('listBySession', () => {
        it('session_id only → SELECT * with no time fragments, ORDER ASC', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listBySession('sess_20260527');
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM session_chat_messages WHERE session_id = ? ORDER BY relative_time_ms ASC'
            );
            expect(params).toEqual(['sess_20260527']);
        });

        it('fromMs only → adds the >= fragment with the from value', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listBySession('sess_20260527', { fromMs: 1000 });
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM session_chat_messages WHERE session_id = ? ' +
                'AND relative_time_ms >= ? ORDER BY relative_time_ms ASC'
            );
            expect(params).toEqual(['sess_20260527', 1000]);
        });

        it('toMs only → adds the <= fragment with the to value', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listBySession('sess_20260527', { toMs: 5000 });
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM session_chat_messages WHERE session_id = ? ' +
                'AND relative_time_ms <= ? ORDER BY relative_time_ms ASC'
            );
            expect(params).toEqual(['sess_20260527', 5000]);
        });

        it('both bounds → both fragments in from-then-to order', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listBySession('sess_20260527', { fromMs: 1000, toMs: 5000 });
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM session_chat_messages WHERE session_id = ? ' +
                'AND relative_time_ms >= ? AND relative_time_ms <= ? ' +
                'ORDER BY relative_time_ms ASC'
            );
            expect(params).toEqual(['sess_20260527', 1000, 5000]);
        });

        it('fromMs=0 is treated as a real bound (not falsy-skipped)', async () => {
            // Critical for "show me messages from the recording start (offset 0)"
            // — the legacy `if (fromMs)` check would have dropped this. The
            // repo guards on `!== undefined && !== null` so 0 is kept.
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listBySession('sess', { fromMs: 0 });
            const [sql, params] = allAsync.mock.calls[0];
            expect(sql).toContain('AND relative_time_ms >= ?');
            expect(params).toEqual(['sess', 0]);
        });
    });

    describe('countBySessionIds', () => {
        it('builds an IN (?,?,...) clause sized to the sessionIds array', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ count: 9 });
            await repo.countBySessionIds(['sess_a', 'sess_b', 'sess_c']);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT COUNT(*) as count FROM session_chat_messages WHERE session_id IN (?,?,?)'
            );
            expect(params).toEqual(['sess_a', 'sess_b', 'sess_c']);
        });

        it('short-circuits to { count: 0 } without hitting the DB on empty array', async () => {
            const { repo, getAsync } = makeRepo();
            const row = await repo.countBySessionIds([]);
            expect(row).toEqual({ count: 0 });
            expect(getAsync).not.toHaveBeenCalled();
        });

        it('short-circuits to { count: 0 } on null/undefined input', async () => {
            const { repo, getAsync } = makeRepo();
            expect(await repo.countBySessionIds(null)).toEqual({ count: 0 });
            expect(await repo.countBySessionIds(undefined)).toEqual({ count: 0 });
            expect(getAsync).not.toHaveBeenCalled();
        });
    });

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new SessionChatMessageRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new SessionChatMessageRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
