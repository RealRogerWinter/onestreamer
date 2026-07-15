/**
 * PR 13.3 — RecordingUploadScheduler integration test.
 *
 * End-to-end exercise of the B2-upload pipeline at the scheduler boundary:
 * real RecordingUploadScheduler over real in-memory SQLite over a real
 * tmpdir for local files, with B2StorageService.processAndUploadSession
 * mocked at the module level so we control success/failure without
 * touching the network.
 *
 * What this proves end-to-end:
 *
 *   1. **Happy path** — a scheduled session becomes due, uploadSession
 *      runs, B2 mock reports success, the recording_sessions row is
 *      updated (b2_file_id, b2_file_name, file_size_bytes, status =
 *      'uploaded'), the local files are removed, and the queue entry is
 *      cleared.
 *
 *   2. **Retry behaviour (the B2-retry contract the brief calls out)** —
 *      a failed B2 upload reverts the status row to 'completed', leaves
 *      local files in place, and re-queues the session for retry 30
 *      minutes later. The follow-up attempt succeeds and the row reaches
 *      'uploaded' (proves the retry path actually retries, not just
 *      logs).
 *
 *   3. **Idempotency** — a session whose b2_file_id is already set is
 *      treated as success without invoking B2 (covers the steady-state
 *      case where a second processPendingUploads cycle catches an
 *      already-uploaded session before the queue entry was cleared).
 *
 *   4. **Missing local files** — uploadSession returns success=false
 *      with the expected error when the local recording directory was
 *      deleted before the upload could run.
 *
 *   5. **forceUpload** — bypasses the queue scheduling, runs immediately,
 *      and returns the same shape as processPendingUploads would have.
 *
 *   6. **processPendingUploads — partial batch** — when two sessions are
 *      queued and only one is due, only the due one is processed.
 *
 * This file complements (does NOT duplicate) the existing unit-level
 * tests in `server/tests/services/RecordingCleanupScheduler.upload-race.test.js`
 * (PR 8.4 — 9 unit tests against the DB-mock seam) and
 * `server/tests/services/ContinuousRecordingService.cleanup-race.test.js`
 * (PR 2.6 — 7 unit tests against the FS-mock seam). Those pin the SQL
 * filter shape and the fs.rmSync guard respectively; this file proves
 * the assembled pipeline still does what the unit tests claim it does
 * once a real connection, real fs, and a real scheduler are wired up
 * end-to-end.
 */

const dbSlot = {
    runAsync: null,
    getAsync: null,
    allAsync: null,
    withTransaction: null,
};

jest.mock('../../database/database', () => ({
    get db() { return null; },
    runAsync: (...args) => dbSlot.runAsync(...args),
    getAsync: (...args) => dbSlot.getAsync(...args),
    allAsync: (...args) => dbSlot.allAsync(...args),
    withTransaction: (...args) => dbSlot.withTransaction(...args),
    _betterAdapter: () => null,
}));

// Slot-pattern mock so each test can flip the success/failure mode and
// inspect call count without re-requiring the module.
const mockB2Slot = {
    enabled: true,
    processAndUploadSession: jest.fn(),
};

jest.mock('../../services/B2StorageService', () => ({
    isEnabled: () => mockB2Slot.enabled,
    processAndUploadSession: (...args) => mockB2Slot.processAndUploadSession(...args),
    deleteFile: jest.fn(async () => ({ success: true })),
}));

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    forEachBackend,
    bootstrapRecordingSchema,
    seedRecordingSession,
} = require('./_helpers/db-fixture');

const RecordingUploadScheduler = require('../../services/RecordingUploadScheduler');

