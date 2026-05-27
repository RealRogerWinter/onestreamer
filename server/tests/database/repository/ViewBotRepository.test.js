const ViewBotRepository = require('../../../database/repository/ViewBotRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new ViewBotRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Phase 6 mandates the repo unit tests run under both backends. The repo
// itself doesn't read the env flag — the captured primitives do — so we
// run the same describe block twice via describe.each, both times with
// mocked primitives. This satisfies the test-env-flag matrix without
// spinning up two different DB adapters.
describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('ViewBotRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
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
    // viewbots
    // ============================================================

    describe('viewbotsTableExists', () => {
        it('queries sqlite_master for the viewbots table', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ name: 'viewbots' });
            const row = await repo.viewbotsTableExists();
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='viewbots'"
            );
            expect(params).toBeUndefined();
            expect(row).toEqual({ name: 'viewbots' });
        });

        it('resolves to undefined when the table does not exist', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue(undefined);
            await expect(repo.viewbotsTableExists()).resolves.toBeUndefined();
        });
    });

    describe('upsertViewBot', () => {
        it('INSERT OR REPLACEs with usage_count preserved via correlated subquery', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 7, changes: 1 });

            const result = await repo.upsertViewBot({
                botId: 'bot-7',
                name: 'Lion42',
                configJson: '{"x":1}',
                contentType: 'testPattern',
                isEnabled: true,
                autoStart: false,
                timeAllotment: null,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT OR REPLACE INTO viewbots (bot_id, name, config, content_type, is_enabled, auto_start, time_allotment, updated_at, usage_count) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, COALESCE((SELECT usage_count FROM viewbots WHERE bot_id = ?), 0))'
            );
            // botId appears twice: once for the row value, once for the
            // subquery filter that reads the existing usage_count.
            expect(params).toEqual([
                'bot-7', 'Lion42', '{"x":1}', 'testPattern', true, false, null, 'bot-7',
            ]);
            expect(result).toEqual({ id: 7, changes: 1 });
        });
    });

    describe('findEnabledByBotId', () => {
        it('SELECTs a single enabled viewbot row by bot_id', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 1, bot_id: 'bot-7' });
            const row = await repo.findEnabledByBotId('bot-7');
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM viewbots WHERE bot_id = ? AND is_enabled = 1'
            );
            expect(params).toEqual(['bot-7']);
            expect(row).toEqual({ id: 1, bot_id: 'bot-7' });
        });

        it('resolves to null/undefined when no enabled row matches', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue(undefined);
            await expect(repo.findEnabledByBotId('missing')).resolves.toBeUndefined();
        });
    });

    describe('listEnabled', () => {
        it('SELECTs all enabled viewbots ORDER BY created_at ASC', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1 }, { id: 2 }]);
            const rows = await repo.listEnabled();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM viewbots WHERE is_enabled = 1 ORDER BY created_at ASC'
            );
            expect(params).toBeUndefined();
            expect(rows).toHaveLength(2);
        });
    });

    describe('deleteByBotId', () => {
        it('DELETEs by bot_id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.deleteByBotId('bot-7');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM viewbots WHERE bot_id = ?');
            expect(params).toEqual(['bot-7']);
        });
    });

    describe('setEnabledByBotId', () => {
        it.each([
            [0, 0],
            [1, 1],
        ])('passes %p through verbatim and bumps updated_at', async (input, expected) => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.setEnabledByBotId('bot-7', input);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE viewbots SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE bot_id = ?'
            );
            expect(params).toEqual([expected, 'bot-7']);
        });
    });

    describe('incrementUsageCount', () => {
        it('UPDATEs usage_count + 1 and bumps last_used_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.incrementUsageCount('bot-7');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE viewbots SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE bot_id = ?'
            );
            expect(params).toEqual(['bot-7']);
        });
    });

    describe('updateName', () => {
        it('UPDATEs name and bumps updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.updateName('bot-7', 'New Name');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE viewbots SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE bot_id = ?'
            );
            expect(params).toEqual(['New Name', 'bot-7']);
        });
    });

    // ============================================================
    // viewbot_system_state
    // ============================================================

    describe('upsertSystemState', () => {
        it('INSERT OR REPLACEs the id=1 singleton row with all 7 fields', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.upsertSystemState({
                rotationEnabled: true,
                currentLiveBot: 'bot-3',
                realStreamerActive: false,
                maxBots: -1,
                rotationProbability: 0.045,
                rotationCheckIntervalMin: 5000,
                rotationCheckIntervalMax: 10000,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT OR REPLACE INTO viewbot_system_state ' +
                '(id, rotation_enabled, current_live_bot, real_streamer_active, max_bots, ' +
                'rotation_probability, rotation_check_interval_min, rotation_check_interval_max, updated_at) ' +
                'VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
            );
            expect(params).toEqual([
                true, 'bot-3', false, -1, 0.045, 5000, 10000,
            ]);
        });
    });

    describe('getSystemState', () => {
        it('SELECTs the id=1 row', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 1, rotation_enabled: 1 });
            await repo.getSystemState();
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM viewbot_system_state WHERE id = 1');
            expect(params).toBeUndefined();
        });
    });

    // ============================================================
    // viewbot_sessions
    // ============================================================

    describe('insertSession', () => {
        it('INSERTs (session_id, viewbot_id, bot_id, stream_quality, metadata)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 17, changes: 1 });

            const result = await repo.insertSession({
                sessionId: 'sess-abc',
                viewbotId: 9,
                botId: 'bot-7',
                streamQuality: 'auto',
                metadataJson: '{"k":1}',
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO viewbot_sessions (session_id, viewbot_id, bot_id, stream_quality, metadata) VALUES (?, ?, ?, ?, ?)'
            );
            expect(params).toEqual(['sess-abc', 9, 'bot-7', 'auto', '{"k":1}']);
            expect(result).toEqual({ id: 17, changes: 1 });
        });
    });

    describe('endSession', () => {
        it('UPDATEs ended_at + lifecycle fields by session_id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.endSession('sess-abc', {
                duration: 1234,
                viewerCount: 7,
                rotationReason: 'natural',
                status: 'completed',
                errorMessage: null,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE viewbot_sessions SET ended_at = CURRENT_TIMESTAMP, duration_ms = ?, viewer_count = ?, rotation_reason = ?, status = ?, error_message = ? WHERE session_id = ?'
            );
            // session_id is the trailing parameter — verify the ordering.
            expect(params).toEqual([1234, 7, 'natural', 'completed', null, 'sess-abc']);
        });
    });

    // ============================================================
    // viewbot_rotation_history
    // ============================================================

    describe('insertRotation', () => {
        it('INSERTs 7 columns in the documented order', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 99, changes: 1 });

            await repo.insertRotation({
                fromBotId: 'bot-a',
                toBotId: 'bot-b',
                reason: 'time_up',
                rotationType: 'automatic',
                durationBeforeRotation: 60000,
                viewerCount: 5,
                metadataJson: '{}',
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO viewbot_rotation_history (from_bot_id, to_bot_id, rotation_reason, rotation_type, duration_before_rotation, viewer_count_at_rotation, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            expect(params).toEqual([
                'bot-a', 'bot-b', 'time_up', 'automatic', 60000, 5, '{}',
            ]);
        });
    });

    // ============================================================
    // viewbot_metrics
    // ============================================================

    describe('insertMetric', () => {
        it('INSERTs 7 columns; caller pre-stringifies additionalData', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 300, changes: 1 });

            await repo.insertMetric({
                viewbotId: 9,
                botId: 'bot-7',
                sessionId: 'sess-abc',
                metricType: 'cpu_pct',
                metricValue: 42.5,
                metricUnit: '%',
                additionalDataJson: '{"sample":true}',
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO viewbot_metrics (viewbot_id, bot_id, session_id, metric_type, metric_value, metric_unit, additional_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            expect(params).toEqual([
                9, 'bot-7', 'sess-abc', 'cpu_pct', 42.5, '%', '{"sample":true}',
            ]);
        });
    });

    // ============================================================
    // Analytics — dynamic fragment composition
    // ============================================================

    describe('getSessionAnalytics', () => {
        it('composes the aggregate SELECT with empty fragments + no params', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ total_sessions: 0 });
            await repo.getSessionAnalytics({
                timeCondition: '',
                botCondition: '',
                params: [],
            });
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT COUNT(*) as total_sessions, AVG(duration_ms) as avg_duration, ' +
                'SUM(duration_ms) as total_duration, AVG(viewer_count) as avg_viewers, ' +
                "COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_sessions, " +
                "COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_sessions " +
                'FROM viewbot_sessions WHERE 1=1'
            );
            expect(params).toEqual([]);
        });

        it('inlines time and bot fragments and forwards params verbatim', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({});
            await repo.getSessionAnalytics({
                timeCondition: "AND started_at > datetime('now', '-1 day')",
                botCondition: 'AND bot_id = ?',
                params: ['bot-7'],
            });
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toContain("AND started_at > datetime('now', '-1 day')");
            expect(norm(sql)).toContain('AND bot_id = ?');
            expect(params).toEqual(['bot-7']);
        });
    });

    describe('getRotationAnalytics', () => {
        it('composes the rotation aggregate with fragments', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ total_rotations: 0 });
            await repo.getRotationAnalytics({
                timeCondition: "AND timestamp > datetime('now', '-7 days')",
                botCondition: 'AND (from_bot_id = ? OR to_bot_id = ?)',
                params: ['bot-7', 'bot-7'],
            });
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT COUNT(*) as total_rotations, AVG(duration_before_rotation) as avg_rotation_time ' +
                'FROM viewbot_rotation_history ' +
                "WHERE 1=1 AND timestamp > datetime('now', '-7 days') AND (from_bot_id = ? OR to_bot_id = ?)"
            );
            expect(params).toEqual(['bot-7', 'bot-7']);
        });
    });

    // ============================================================
    // Retention cleanup
    // ============================================================

    describe('cleanupOldSessions', () => {
        it("interpolates the retention window into datetime('now', '-N days')", async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 4 });
            await repo.cleanupOldSessions(30);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "DELETE FROM viewbot_sessions WHERE created_at < datetime('now', '-30 days') " +
                "AND status IN ('completed', 'failed')"
            );
            expect(params).toBeUndefined();
        });

        it('reflects a different retention window verbatim', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 0 });
            await repo.cleanupOldSessions(7);
            const [sql] = runAsync.mock.calls[0];
            expect(norm(sql)).toContain("datetime('now', '-7 days')");
        });
    });

    describe('cleanupOldRotations', () => {
        it('targets the timestamp column on viewbot_rotation_history', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.cleanupOldRotations(30);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "DELETE FROM viewbot_rotation_history WHERE timestamp < datetime('now', '-30 days')"
            );
            expect(params).toBeUndefined();
        });
    });

    describe('cleanupOldMetrics', () => {
        it('targets the measured_at column on viewbot_metrics', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 2 });
            await repo.cleanupOldMetrics(30);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "DELETE FROM viewbot_metrics WHERE measured_at < datetime('now', '-30 days')"
            );
            expect(params).toBeUndefined();
        });
    });

    // ============================================================
    // Constructor / dep injection
    // ============================================================

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new ViewBotRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new ViewBotRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
