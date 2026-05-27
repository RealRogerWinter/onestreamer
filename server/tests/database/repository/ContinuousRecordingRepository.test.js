const ContinuousRecordingRepository = require('../../../database/repository/ContinuousRecordingRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new ContinuousRecordingRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('ContinuousRecordingRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
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
    // recording_sessions
    // ============================================================

    describe('insertSessionIfMissing', () => {
        it('INSERT OR IGNOREs with status="recording" baked in + created_at=CURRENT_TIMESTAMP', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 42, changes: 1 });

            await repo.insertSessionIfMissing({
                sessionId: 'sess_20260527',
                streamerIdentity: 'alice',
                streamerUserId: 9,
                streamerUsername: 'alice',
                startTime: 1716800000000,
                localPath: '/r/sess_20260527',
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT OR IGNORE INTO recording_sessions ' +
                '(session_id, streamer_identity, streamer_user_id, streamer_username, start_time, status, local_path, created_at) ' +
                "VALUES (?, ?, ?, ?, ?, 'recording', ?, CURRENT_TIMESTAMP)"
            );
            // 6 placeholders → 6 params (status + created_at are baked in).
            expect(params).toEqual([
                'sess_20260527', 'alice', 9, 'alice', 1716800000000, '/r/sess_20260527',
            ]);
        });

        it('accepts null streamerUserId + null streamerUsername (URL-relay / unknown identity)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertSessionIfMissing({
                sessionId: 'sess_20260527',
                streamerIdentity: 'twitch-relay',
                streamerUserId: null,
                streamerUsername: null,
                startTime: 1716800000000,
                localPath: '/r/sess_20260527',
            });
            const [, params] = runAsync.mock.calls[0];
            expect(params[2]).toBeNull();
            expect(params[3]).toBeNull();
        });
    });

    describe('setSessionRecording', () => {
        it("flips status back to 'recording' and bumps updated_at", async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.setSessionRecording('sess_20260527');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "UPDATE recording_sessions SET status = 'recording', updated_at = CURRENT_TIMESTAMP " +
                'WHERE session_id = ?'
            );
            expect(params).toEqual(['sess_20260527']);
        });
    });

    describe('updateSessionEnd', () => {
        it('uses relative arithmetic (segment_count = segment_count + ?)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.updateSessionEnd('sess_20260527', {
                endTime: 1716803600000,
                durationMs: 3600000,
                segmentCount: 900,
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE recording_sessions ' +
                'SET end_time = ?, duration_ms = ?, segment_count = segment_count + ?, updated_at = CURRENT_TIMESTAMP ' +
                'WHERE session_id = ?'
            );
            // session_id is the trailing param.
            expect(params).toEqual([1716803600000, 3600000, 900, 'sess_20260527']);
        });
    });

    describe('getSessionStartTime', () => {
        it('SELECTs start_time only (not the full row)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ start_time: 1716800000000 });
            const row = await repo.getSessionStartTime('sess_20260527');
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT start_time FROM recording_sessions WHERE session_id = ?');
            expect(params).toEqual(['sess_20260527']);
            expect(row).toEqual({ start_time: 1716800000000 });
        });
    });

    describe('getSessionById', () => {
        it('SELECTs the full row', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ session_id: 'sess_20260527' });
            await repo.getSessionById('sess_20260527');
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM recording_sessions WHERE session_id = ?');
            expect(params).toEqual(['sess_20260527']);
        });
    });

    describe('listSessions', () => {
        it('no options → SELECT all ORDER BY start_time DESC; no fragments appended', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listSessions();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM recording_sessions WHERE 1=1 ORDER BY start_time DESC'
            );
            expect(params).toEqual([]);
        });

        it('with options builds the documented fragments in the documented order', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listSessions({
                status: 'recording',
                streamerIdentity: 'alice',
                fromTime: 1716800000000,
                toTime: 1716810000000,
                limit: 20,
                offset: 40,
            });
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM recording_sessions WHERE 1=1 ' +
                'AND status = ? AND streamer_identity = ? AND start_time >= ? AND start_time <= ? ' +
                'ORDER BY start_time DESC LIMIT ? OFFSET ?'
            );
            expect(params).toEqual([
                'recording', 'alice', 1716800000000, 1716810000000, 20, 40,
            ]);
        });

        it('omits a fragment when its option is falsy (limit=0 not included)', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listSessions({ status: 'recording', limit: 0 });
            const [sql, params] = allAsync.mock.calls[0];
            // limit=0 is falsy under the documented `if (limit)` check — fragment omitted.
            expect(norm(sql)).toBe(
                'SELECT * FROM recording_sessions WHERE 1=1 AND status = ? ORDER BY start_time DESC'
            );
            expect(params).toEqual(['recording']);
        });

        it('ignores keys outside the destructured whitelist', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            // `evilKey` is not in the destructuring list — silently dropped.
            await repo.listSessions({ status: 'recording', evilKey: 'DROP TABLE users' });
            const [sql, params] = allAsync.mock.calls[0];
            expect(sql).not.toContain('evilKey');
            expect(sql).not.toContain('DROP');
            expect(params).toEqual(['recording']);
        });
    });

    describe('listSessionsPendingUpload', () => {
        it('SELECTs session_id-only for rows with b2_file_id IS NULL', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ session_id: 'sess_a' }, { session_id: 'sess_b' }]);
            const rows = await repo.listSessionsPendingUpload();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT session_id FROM recording_sessions WHERE b2_file_id IS NULL'
            );
            expect(params).toBeUndefined();
            expect(rows).toHaveLength(2);
        });
    });

    // ============================================================
    // recording_stream_segments
    // ============================================================

    describe('insertStreamSegment', () => {
        it('INSERTs 8 columns; created_at baked in', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 100, changes: 1 });

            await repo.insertStreamSegment({
                sessionId: 'sess_20260527',
                streamIdentity: 'alice',
                streamType: 'real_streamer',
                displayName: 'Alice',
                platform: 'direct',
                sourceUrl: null,
                startedAt: 1716800050000,
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO recording_stream_segments ' +
                '(session_id, stream_identity, stream_type, display_name, platform, source_url, started_at, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
            );
            expect(params).toEqual([
                'sess_20260527', 'alice', 'real_streamer', 'Alice', 'direct', null, 1716800050000,
            ]);
        });
    });

    describe('endStreamSegment', () => {
        it('UPDATEs ended_at by id; guarded on ended_at IS NULL', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.endStreamSegment(100, 1716800070000);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE recording_stream_segments SET ended_at = ? WHERE id = ? AND ended_at IS NULL'
            );
            // ended_at is the leading bound param, id is trailing — matches legacy ordering.
            expect(params).toEqual([1716800070000, 100]);
        });
    });

    describe('endAllOpenSegments', () => {
        it('UPDATEs ended_at by session_id; guarded on ended_at IS NULL', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 3 });
            await repo.endAllOpenSegments('sess_20260527', 1716803600000);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE recording_stream_segments SET ended_at = ? ' +
                'WHERE session_id = ? AND ended_at IS NULL'
            );
            expect(params).toEqual([1716803600000, 'sess_20260527']);
        });
    });

    // ============================================================
    // Constructor / dep injection
    // ============================================================

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new ContinuousRecordingRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new ContinuousRecordingRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
