/**
 * PR 8.4 (Phase 8) — RecordingCleanupScheduler vs RecordingUploadScheduler
 * data-loss race.
 *
 * The hazard (documented in
 * `docs/architecture/background-work.md` "Notable hazards"):
 *
 *   - `RecordingCleanupScheduler.runCleanup` (PRE-fix) deleted sessions
 *     whose `start_time < cutoffTime` AND status IN ('completed',
 *     'uploaded'). The check did NOT inspect `b2_file_id`.
 *   - `RecordingUploadScheduler` runs on a separate cadence (every 5
 *     min) and retries failed uploads every 30 min. If B2 is down for a
 *     long stretch, an upload retry can still be queued for a session
 *     whose age has passed retention.
 *   - Net effect: the cleanup deletes the recording_sessions DB row
 *     before the upload had a chance to finish. The upload retry then
 *     finds no row, the local recording-segment directory has been
 *     cleaned by PR 2.6's gated FS cleanup → silent loss of the
 *     metadata binding (and, if B2 had been broken long enough, of the
 *     recording itself).
 *
 * The PR 2.6 fix already closed the FILESYSTEM half (gated FS cleanup
 * on b2_file_id IS NOT NULL). PR 8.4 closes the DATABASE half by
 * extending the cleanup SQL with `(b2_file_id IS NOT NULL OR start_time
 * < (cutoff - retryWindowMs))`.
 *
 * Pattern: mock the DB primitives, instantiate a real service, assert
 * the SQL bind shape and the rows that survive vs. get deleted.
 */

jest.mock('../../database/database', () => {
    let rows = [];
    let nextRejectError = null;
    let __settingValue = '7'; // retention_days default

    async function getAsync(sql, params) {
        await Promise.resolve();
        if (/admin_review_settings.*key\s*=\s*'retention_days'/i.test(sql)) {
            return { value: __settingValue };
        }
        // Count queries from getStatus.
        if (/SELECT COUNT\(\*\) as count FROM recording_sessions\s+WHERE/i.test(sql)) {
            return { count: filterByExpiredSql(sql, params).length };
        }
        // Storage-sum query from getStatus.
        if (/SELECT SUM\(file_size_bytes\)/i.test(sql)) {
            return { total: rows.reduce((s, r) => s + (r.file_size_bytes || 0), 0) };
        }
        if (/SELECT COUNT\(\*\) as count FROM recording_sessions\s*$/i.test(sql.trim())) {
            return { count: rows.length };
        }
        // SELECT * by session_id (deleteSessionById).
        if (/SELECT \* FROM recording_sessions WHERE session_id = \?/i.test(sql)) {
            return rows.find((r) => r.session_id === params[0]) || null;
        }
        return null;
    }

    async function allAsync(sql, params) {
        await Promise.resolve();
        if (nextRejectError) {
            const err = nextRejectError;
            nextRejectError = null;
            throw err;
        }
        if (/SELECT \* FROM recording_sessions\s+WHERE start_time/i.test(sql)) {
            return filterByExpiredSql(sql, params);
        }
        return [];
    }

    async function runAsync(sql, params) {
        await Promise.resolve();
        if (/DELETE FROM session_chat_messages WHERE session_id = \?/i.test(sql)) {
            // No-op; we only track recording_sessions deletes in the assertions.
            return;
        }
        if (/DELETE FROM recording_sessions WHERE session_id = \?/i.test(sql)) {
            rows = rows.filter((r) => r.session_id !== params[0]);
            return;
        }
        if (/INSERT INTO admin_review_settings/i.test(sql)) {
            __settingValue = params[0];
            return;
        }
        // Catch-all (e.g. UPDATE recording_sessions SET status from another path) → no-op.
    }

    function filterByExpiredSql(sql, params) {
        const cutoffTime = params[0];
        const extendedCutoff = params[1];
        // Replicate the new SQL filter exactly so tests reflect production.
        // P2.2: 'upload_failed' is terminal — reaps at plain retention via
        // its own OR-clause leg (no b2 confirmation, no extended window).
        return rows.filter((r) => {
            if (r.start_time >= cutoffTime) return false;
            if (!['completed', 'uploaded', 'upload_failed'].includes(r.status)) return false;
            const bUploaded = r.b2_file_id !== null && r.b2_file_id !== undefined;
            const failedTerminal = r.status === 'upload_failed';
            const pastExtended = extendedCutoff !== undefined && r.start_time < extendedCutoff;
            return bUploaded || failedTerminal || pastExtended;
        });
    }

    return {
        runAsync,
        getAsync,
        allAsync,
        __testStore: {
            seedRows: (newRows) => { rows = newRows.map((r) => ({ b2_file_id: null, ...r })); },
            getRows: () => rows,
            reset: () => { rows = []; nextRejectError = null; __settingValue = '7'; },
            setRetentionDays: (n) => { __settingValue = String(n); },
            rejectNextAllAsync: (err) => { nextRejectError = err; },
        },
    };
});

