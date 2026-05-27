const AdminReviewSettingsRepository = require('../../../database/repository/AdminReviewSettingsRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new AdminReviewSettingsRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('AdminReviewSettingsRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
    let savedFlag;
    beforeAll(() => {
        savedFlag = process.env.USE_BETTER_SQLITE3;
        process.env.USE_BETTER_SQLITE3 = flag;
    });
    afterAll(() => {
        if (savedFlag === undefined) delete process.env.USE_BETTER_SQLITE3;
        else process.env.USE_BETTER_SQLITE3 = savedFlag;
    });

    describe('listAll', () => {
        it('SELECTs every row; no params', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([
                { key: 'retention_days', value: '3' },
                { key: 'upload_enabled', value: 'true' },
            ]);
            const rows = await repo.listAll();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM admin_review_settings');
            expect(params).toBeUndefined();
            expect(rows).toHaveLength(2);
        });
    });

    describe('upsertSetting', () => {
        it('INSERT ... ON CONFLICT DO UPDATE, value bound twice (matches legacy SQL)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.upsertSetting('retention_days', '3');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO admin_review_settings (key, value, updated_at) ' +
                'VALUES (?, ?, CURRENT_TIMESTAMP) ' +
                'ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP'
            );
            // key, value, value — the third param is the conflict-branch re-bind.
            expect(params).toEqual(['retention_days', '3', '3']);
        });

        it('same SQL string regardless of key (key is parameterized, not literal)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.upsertSetting('retention_days', '3');
            await repo.upsertSetting('upload_enabled', 'true');
            await repo.upsertSetting('local_buffer_hours', '12');
            const sqls = runAsync.mock.calls.map(c => c[0]);
            expect(sqls[0]).toBe(sqls[1]);
            expect(sqls[1]).toBe(sqls[2]);
            expect(runAsync.mock.calls[0][1]).toEqual(['retention_days', '3', '3']);
            expect(runAsync.mock.calls[1][1]).toEqual(['upload_enabled', 'true', 'true']);
            expect(runAsync.mock.calls[2][1]).toEqual(['local_buffer_hours', '12', '12']);
        });
    });

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new AdminReviewSettingsRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new AdminReviewSettingsRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
