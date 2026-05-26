/**
 * PR 2.6 — gate `cleanupOldRecordings` on `recording_sessions.b2_file_id
 * IS NOT NULL` to close the local-cleanup-races-B2-upload hazard.
 *
 * The production race (documented in
 * `docs/architecture/background-work.md`, "Notable hazards"):
 *
 *   - `ContinuousRecordingService` constructor sets retention to 10
 *     minutes (`bootstrap/services.js:210`).
 *   - `RecordingUploadScheduler.localBufferHours` defaults to 2 hours —
 *     i.e. the upload pipeline waits two hours after the session ends
 *     before starting the B2 upload.
 *   - The cleanup interval fires every 1 minute and (pre-fix)
 *     unconditionally `fs.rmSync`'d any `session_<ts>` directory
 *     older than retention.
 *   - Net effect: the cleanup *always* deleted local files 110 minutes
 *     before the upload would fire. The upload then failed with
 *     "Local recording not found" and the session stayed at status =
 *     'completed' with b2_file_id = NULL forever — a permanent loss.
 *
 * The fix preloads the set of session_ids with b2_file_id IS NULL and
 * skips those directories in the loop. The DB is mocked so the test
 * is deterministic; the filesystem is mocked at the `fs.readdirSync`
 * / `fs.statSync` / `fs.rmSync` level so we can assert exactly which
 * directories the cleanup touched.
 *
 * Pattern reused from `server/tests/services/AccountService.points-race.test.js`
 * (PR 2.1): mock the DB module directly, real service instance, no
 * real I/O. Sinon fake timers are not needed because we drive cleanup
 * synchronously via `service.cleanupOldRecordings()`; the race the
 * fix addresses is a wall-clock race between two scheduled intervals,
 * not a microtask interleaving inside a single method.
 */

// Mock the DB primitives before any require that pulls them in.
jest.mock('../../database/database', () => {
  // In-memory store mimicking the recording_sessions table — only the
  // columns the cleanup query reads (session_id, b2_file_id).
  let rows = [];
  // Failure-injection flag. The production code destructures `allAsync`
  // at require time, so we can't swap the function after the fact; the
  // mock checks this flag on every call to decide whether to throw.
  let nextRejectError = null;

  async function allAsync(sql) {
    await Promise.resolve();
    if (nextRejectError) {
      const err = nextRejectError;
      nextRejectError = null; // one-shot
      throw err;
    }
    if (/SELECT\s+session_id\s+FROM\s+recording_sessions\s+WHERE\s+b2_file_id\s+IS\s+NULL/i.test(sql)) {
      return rows.filter((r) => r.b2_file_id === null).map((r) => ({ session_id: r.session_id }));
    }
    return [];
  }

  return {
    db: {},
    runAsync: jest.fn(),
    getAsync: jest.fn(),
    allAsync,
    __testStore: {
      seedRows: (newRows) => { rows = newRows; },
      reset: () => { rows = []; nextRejectError = null; },
      rejectNextAllAsync: (err) => { nextRejectError = err; },
    },
  };
});

// Mock `fs` operations the cleanup loop hits. We track every call so
// the assertions can inspect what the cleanup actually did.
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  const inMemory = {
    // path -> { isDirectory: bool, isFile: bool }
    entries: new Map(),
  };

  function setupItems(items) {
    inMemory.entries.clear();
    for (const item of items) {
      inMemory.entries.set(item.name, item);
    }
  }

  return {
    ...actualFs,
    __memfs: inMemory,
    __setupItems: setupItems,
    readdirSync: jest.fn((dir) => {
      return Array.from(inMemory.entries.keys());
    }),
    statSync: jest.fn((p) => {
      const name = require('path').basename(p);
      const entry = inMemory.entries.get(name);
      if (!entry) throw new Error(`statSync: not found: ${p}`);
      return {
        isDirectory: () => !!entry.isDirectory,
        isFile: () => !!entry.isFile,
      };
    }),
    rmSync: jest.fn((p, opts) => {
      const name = require('path').basename(p);
      inMemory.entries.delete(name);
    }),
    unlinkSync: jest.fn((p) => {
      const name = require('path').basename(p);
      inMemory.entries.delete(name);
    }),
    // The constructor calls existsSync + mkdirSync for the output dir.
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn(),
  };
});