// B2Storage mock — the cleanup calls deleteFile when b2_file_name is set;
// we no-op + track calls so the test can verify.
jest.mock('../../services/B2StorageService', () => ({
    isEnabled: () => true,
    deleteFile: jest.fn(async () => ({ success: true })),
}));

const dbMock = require('../../database/database');
const b2Storage = require('../../services/B2StorageService');
const RecordingCleanupScheduler = require('../../services/RecordingCleanupScheduler');

const DAY_MS = 24 * 60 * 60 * 1000;

function makeSession({ sessionId, daysAgo, b2_file_id = null, status = 'completed', file_size_bytes = 0 }) {
    return {
        session_id: sessionId,
        start_time: Date.now() - daysAgo * DAY_MS,
        status,
        b2_file_id,
        b2_file_name: b2_file_id ? `${sessionId}.mp4` : null,
        file_size_bytes,
    };
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
});

describe('RecordingCleanupScheduler.runCleanup — upload-race guard (PR 8.4)', () => {
    let scheduler;

    beforeEach(() => {
        dbMock.__testStore.reset();
        b2Storage.deleteFile.mockClear();
        // 1-day retry window — small enough that day-based fixtures are
        // unambiguous about "within retry window" vs "past retry window".
        scheduler = new RecordingCleanupScheduler({ retryWindowMs: DAY_MS });
    });

    test('deletes an UPLOADED session that is past the retention cutoff', async () => {
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'A', daysAgo: 8, b2_file_id: 'b2-A' }),
        ]);
        // retention = 7 days (default). 8 days old, uploaded → delete.
        await scheduler.runCleanup();
        expect(dbMock.__testStore.getRows().find((r) => r.session_id === 'A')).toBeUndefined();
        expect(b2Storage.deleteFile).toHaveBeenCalledWith('A.mp4');
    });

    test('PROTECTS an un-uploaded session past the retention cutoff but within the retry window', async () => {
        // 7.5 days old, b2_file_id null, retention=7d, retryWindow=1d.
        // start_time < cutoff (7d) YES, start_time < extendedCutoff (8d) NO,
        // b2_file_id IS NULL → guard fires → row survives.
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'PENDING', daysAgo: 7.5, b2_file_id: null }),
        ]);
        await scheduler.runCleanup();
        expect(dbMock.__testStore.getRows().find((r) => r.session_id === 'PENDING')).toBeDefined();
        expect(b2Storage.deleteFile).not.toHaveBeenCalled();
    });

    test('SAFETY VALVE — un-uploaded session past retention+retryWindow IS deleted', async () => {
        // 9 days old, b2_file_id null, retention=7d, retryWindow=1d → 8d
        // extended cutoff. 9 days > 8 days, so start_time < extendedCutoff
        // and the safety-valve OR fires → delete.
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'STUCK', daysAgo: 9, b2_file_id: null }),
        ]);
        await scheduler.runCleanup();
        expect(dbMock.__testStore.getRows().find((r) => r.session_id === 'STUCK')).toBeUndefined();
        // No b2_file_name (null) → no B2 delete call.
        expect(b2Storage.deleteFile).not.toHaveBeenCalled();
    });

    test('fresh sessions (under retention) are never touched', async () => {
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'YOUNG', daysAgo: 1, b2_file_id: 'b2-Y' }),
        ]);
        await scheduler.runCleanup();
        expect(dbMock.__testStore.getRows().find((r) => r.session_id === 'YOUNG')).toBeDefined();
        expect(b2Storage.deleteFile).not.toHaveBeenCalled();
    });

    test('mixed batch — correctly discriminates per-session', async () => {
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'A-uploaded-old', daysAgo: 10, b2_file_id: 'b2-A' }),    // delete
            makeSession({ sessionId: 'B-pending-7.5d', daysAgo: 7.5, b2_file_id: null }),     // keep
            makeSession({ sessionId: 'C-pending-9d', daysAgo: 9, b2_file_id: null }),          // delete (safety valve)
            makeSession({ sessionId: 'D-fresh', daysAgo: 0.5, b2_file_id: null }),             // keep
            makeSession({ sessionId: 'E-uploaded-fresh', daysAgo: 1, b2_file_id: 'b2-E' }),    // keep
        ]);

        await scheduler.runCleanup();

        const survivors = dbMock.__testStore.getRows().map((r) => r.session_id).sort();
        expect(survivors).toEqual(['B-pending-7.5d', 'D-fresh', 'E-uploaded-fresh']);
    });

    test('status filter still applies — failed/recording sessions are NEVER touched even if old', async () => {
        // The outer status filter is preserved: only completed/uploaded
        // sessions are eligible. A 'recording' or 'failed' session that's
        // 30 days old must NOT be deleted by this scheduler — that's an
        // operator/data-recovery concern.
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'STILL-RECORDING', daysAgo: 30, status: 'recording', b2_file_id: null }),
            makeSession({ sessionId: 'FAILED', daysAgo: 30, status: 'failed', b2_file_id: null }),
        ]);
        await scheduler.runCleanup();
        expect(dbMock.__testStore.getRows().length).toBe(2);
    });

    // P2.2: 'upload_failed' (distinct from the legacy 'failed') is terminal —
    // it reaps at plain retention without waiting the extra retry window,
    // because it will never upload.
    test('upload_failed past retention is reaped even inside the retry window', async () => {
        dbMock.__testStore.seedRows([
            // 7.5 days old: past the 7d retention but INSIDE the 1d retry
            // window — a plain un-uploaded 'completed' row would be kept.
            makeSession({ sessionId: 'UF-OLD', daysAgo: 7.5, status: 'upload_failed', b2_file_id: null }),
        ]);
        await scheduler.runCleanup();
        expect(dbMock.__testStore.getRows().length).toBe(0);
    });

    test('upload_failed under retention is untouched', async () => {
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'UF-FRESH', daysAgo: 1, status: 'upload_failed', b2_file_id: null }),
        ]);
        await scheduler.runCleanup();
        expect(dbMock.__testStore.getRows().length).toBe(1);
    });
});

