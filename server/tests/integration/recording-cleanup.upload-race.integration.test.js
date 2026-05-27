/**
 * PR 13.3 — RecordingCleanupScheduler vs RecordingUploadScheduler
 * integration-level proof of the PR 8.4 race fix.
 *
 * The existing unit test at
 * server/tests/services/RecordingCleanupScheduler.upload-race.test.js (PR 8.4)
 * pins the *SQL filter shape* at the DB-mock seam. This file complements
 * (does NOT duplicate) that test by hitting a real in-memory SQLite
 * database and running BOTH schedulers — cleanup and upload — against
 * the same connection, end-to-end. If either scheduler's SQL drifts in
 * a way the unit test's regex didn't anticipate (column rename,
 * different table, etc.) the real DB will catch it here.
 *
 * The race the PR 8.4 fix closes (documented in
 * `docs/architecture/background-work.md` "Notable hazards"):
 *   - cleanup deletes a recording_sessions row when `start_time <
 *     cutoffTime` AND status IN ('completed','uploaded').
 *   - upload runs on a separate cadence and retries failed uploads.
 *   - If B2 is down past retention, the cleanup deletes the metadata
 *     row before the upload's next retry — silent loss of the
 *     metadata binding (and, with PR 2.6's matching FS cleanup gated,
 *     of the file too).
 *   - Fix: extend cleanup SQL with `(b2_file_id IS NOT NULL OR
 *     start_time < extendedCutoff)`. An un-uploaded session is now
 *     protected for `retryWindowMs` past the retention cutoff before
 *     it becomes eligible for the safety-valve deletion.
 *
 * This file's scenarios:
 *
 *   1. **In-window un-uploaded session survives cleanup** — the
 *      headline contract. A recording past retention but within the
 *      retry window, with b2_file_id=NULL, must survive a cleanup
 *      pass. The subsequent upload then succeeds and stamps b2_file_id.
 *
 *   2. **Past-retry-window un-uploaded session is reaped by the
 *      safety valve** — without an upper bound the queue would leak
 *      forever on a permanently-broken B2.
 *
 *   3. **Already-uploaded session past retention is deleted** —
 *      baseline behaviour: cleanup did the right thing on uploaded
 *      sessions before PR 8.4 too; pin that the protection-extension
 *      didn't break the baseline path.
 *
 *   4. **Fresh sessions are never touched** — sub-retention sessions
 *      survive cleanup regardless of upload state.
 *
 *   5. **getStatus reports the same count cleanup will delete** — the
 *      `(b2_file_id IS NOT NULL OR start_time < extendedCutoff)` guard
 *      is mirrored in getStatus's expiredCount query; PR 8.4 made sure
 *      they stay in lockstep.
 */

const dbSlot = {
    runAsync: null,
    getAsync: null,
    allAsync: null,
};

jest.mock('../../database/database', () => ({
    get db() { return null; },
    runAsync: (...args) => dbSlot.runAsync(...args),
    getAsync: (...args) => dbSlot.getAsync(...args),
    allAsync: (...args) => dbSlot.allAsync(...args),
    _betterAdapter: () => null,
}));

const mockB2Slot = {
    enabled: true,
    deleteFile: jest.fn(async () => ({ success: true })),
};

jest.mock('../../services/B2StorageService', () => ({
    isEnabled: () => mockB2Slot.enabled,
    deleteFile: (...args) => mockB2Slot.deleteFile(...args),
    processAndUploadSession: jest.fn(async () => ({
        success: true,
        fileId: 'b2-id-uploaded',
        fileName: 'recordings/test.mp4',
        fileSize: 1024,
    })),
}));

const {
    forEachBackend,
    bootstrapRecordingSchema,
    seedRecordingSession,
} = require('./_helpers/db-fixture');

const RecordingCleanupScheduler = require('../../services/RecordingCleanupScheduler');
const RecordingUploadScheduler = require('../../services/RecordingUploadScheduler');

const DAY_MS = 24 * 60 * 60 * 1000;