// Other modules ContinuousRecordingService transitively imports. We
// stub them rather than wire real LiveKit / B2 / etc. The package is
// installed, but we want a clean stub for the test — no `virtual: true`
// since the SDK is a real dependency, not a virtual one.
jest.mock('livekit-server-sdk', () => ({
  EgressClient: jest.fn(),
  RoomServiceClient: jest.fn(),
  EncodedFileType: {},
  SegmentedFileOutput: jest.fn(),
  SegmentedFileProtocol: { HLS_PROTOCOL: 'hls' },
}));

const fs = require('fs');
const dbMock = require('../../database/database');
const ContinuousRecordingService = require('../../services/ContinuousRecordingService');

function makeOldSessionDir(sessionId, msAgo) {
  const ts = Date.now() - msAgo;
  return { name: `session_${ts}`, isDirectory: true, sessionIdInDb: `session_${ts}` };
}

describe('ContinuousRecordingService.cleanupOldRecordings — b2_file_id gate (PR 2.6)', () => {
  let service;
  let consoleErrorSpy;
  let consoleLogSpy;

  beforeEach(() => {
    dbMock.__testStore.reset();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // The constructor's initialize() kicks off two intervals AND an
    // immediate cleanup pass — startCleanupInterval() calls
    // cleanupOldRecordings() right away, and startAutoRecordPolling()
    // calls RoomServiceClient.listParticipants every 5s. The polling
    // hits a mocked SDK and throws; the immediate cleanup races our
    // test setup. Neutralize both via prototype-method swap before
    // construction; restore after.
    const origCleanup = ContinuousRecordingService.prototype.cleanupOldRecordings;
    const origAutoRec = ContinuousRecordingService.prototype.startAutoRecordPolling;
    const origStaleEgress = ContinuousRecordingService.prototype.cleanupStaleEgress;
    ContinuousRecordingService.prototype.cleanupOldRecordings = jest.fn().mockResolvedValue(undefined);
    ContinuousRecordingService.prototype.startAutoRecordPolling = jest.fn();
    ContinuousRecordingService.prototype.cleanupStaleEgress = jest.fn().mockResolvedValue(undefined);

    service = new ContinuousRecordingService({
      outputDir: '/tmp/test-egress-recordings',
      retentionMinutes: 10,
    });

    // Restore the real methods so tests exercise the real cleanup body.
    ContinuousRecordingService.prototype.cleanupOldRecordings = origCleanup;
    ContinuousRecordingService.prototype.startAutoRecordPolling = origAutoRec;
    ContinuousRecordingService.prototype.cleanupStaleEgress = origStaleEgress;

    if (service.cleanupInterval) {
      clearInterval(service.cleanupInterval);
      service.cleanupInterval = null;
    }
    service.currentSessionId = null;

    fs.readdirSync.mockClear();
    fs.statSync.mockClear();
    fs.rmSync.mockClear();
    fs.unlinkSync.mockClear();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  test('skips a session directory whose recording_sessions row has b2_file_id = NULL (the race the fix closes)', async () => {
    const pending = makeOldSessionDir('A', 20 * 60 * 1000); // 20 min old, past 10 min retention
    fs.__setupItems([pending]);
    dbMock.__testStore.seedRows([
      { session_id: pending.name, b2_file_id: null }, // upload pending
    ]);

    await service.cleanupOldRecordings();

    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  test('deletes a session directory whose recording_sessions row HAS b2_file_id (upload complete)', async () => {
    const uploaded = makeOldSessionDir('B', 20 * 60 * 1000);
    fs.__setupItems([uploaded]);
    dbMock.__testStore.seedRows([
      { session_id: uploaded.name, b2_file_id: 'b2-id-abc-123' },
    ]);

    await service.cleanupOldRecordings();

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(uploaded.name),
      expect.objectContaining({ recursive: true, force: true })
    );
  });

  test('discriminates per-session in a mixed batch — pending stays, uploaded goes', async () => {
    // Realistic mixed state on a production filesystem: some sessions
    // still pending upload, others already uploaded and ready to nuke.
    const pending1 = makeOldSessionDir('P1', 20 * 60 * 1000);
    const pending2 = makeOldSessionDir('P2', 30 * 60 * 1000);
    const uploaded1 = makeOldSessionDir('U1', 25 * 60 * 1000);
    const uploaded2 = makeOldSessionDir('U2', 60 * 60 * 1000);
    fs.__setupItems([pending1, pending2, uploaded1, uploaded2]);
    dbMock.__testStore.seedRows([
      { session_id: pending1.name, b2_file_id: null },
      { session_id: pending2.name, b2_file_id: null },
      { session_id: uploaded1.name, b2_file_id: 'b2-u1' },
      { session_id: uploaded2.name, b2_file_id: 'b2-u2' },
    ]);

    await service.cleanupOldRecordings();

    expect(fs.rmSync).toHaveBeenCalledTimes(2);
    const deletedPaths = fs.rmSync.mock.calls.map((c) => c[0]);
    expect(deletedPaths.some((p) => p.includes(uploaded1.name))).toBe(true);
    expect(deletedPaths.some((p) => p.includes(uploaded2.name))).toBe(true);
    expect(deletedPaths.some((p) => p.includes(pending1.name))).toBe(false);
    expect(deletedPaths.some((p) => p.includes(pending2.name))).toBe(false);
  });

  test('respects retention cutoff — fresh directories are skipped regardless of upload state', async () => {
    // Newer than retention — must not be touched even if uploaded.
    const fresh = { name: `session_${Date.now() - 2 * 60 * 1000}`, isDirectory: true };
    // Older than retention, uploaded — should be deleted.
    const stale = makeOldSessionDir('S', 30 * 60 * 1000);
    fs.__setupItems([fresh, stale]);
    dbMock.__testStore.seedRows([
      { session_id: fresh.name, b2_file_id: 'b2-fresh' },
      { session_id: stale.name, b2_file_id: 'b2-stale' },
    ]);

    await service.cleanupOldRecordings();

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
    expect(fs.rmSync.mock.calls[0][0]).toContain(stale.name);
  });

  test('skips the currently active session directory', async () => {
    const active = makeOldSessionDir('ACTIVE', 30 * 60 * 1000);
    fs.__setupItems([active]);
    dbMock.__testStore.seedRows([
      { session_id: active.name, b2_file_id: 'b2-id' }, // uploaded but active
    ]);
    service.currentSessionId = active.name;

    await service.cleanupOldRecordings();

    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  test('orphan directory (no recording_sessions row, no b2 row) — falls through to deletion', async () => {
    // A directory that's not tracked in the DB at all (e.g. left over
    // from a crashed run that died before the row was inserted, or a
    // manual debug session). The fix's pending set only contains rows
    // with b2_file_id IS NULL — an absent row is not pending, so the
    // file falls through to the unconditional age-based delete. That's
    // the right tradeoff: an orphan file would otherwise sit on disk
    // forever, and the fail-closed alternative (skip-if-unknown) would
    // never reap them.
    const orphan = makeOldSessionDir('ORPHAN', 30 * 60 * 1000);
    fs.__setupItems([orphan]);
    dbMock.__testStore.seedRows([]); // no rows at all

    await service.cleanupOldRecordings();

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
    expect(fs.rmSync.mock.calls[0][0]).toContain(orphan.name);
  });

  test('fails closed when the DB query throws — no deletions on this tick', async () => {
    // Belt-and-braces: if the pending-set lookup itself fails, do not
    // proceed to delete anything. The next tick (one minute later)
    // retries. Better to delay than to race-delete an unconfirmed
    // upload's source.
    const stale = makeOldSessionDir('S', 30 * 60 * 1000);
    fs.__setupItems([stale]);
    dbMock.__testStore.seedRows([{ session_id: stale.name, b2_file_id: 'b2-id' }]);

    // Inject a failure into the next allAsync call. Reassigning
    // `dbMock.allAsync` wouldn't work — the production code
    // destructures the function at require time and closed over that
    // original reference, so we route failure-injection through the
    // mock factory's shared state instead.
    dbMock.__testStore.rejectNextAllAsync(new Error('SQLITE_BUSY: database is locked'));

    await service.cleanupOldRecordings();

    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cleanup aborted'),
      expect.any(Error)
    );
  });
});