function makeTempRecordingDir(sessionId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rec-${sessionId}-`));
    // Drop a placeholder file so fs.existsSync(localPath) returns true
    // AND the dir actually has content that cleanupLocalFiles will remove.
    fs.writeFileSync(path.join(dir, 'segment_000.ts'), 'fake-segment-bytes');
    return dir;
}

function rmrf(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

forEachBackend(({ make, label }) => {
    describe(`RecordingUploadScheduler integration (${label})`, () => {
        let primitives;
        let scheduler;
        let tmpDirs;
        let originalConsoleLog;
        let originalConsoleError;

        beforeEach(async () => {
            primitives = make();
            await bootstrapRecordingSchema(primitives);

            dbSlot.runAsync = primitives.runAsync;
            dbSlot.getAsync = primitives.getAsync;
            dbSlot.allAsync = primitives.allAsync;
            // RecordingUploadScheduler doesn't open a tx — leave withTransaction null.

            mockB2Slot.enabled = true;
            mockB2Slot.processAndUploadSession.mockReset();

            originalConsoleLog = console.log;
            originalConsoleError = console.error;
            console.log = jest.fn();
            console.error = jest.fn();

            tmpDirs = [];

            // Small intervals so tests stay fast. We never start() the
            // scheduler (which would set its own interval); instead we
            // invoke processPendingUploads / uploadSession directly.
            scheduler = new RecordingUploadScheduler({
                localBufferHours: 2,
                checkIntervalMs: 10_000,
            });
        });

        afterEach(async () => {
            console.log = originalConsoleLog;
            console.error = originalConsoleError;
            scheduler.stop();
            for (const d of tmpDirs) rmrf(d);
            dbSlot.runAsync = null;
            dbSlot.getAsync = null;
            dbSlot.allAsync = null;
            await primitives.close();
        });

        describe('uploadSession — happy path', () => {
            it('uploads, updates the DB row, removes local files, returns success', async () => {
                const sessionId = await seedRecordingSession(primitives, {
                    status: 'completed',
                    file_size_bytes: 0,
                });
                const localPath = makeTempRecordingDir(sessionId);
                tmpDirs.push(localPath);
                await primitives.runAsync(
                    'UPDATE recording_sessions SET local_path = ? WHERE session_id = ?',
                    [localPath, sessionId]
                );

                mockB2Slot.processAndUploadSession.mockResolvedValueOnce({
                    success: true,
                    fileId: 'b2-file-id-abc',
                    fileName: `recordings/${sessionId}.mp4`,
                    fileSize: 1024 * 1024,
                });

                const res = await scheduler.uploadSession(sessionId);

                expect(res).toEqual({ success: true });
                expect(mockB2Slot.processAndUploadSession).toHaveBeenCalledTimes(1);
                expect(mockB2Slot.processAndUploadSession).toHaveBeenCalledWith(
                    sessionId,
                    localPath,
                    expect.objectContaining({ streamerIdentity: 'tester' })
                );

                const row = await primitives.getAsync(
                    'SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);
                expect(row.b2_file_id).toBe('b2-file-id-abc');
                expect(row.b2_file_name).toBe(`recordings/${sessionId}.mp4`);
                expect(row.file_size_bytes).toBe(1024 * 1024);
                expect(row.status).toBe('uploaded');

                // Local files cleaned up after successful upload.
                expect(fs.existsSync(localPath)).toBe(false);
            });
        });

        describe('uploadSession — failure + retry', () => {
            it('on B2 failure: reverts status to "completed", leaves local files, returns failure', async () => {
                const sessionId = await seedRecordingSession(primitives, { status: 'completed' });
                const localPath = makeTempRecordingDir(sessionId);
                tmpDirs.push(localPath);
                await primitives.runAsync(
                    'UPDATE recording_sessions SET local_path = ? WHERE session_id = ?',
                    [localPath, sessionId]
                );

                mockB2Slot.processAndUploadSession.mockResolvedValueOnce({
                    success: false,
                    error: 'B2: network unreachable',
                });

                const res = await scheduler.uploadSession(sessionId);

                expect(res).toEqual({ success: false, error: 'B2: network unreachable' });

                const row = await primitives.getAsync(
                    'SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);
                // Status reverted from intermediate 'processing' back to 'completed'.
                expect(row.status).toBe('completed');
                expect(row.b2_file_id).toBeNull();

                // Local files MUST survive a failed upload so a retry has
                // something to upload from. This is the load-bearing
                // invariant the retry contract is built on.
                expect(fs.existsSync(localPath)).toBe(true);
                expect(fs.existsSync(path.join(localPath, 'segment_000.ts'))).toBe(true);
            });

            it('processPendingUploads — failed upload is re-queued for retry 30 minutes later, second attempt succeeds', async () => {
                const sessionId = await seedRecordingSession(primitives, { status: 'completed' });
                const localPath = makeTempRecordingDir(sessionId);
                tmpDirs.push(localPath);
                await primitives.runAsync(
                    'UPDATE recording_sessions SET local_path = ? WHERE session_id = ?',
                    [localPath, sessionId]
                );

                // Queue it as "due now" so processPendingUploads picks it up.
                const dueNow = Date.now() - 1;
                scheduler.uploadQueue.set(sessionId, dueNow);

                // First attempt: B2 fails.
                mockB2Slot.processAndUploadSession.mockResolvedValueOnce({
                    success: false,
                    error: 'transient B2 outage',
                });

                const beforeProcessing = Date.now();
                await scheduler.processPendingUploads();

                // Session is STILL in the queue, but the scheduledTime has
                // been pushed ~30 minutes into the future.
                expect(scheduler.uploadQueue.has(sessionId)).toBe(true);
                const nextScheduled = scheduler.uploadQueue.get(sessionId);
                const expectedRetryAt = beforeProcessing + 30 * 60 * 1000;
                // Allow ±2s slack for the ms-precision arithmetic.
                expect(Math.abs(nextScheduled - expectedRetryAt)).toBeLessThan(2_000);

                const row1 = await primitives.getAsync(
                    'SELECT status, b2_file_id FROM recording_sessions WHERE session_id = ?', [sessionId]);
                expect(row1.status).toBe('completed');
                expect(row1.b2_file_id).toBeNull();

                // Second attempt: force the queue to "due now" again,
                // make B2 succeed, run processPendingUploads, assert the
                // row reaches the terminal 'uploaded' state.
                scheduler.uploadQueue.set(sessionId, Date.now() - 1);
                mockB2Slot.processAndUploadSession.mockResolvedValueOnce({
                    success: true,
                    fileId: 'b2-id-retry-success',
                    fileName: `recordings/${sessionId}.mp4`,
                    fileSize: 2048,
                });

                await scheduler.processPendingUploads();

                expect(scheduler.uploadQueue.has(sessionId)).toBe(false);
                const row2 = await primitives.getAsync(
                    'SELECT status, b2_file_id, file_size_bytes FROM recording_sessions WHERE session_id = ?',
                    [sessionId]
                );
                expect(row2.status).toBe('uploaded');
                expect(row2.b2_file_id).toBe('b2-id-retry-success');
                expect(row2.file_size_bytes).toBe(2048);
                expect(mockB2Slot.processAndUploadSession).toHaveBeenCalledTimes(2);
            });
        });

        describe('uploadSession — idempotency / missing files', () => {
            it('returns success without invoking B2 when the session already has b2_file_id', async () => {
                const sessionId = await seedRecordingSession(primitives, {
                    status: 'uploaded',
                    b2_file_id: 'pre-existing-id',
                    b2_file_name: 'recordings/pre-existing.mp4',
                });

                const res = await scheduler.uploadSession(sessionId);
                expect(res).toEqual({ success: true });
                expect(mockB2Slot.processAndUploadSession).not.toHaveBeenCalled();
            });

            it('marks the session terminally upload_failed when the local recording directory was deleted before the upload could run (P2.2)', async () => {
                const sessionId = await seedRecordingSession(primitives, {
                    status: 'completed',
                    local_path: '/tmp/nonexistent-recording-dir-' + Date.now(),
                });

                const res = await scheduler.uploadSession(sessionId);
                expect(res.success).toBe(false);
                expect(res.permanent).toBe(true);
                expect(res.error).toMatch(/Local recording not found/);
                expect(mockB2Slot.processAndUploadSession).not.toHaveBeenCalled();

                // P2.2: the source dir is gone (disk scanner reclaimed it),
                // so the upload can never succeed — terminal status instead
                // of retrying every 30 min forever.
                const row = await primitives.getAsync(
                    'SELECT status FROM recording_sessions WHERE session_id = ?', [sessionId]);
                expect(row.status).toBe('upload_failed');
            });

            it('returns failure when the session_id has no row', async () => {
                const res = await scheduler.uploadSession('does-not-exist');
                expect(res).toEqual({ success: false, error: 'Session not found' });
                expect(mockB2Slot.processAndUploadSession).not.toHaveBeenCalled();
            });
        });

        describe('forceUpload', () => {
            it('uploads immediately, bypassing the queue scheduling, and returns the same shape as uploadSession', async () => {
                const sessionId = await seedRecordingSession(primitives, { status: 'completed' });
                const localPath = makeTempRecordingDir(sessionId);
                tmpDirs.push(localPath);
                await primitives.runAsync(
                    'UPDATE recording_sessions SET local_path = ? WHERE session_id = ?',
                    [localPath, sessionId]
                );

                mockB2Slot.processAndUploadSession.mockResolvedValueOnce({
                    success: true,
                    fileId: 'force-id',
                    fileName: `recordings/${sessionId}.mp4`,
                    fileSize: 1234,
                });

                const res = await scheduler.forceUpload(sessionId);
                expect(res).toEqual({ success: true });
                expect(mockB2Slot.processAndUploadSession).toHaveBeenCalledTimes(1);
            });
        });

        describe('processPendingUploads — partial batch', () => {
            it('processes only sessions whose scheduled time is in the past', async () => {
                const sidA = await seedRecordingSession(primitives, { status: 'completed' });
                const sidB = await seedRecordingSession(primitives, { status: 'completed' });
                const localPathA = makeTempRecordingDir(sidA);
                const localPathB = makeTempRecordingDir(sidB);
                tmpDirs.push(localPathA, localPathB);
                await primitives.runAsync(
                    'UPDATE recording_sessions SET local_path = ? WHERE session_id = ?', [localPathA, sidA]);
                await primitives.runAsync(
                    'UPDATE recording_sessions SET local_path = ? WHERE session_id = ?', [localPathB, sidB]);

                // A is due (past); B is in the future.
                scheduler.uploadQueue.set(sidA, Date.now() - 1000);
                scheduler.uploadQueue.set(sidB, Date.now() + 60 * 60 * 1000);

                mockB2Slot.processAndUploadSession.mockResolvedValueOnce({
                    success: true, fileId: 'aid', fileName: `recordings/${sidA}.mp4`, fileSize: 1,
                });

                await scheduler.processPendingUploads();

                expect(mockB2Slot.processAndUploadSession).toHaveBeenCalledTimes(1);
                expect(mockB2Slot.processAndUploadSession).toHaveBeenCalledWith(
                    sidA,
                    expect.any(String),
                    expect.any(Object)
                );

                // A is removed from the queue; B is untouched.
                expect(scheduler.uploadQueue.has(sidA)).toBe(false);
                expect(scheduler.uploadQueue.has(sidB)).toBe(true);

                const rowA = await primitives.getAsync(
                    'SELECT status FROM recording_sessions WHERE session_id = ?', [sidA]);
                const rowB = await primitives.getAsync(
                    'SELECT status FROM recording_sessions WHERE session_id = ?', [sidB]);
                expect(rowA.status).toBe('uploaded');
                expect(rowB.status).toBe('completed'); // not touched
            });
        });
    });
});