forEachBackend(({ make, label }) => {
    describe(`RecordingCleanupScheduler × RecordingUploadScheduler race (${label})`, () => {
        let primitives;
        let cleanup;
        let upload;
        let originalConsoleLog;
        let originalConsoleError;

        beforeEach(async () => {
            primitives = make();
            await bootstrapRecordingSchema(primitives);

            dbSlot.runAsync = primitives.runAsync;
            dbSlot.getAsync = primitives.getAsync;
            dbSlot.allAsync = primitives.allAsync;

            mockB2Slot.deleteFile.mockClear();

            originalConsoleLog = console.log;
            originalConsoleError = console.error;
            console.log = jest.fn();
            console.error = jest.fn();

            // 1-day retry window so the day-based fixture times are
            // unambiguous about within-vs-past the protection edge.
            cleanup = new RecordingCleanupScheduler({ retryWindowMs: DAY_MS });
            upload = new RecordingUploadScheduler({ localBufferHours: 0 });
        });

        afterEach(async () => {
            console.log = originalConsoleLog;
            console.error = originalConsoleError;
            cleanup.stop();
            upload.stop();
            dbSlot.runAsync = null;
            dbSlot.getAsync = null;
            dbSlot.allAsync = null;
            await primitives.close();
        });

        describe('PR 8.4 contract', () => {
            it('an un-uploaded session within retention+retryWindow survives cleanup', async () => {
                // Past retention (7 days default), within the 1-day retry window.
                // start_time = 7.5 days ago: cutoff = 7d ago, extendedCutoff = 8d ago.
                // 7.5d ago is < cutoff (eligible for status) AND > extendedCutoff
                // (NOT past the safety-valve cutoff). With b2_file_id=NULL,
                // the `(b2_file_id IS NOT NULL OR start_time < extendedCutoff)`
                // guard rejects deletion. Pre-PR-8.4 this row would have
                // been deleted.
                const sessionId = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 7.5 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                });

                await cleanup.runCleanup();

                const row = await primitives.getAsync(
                    'SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);
                expect(row).toBeTruthy();
                expect(row.b2_file_id).toBeNull();
                // Cleanup did NOT call B2 deleteFile (no b2_file_name to delete).
                expect(mockB2Slot.deleteFile).not.toHaveBeenCalled();
            });

            it('an un-uploaded session past retention+retryWindow IS reaped by the safety valve', async () => {
                // start_time = 9 days ago: cutoff = 7d ago, extendedCutoff = 8d ago.
                // 9d ago is < extendedCutoff (past the safety-valve cutoff),
                // so the `start_time < extendedCutoff` branch of the guard
                // matches → eligible for deletion. Without the safety valve,
                // a permanently-broken B2 would leak rows forever.
                const sessionId = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 9 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                });

                await cleanup.runCleanup();

                const row = await primitives.getAsync(
                    'SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);
                expect(row).toBeUndefined();
            });

            it('an UPLOADED session past retention is deleted (baseline path unchanged)', async () => {
                const sessionId = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 8 * DAY_MS,
                    status: 'uploaded',
                    b2_file_id: 'real-b2-id-xyz',
                    b2_file_name: `recordings/${'session-old'}.mp4`,
                });

                await cleanup.runCleanup();

                const row = await primitives.getAsync(
                    'SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);
                expect(row).toBeUndefined();
                // Cleanup called B2 deleteFile with the recorded b2_file_name.
                expect(mockB2Slot.deleteFile).toHaveBeenCalledWith(`recordings/${'session-old'}.mp4`);
            });

            it('a fresh session (within retention) is never touched, regardless of upload state', async () => {
                const sidFresh = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 1 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                });
                const sidFreshUploaded = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 2 * DAY_MS,
                    status: 'uploaded',
                    b2_file_id: 'fresh-id',
                    b2_file_name: 'recordings/fresh.mp4',
                });

                await cleanup.runCleanup();

                const r1 = await primitives.getAsync(
                    'SELECT session_id FROM recording_sessions WHERE session_id = ?', [sidFresh]);
                const r2 = await primitives.getAsync(
                    'SELECT session_id FROM recording_sessions WHERE session_id = ?', [sidFreshUploaded]);
                expect(r1).toBeTruthy();
                expect(r2).toBeTruthy();
                expect(mockB2Slot.deleteFile).not.toHaveBeenCalled();
            });

            it('mixed batch — discriminates per-session via the new SQL filter', async () => {
                const sidProtected = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 7.5 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                }); // within retry window — survives
                const sidSafetyValve = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 9 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                }); // past safety valve — deleted
                const sidUploaded = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 8 * DAY_MS,
                    status: 'uploaded',
                    b2_file_id: 'up-id',
                    b2_file_name: 'recordings/up.mp4',
                }); // uploaded + past retention — deleted
                const sidFresh = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 1 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                }); // sub-retention — survives

                await cleanup.runCleanup();

                const surviving = await primitives.allAsync(
                    'SELECT session_id FROM recording_sessions ORDER BY session_id');
                const survivingIds = surviving.map((r) => r.session_id);
                expect(survivingIds).toContain(sidProtected);
                expect(survivingIds).toContain(sidFresh);
                expect(survivingIds).not.toContain(sidSafetyValve);
                expect(survivingIds).not.toContain(sidUploaded);
            });
        });

        describe('getStatus / runCleanup count parity', () => {
            it('expiredCount in getStatus matches the actual deletion count from runCleanup (PR 8.4 filter mirror)', async () => {
                // Three sessions: one protected, one safety-valve eligible,
                // one uploaded past retention. getStatus should report
                // exactly 2 (safety-valve + uploaded), and runCleanup should
                // delete exactly 2.
                await seedRecordingSession(primitives, {
                    start_time: Date.now() - 7.5 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                }); // protected
                await seedRecordingSession(primitives, {
                    start_time: Date.now() - 9 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                }); // safety valve
                await seedRecordingSession(primitives, {
                    start_time: Date.now() - 8 * DAY_MS,
                    status: 'uploaded',
                    b2_file_id: 'x',
                    b2_file_name: 'recordings/x.mp4',
                }); // uploaded past retention

                const status = await cleanup.getStatus();
                expect(status.pendingDeletion).toBe(2);
                // surface assertion that the retry-window field is part of the
                // status response so operators can correlate at a glance.
                expect(status.retryWindowMs).toBe(DAY_MS);

                const beforeCount = (await primitives.getAsync(
                    'SELECT COUNT(*) as c FROM recording_sessions')).c;
                expect(beforeCount).toBe(3);

                await cleanup.runCleanup();

                const afterCount = (await primitives.getAsync(
                    'SELECT COUNT(*) as c FROM recording_sessions')).c;
                expect(afterCount).toBe(1); // 3 - 2 deleted = 1 left
            });
        });

        describe('end-to-end: cleanup-then-upload sequence', () => {
            it('protected session survives the cleanup tick AND can still be uploaded successfully afterward', async () => {
                // The combined story PR 8.4 + PR 2.6 close: a session is
                // past retention but within retry window, B2 is still down
                // when cleanup runs (cleanup leaves it), then B2 comes back
                // and the upload retry succeeds. The row reaches 'uploaded'
                // with b2_file_id stamped.
                const sessionId = await seedRecordingSession(primitives, {
                    start_time: Date.now() - 7.5 * DAY_MS,
                    end_time: Date.now() - 7 * DAY_MS,
                    status: 'completed',
                    b2_file_id: null,
                });

                // Tick 1: cleanup leaves the row alone.
                await cleanup.runCleanup();
                const rowAfterCleanup = await primitives.getAsync(
                    'SELECT * FROM recording_sessions WHERE session_id = ?', [sessionId]);
                expect(rowAfterCleanup).toBeTruthy();

                // Tick 2: upload retries with B2 back online — succeeds.
                // forceUpload bypasses the queue's scheduledTime check so
                // the test is deterministic.
                const fs = require('fs');
                const path = require('path');
                const os = require('os');
                const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-recover-'));
                fs.writeFileSync(path.join(tmp, 'seg.ts'), 'x');
                await primitives.runAsync(
                    'UPDATE recording_sessions SET local_path = ? WHERE session_id = ?',
                    [tmp, sessionId]
                );

                const res = await upload.forceUpload(sessionId);
                expect(res).toEqual({ success: true });

                const final = await primitives.getAsync(
                    'SELECT status, b2_file_id FROM recording_sessions WHERE session_id = ?',
                    [sessionId]
                );
                expect(final.status).toBe('uploaded');
                expect(final.b2_file_id).toBe('b2-id-uploaded');

                // Cleanup tmpdir.
                if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
            });
        });
    });
});
