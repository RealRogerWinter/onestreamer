const ClipRepository = require('../../../database/repository/ClipRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new ClipRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe.each([
    { flag: 'true' },
    { flag: 'false' },
])('ClipRepository (USE_BETTER_SQLITE3=$flag)', ({ flag }) => {
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
    // clips
    // ============================================================

    describe('insertClip', () => {
        it('INSERTs 9 columns with status="processing" baked in', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertClip({
                clipId: 'clip_abc',
                recordingId: 'sess_xyz',
                userId: 7,
                streamerUserId: 9,
                title: 'My clip',
                description: 'cool',
                startMs: 1716800000000,
                endMs: 1716800030000,
                durationMs: 30000,
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO clips ( ' +
                'clip_id, recording_id, user_id, streamer_user_id, title, description, ' +
                'start_time_ms, end_time_ms, duration_ms, status ' +
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')"
            );
            // 9 placeholders → 9 params (status baked in).
            expect(params).toEqual([
                'clip_abc', 'sess_xyz', 7, 9, 'My clip', 'cool',
                1716800000000, 1716800030000, 30000,
            ]);
        });

        it('streamerUserId defaults to NULL when omitted (live-clip path)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertClip({
                clipId: 'clip_abc',
                recordingId: 'sess_xyz',
                userId: 7,
                title: 'My clip',
                description: '',
                startMs: 1,
                endMs: 2,
                durationMs: 1,
            });
            const [, params] = runAsync.mock.calls[0];
            // 4th positional arg = streamer_user_id slot.
            expect(params[3]).toBeNull();
        });
    });

    describe('getClipById', () => {
        it('SELECTs * by clip_id (single-table, no JOIN)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ clip_id: 'clip_abc' });
            await repo.getClipById('clip_abc');
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM clips WHERE clip_id = ?');
            expect(params).toEqual(['clip_abc']);
        });
    });

    describe('updateClipFields', () => {
        it('builds dynamic SET from fieldValues and appends updated_at=CURRENT_TIMESTAMP', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.updateClipFields('clip_abc', { title: 'new', is_public: 1 });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE clips SET title = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE clip_id = ?'
            );
            // clip_id is the trailing param.
            expect(params).toEqual(['new', 1, 'clip_abc']);
        });

        it('returns { changes: 0 } without hitting DB when fieldValues is empty', async () => {
            const { repo, runAsync } = makeRepo();
            const res = await repo.updateClipFields('clip_abc', {});
            expect(res).toEqual({ changes: 0 });
            expect(runAsync).not.toHaveBeenCalled();
        });
    });

    describe('deleteClipById', () => {
        it('DELETEs by clip_id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.deleteClipById('clip_abc');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM clips WHERE clip_id = ?');
            expect(params).toEqual(['clip_abc']);
        });
    });

    describe('incrementViewCount', () => {
        it('atomic-counter UPDATE (view_count = view_count + 1)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.incrementViewCount('clip_abc');
            const [sql, params] = runAsync.mock.calls[0];
            // PR 5.1 / ADR-0013a shape — relative arithmetic, no read-compute-write.
            expect(norm(sql)).toBe(
                'UPDATE clips SET view_count = view_count + 1 WHERE clip_id = ?'
            );
            expect(params).toEqual(['clip_abc']);
        });
    });

    describe('setClipReady', () => {
        it('updates status=ready + 3 path/size columns + updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.setClipReady('clip_abc', {
                filePath: '/clips/abc.mp4',
                thumbnailPath: '/clips/abc.jpg',
                fileSize: 12345,
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "UPDATE clips SET status = 'ready', file_path = ?, thumbnail_path = ?, file_size = ?, " +
                'updated_at = CURRENT_TIMESTAMP WHERE clip_id = ?'
            );
            expect(params).toEqual(['/clips/abc.mp4', '/clips/abc.jpg', 12345, 'clip_abc']);
        });
    });

    describe('setClipFailed', () => {
        it('updates status=failed + updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.setClipFailed('clip_abc');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "UPDATE clips SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE clip_id = ?"
            );
            expect(params).toEqual(['clip_abc']);
        });
    });

    describe('getStats', () => {
        it('SELECTs the 5-column aggregate row from clips', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({
                total_clips: 100, ready_clips: 80, processing_clips: 5,
                total_views: 9000, total_size: 99999,
            });
            const row = await repo.getStats();
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT COUNT(*) as total_clips, ' +
                "SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_clips, " +
                "SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_clips, " +
                'SUM(view_count) as total_views, SUM(file_size) as total_size FROM clips'
            );
            expect(params).toBeUndefined();
            expect(row.total_clips).toBe(100);
        });
    });

    // ============================================================
    // clip_views
    // ============================================================

    describe('findRecentView', () => {
        it('SELECT id with (user_id OR ip_address) match + 1-hour window', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 42 });
            await repo.findRecentView({ clipId: 'clip_abc', userId: 7, ipAddress: '1.2.3.4' });
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "SELECT id FROM clip_views WHERE clip_id = ? AND (user_id = ? OR ip_address = ?) " +
                "AND viewed_at > datetime('now', '-1 hour') LIMIT 1"
            );
            expect(params).toEqual(['clip_abc', 7, '1.2.3.4']);
        });
    });

    describe('insertView', () => {
        it('INSERTs (clip_id, user_id, ip_address)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 100, changes: 1 });
            await repo.insertView({ clipId: 'clip_abc', userId: 7, ipAddress: '1.2.3.4' });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO clip_views (clip_id, user_id, ip_address) VALUES (?, ?, ?)'
            );
            expect(params).toEqual(['clip_abc', 7, '1.2.3.4']);
        });
    });

    describe('deleteViewsByClipId', () => {
        it('DELETEs every clip_views row for a clip', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 3 });
            await repo.deleteViewsByClipId('clip_abc');
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM clip_views WHERE clip_id = ?');
            expect(params).toEqual(['clip_abc']);
        });
    });

    // ============================================================
    // clip_chat_messages
    // ============================================================

    describe('insertClipChatMessage', () => {
        it('INSERTs 5 columns (clip_id + 4 message fields)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.insertClipChatMessage({
                clipId: 'clip_abc',
                username: 'alice',
                message: 'hi',
                relativeTimeMs: 1500,
                originalTimestamp: '2026-05-27T12:00:00Z',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO clip_chat_messages (clip_id, username, message, relative_time_ms, original_timestamp) ' +
                'VALUES (?, ?, ?, ?, ?)'
            );
            expect(params).toEqual(['clip_abc', 'alice', 'hi', 1500, '2026-05-27T12:00:00Z']);
        });
    });

    describe('listChatByClip', () => {
        it('SELECTs 4-col projection, ORDER BY relative_time_ms ASC', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listChatByClip('clip_abc');
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT username, message, relative_time_ms, original_timestamp ' +
                'FROM clip_chat_messages WHERE clip_id = ? ORDER BY relative_time_ms ASC'
            );
            expect(params).toEqual(['clip_abc']);
        });
    });

    describe('countChatByClip', () => {
        it('SELECTs COUNT(*) for clip_id', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ count: 12 });
            await repo.countChatByClip('clip_abc');
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT COUNT(*) as count FROM clip_chat_messages WHERE clip_id = ?'
            );
            expect(params).toEqual(['clip_abc']);
        });
    });

    // ============================================================
    // Constructor / dep injection / transactional re-use
    // ============================================================

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            const repo = new ClipRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new ClipRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });

        it('a tx-bound repo routes its writes to the tx primitives (ADR-0015 pattern)', async () => {
            // The convention spelled out in ADR-0015: callers wrap a multi-
            // statement scope in `withTransaction(async (tx) => …)` and
            // construct `new ClipRepository(tx)` inside. Verify that the
            // repo's methods invoke the tx primitives, NOT any fallback.
            const txRunAsync = jest.fn().mockResolvedValue({ id: 0, changes: 1 });
            const tx = {
                runAsync: txRunAsync,
                getAsync: jest.fn(),
                allAsync: jest.fn(),
            };
            const txRepo = new ClipRepository(tx);
            await txRepo.insertView({ clipId: 'clip_abc', userId: 7, ipAddress: '1.2.3.4' });
            await txRepo.incrementViewCount('clip_abc');
            expect(txRunAsync).toHaveBeenCalledTimes(2);
            expect(txRunAsync.mock.calls[0][0]).toContain('INSERT INTO clip_views');
            expect(txRunAsync.mock.calls[1][0]).toContain('UPDATE clips SET view_count = view_count + 1');
        });
    });
});