describe('RecordingCleanupScheduler.getStatus — mirrors the runCleanup filter (PR 8.4)', () => {
    let scheduler;

    beforeEach(() => {
        dbMock.__testStore.reset();
        scheduler = new RecordingCleanupScheduler({ retryWindowMs: DAY_MS });
    });

    test('pendingDeletion reflects the new SQL filter (not the old age-only one)', async () => {
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'old-uploaded', daysAgo: 10, b2_file_id: 'b2', file_size_bytes: 100 }),
            makeSession({ sessionId: 'pending-7.5d', daysAgo: 7.5, b2_file_id: null, file_size_bytes: 200 }),
            makeSession({ sessionId: 'safety-valve', daysAgo: 9, b2_file_id: null, file_size_bytes: 300 }),
        ]);

        const status = await scheduler.getStatus();
        // Two should-be-deleted: old-uploaded + safety-valve. NOT pending-7.5d (within retry).
        expect(status.pendingDeletion).toBe(2);
        expect(status.totalSessions).toBe(3);
        // New fields surfaced.
        expect(status).toHaveProperty('retryWindowMs', DAY_MS);
        expect(status).toHaveProperty('extendedCutoffTime');
    });
});

describe('RecordingCleanupScheduler — default retry window (PR 8.4)', () => {
    test('defaults to 24 h when retryWindowMs is not provided', () => {
        dbMock.__testStore.reset();
        const scheduler = new RecordingCleanupScheduler();
        expect(scheduler.retryWindowMs).toBe(24 * 60 * 60 * 1000);
    });

    test('retryWindowMs = 0 disables the protection (safety hatch)', async () => {
        // An operator who explicitly sets retryWindowMs=0 gets the
        // pre-PR-8.4 behavior — extendedCutoff == cutoff. Useful for
        // emergency storage-pressure recovery; documented as a config
        // option, not a default.
        dbMock.__testStore.reset();
        const scheduler = new RecordingCleanupScheduler({ retryWindowMs: 0 });
        dbMock.__testStore.seedRows([
            makeSession({ sessionId: 'P', daysAgo: 7.5, b2_file_id: null }),
        ]);
        await scheduler.runCleanup();
        // With retryWindowMs=0, extendedCutoff == cutoff. start_time <
        // cutoff AND start_time < extendedCutoff are equivalent. So
        // pending un-uploaded sessions past cutoff ARE deleted.
        expect(dbMock.__testStore.getRows().find((r) => r.session_id === 'P')).toBeUndefined();
    });
});
