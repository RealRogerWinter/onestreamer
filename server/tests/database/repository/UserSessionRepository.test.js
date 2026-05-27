const UserSessionRepository = require('../../../database/repository/UserSessionRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new UserSessionRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('UserSessionRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
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
    // user_sessions
    // ============================================================

    describe('insertSession', () => {
        it('INSERTs (user_id, ip_address, expires_at) with the ISO timestamp pass-through', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 100, changes: 1 });
            await repo.insertSession({
                userId: 7,
                ipAddress: '1.2.3.4',
                expiresAtIso: '2026-05-28T12:00:00Z',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO user_sessions (user_id, ip_address, expires_at) VALUES (?, ?, ?)'
            );
            expect(params).toEqual([7, '1.2.3.4', '2026-05-28T12:00:00Z']);
        });
    });

    describe('getActiveSessionByUserId', () => {
        it('SELECTs newest non-expired session row (datetime(now) literal preserved)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 100, user_id: 7 });
            await repo.getActiveSessionByUserId(7);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "SELECT * FROM user_sessions WHERE user_id = ? AND expires_at > datetime('now') " +
                'ORDER BY created_at DESC LIMIT 1'
            );
            expect(params).toEqual([7]);
        });
    });

    describe('deleteSessionById', () => {
        it('DELETEs by row id (PK), not user_id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.deleteSessionById(100);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM user_sessions WHERE id = ?');
            expect(params).toEqual([100]);
        });
    });

    describe('deleteExpiredSessions', () => {
        it('DELETEs rows with expires_at < datetime(now); no params', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 9 });
            await repo.deleteExpiredSessions();
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "DELETE FROM user_sessions WHERE expires_at < datetime('now')"
            );
            expect(params).toBeUndefined();
        });
    });

    describe('deleteSessionsByUserId', () => {
        it('DELETEs every session for a user', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 2 });
            await repo.deleteSessionsByUserId(7);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM user_sessions WHERE user_id = ?');
            expect(params).toEqual([7]);
        });
    });

    // ============================================================
    // account_deletion_logs
    // ============================================================

    describe('insertDeletionLog', () => {
        it('INSERTs 7 columns; created_at = datetime(now) literal preserved', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertDeletionLog({
                userId: 7,
                username: 'alice',
                email: 'alice@example.com',
                action: 'deletion_requested',
                ipAddress: '1.2.3.4',
                userAgent: 'Mozilla/5.0',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO account_deletion_logs ' +
                '(user_id, username, email, action, ip_address, user_agent, created_at) ' +
                "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
            );
            // 6 placeholders → 6 params (created_at baked in).
            expect(params).toEqual([
                7, 'alice', 'alice@example.com', 'deletion_requested', '1.2.3.4', 'Mozilla/5.0',
            ]);
        });

        it('accepts null ipAddress + null userAgent (server-side action with no request context)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertDeletionLog({
                userId: 7, username: 'alice', email: 'a@x',
                action: 'data_purged', ipAddress: null, userAgent: null,
            });
            const [, params] = runAsync.mock.calls[0];
            expect(params[4]).toBeNull();
            expect(params[5]).toBeNull();
        });
    });

    // ============================================================
    // ip_to_user_transfers
    // ============================================================

    describe('insertIpTransfer', () => {
        it('INSERTs (user_id, ip_address, session_data) with pre-stringified JSON', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertIpTransfer({
                userId: 7,
                ipAddress: '1.2.3.4',
                sessionDataJson: '{"stats":{"viewTime":120}}',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO ip_to_user_transfers (user_id, ip_address, session_data) VALUES (?, ?, ?)'
            );
            expect(params).toEqual([7, '1.2.3.4', '{"stats":{"viewTime":120}}']);
        });
    });

    // ============================================================
    // Constructor / dep injection
    // ============================================================

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new UserSessionRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new UserSessionRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
