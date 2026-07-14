// Exercises retention cleanup against a REAL temp dir.
//
// Age is measured from the NEWEST segment's mtime, not the dir-name date: a
// per-day `recording_<YYYY-MM-DD>` bucket reads as hours old by its name even
// while it holds fresh segments, so name-based age would delete live footage
// during the currentSessionId===null gap. The pending-upload skip is bounded by
// pendingUploadMaxAgeMs so an un-uploaded session can't pin its dir forever
// (the 37 GB leak). A hard disk-budget backstop is the last resort.
jest.mock('../../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const RecordingDiskScanner = require('../../../services/recording/RecordingDiskScanner');

const dayStr = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().split('T')[0];

// Create a session dir whose segments' mtimes are `ageMs` in the past.
function makeSessionDir(root, name, { segments = 2, ageMs = 0, bytes = 1 } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const mtime = (Date.now() - ageMs) / 1000; // utimesSync wants seconds
  for (let i = 0; i < segments; i++) {
    const p = path.join(dir, `seg_${i}.ts`);
    fs.writeFileSync(p, 'x'.repeat(bytes));
    fs.utimesSync(p, mtime, mtime);
  }
}

const HOUR = 3600000;
const DAY = 86400000;

describe('RecordingDiskScanner.cleanupOldRecordings', () => {
  let outputDir;
  let scanner;
  let pending;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    pending = [];
    scanner = new RecordingDiskScanner({
      outputDir,
      segmentDuration: 4,
      retentionMinutes: 10,
      recordingRepository: { listSessionsPendingUpload: async () => pending },
      owner: { currentSessionId: `recording_${dayStr(0)}` },
    });
  });

  afterEach(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const exists = (name) => fs.existsSync(path.join(outputDir, name));

  test('deletes old uploaded buckets; keeps current, in-window, and recent-pending; handles legacy', async () => {
    const current = `recording_${dayStr(0)}`;            // active → never delete
    makeSessionDir(outputDir, current, { ageMs: 0 });
    const oldUploaded = `recording_${dayStr(3)}`;         // old, not pending → delete
    makeSessionDir(outputDir, oldUploaded, { ageMs: 3 * DAY });
    const inWindow = `recording_${dayStr(1)}`;            // stopped 5 min ago → keep (rolling buffer)
    makeSessionDir(outputDir, inWindow, { ageMs: 5 * 60000 });
    const recentPending = `recording_${dayStr(2)}`;       // 1h old, pending → keep (under grace)
    makeSessionDir(outputDir, recentPending, { ageMs: 1 * HOUR });
    const legacyOld = `session_${Date.now() - 5 * DAY}`;   // legacy format, old → delete
    makeSessionDir(outputDir, legacyOld, { ageMs: 5 * DAY });
    pending = [{ session_id: recentPending }];

    await scanner.cleanupOldRecordings();

    expect(exists(current)).toBe(true);
    expect(exists(inWindow)).toBe(true);
    expect(exists(recentPending)).toBe(true);
    expect(exists(oldUploaded)).toBe(false);
    expect(exists(legacyOld)).toBe(false);
  });

  test('LEAK FIX: a stale pending-upload dir past the grace window is reclaimed despite b2_file_id NULL', async () => {
    const stalePending = `recording_${dayStr(20)}`; // 20 days old, never uploaded
    makeSessionDir(outputDir, stalePending, { ageMs: 20 * DAY });
    pending = [{ session_id: stalePending }]; // still pending forever (B2 off)

    await scanner.cleanupOldRecordings();

    expect(exists(stalePending)).toBe(false); // reclaimed, not pinned forever
  });

  test('the pending grace is honored right up to the boundary, then reclaims past it', async () => {
    scanner.pendingUploadMaxAgeMs = 26 * HOUR;
    const underGrace = `recording_${dayStr(1)}`;
    makeSessionDir(outputDir, underGrace, { ageMs: 25 * HOUR });
    const overGrace = `recording_${dayStr(2)}`;
    makeSessionDir(outputDir, overGrace, { ageMs: 27 * HOUR });
    pending = [{ session_id: underGrace }, { session_id: overGrace }];

    await scanner.cleanupOldRecordings();

    expect(exists(underGrace)).toBe(true);
    expect(exists(overGrace)).toBe(false);
  });

  test('never deletes fresh segments in a non-current dir during the currentSessionId gap', async () => {
    // Simulate the target-switch gap: no current session, but the day dir has
    // segments written seconds ago. Name-based age would wrongly delete it.
    scanner.owner.currentSessionId = null;
    const liveish = `recording_${dayStr(0)}`;
    makeSessionDir(outputDir, liveish, { ageMs: 2000 }); // 2s old

    await scanner.cleanupOldRecordings();

    expect(exists(liveish)).toBe(true);
  });

  test('a DB failure loading pending uploads aborts the tick (fail-closed, deletes nothing)', async () => {
    const oldUploaded = `recording_${dayStr(3)}`;
    makeSessionDir(outputDir, oldUploaded, { ageMs: 3 * DAY });
    scanner.recordingRepository.listSessionsPendingUpload = async () => {
      throw new Error('db down');
    };

    await scanner.cleanupOldRecordings();
    expect(exists(oldUploaded)).toBe(true);
  });

  test('disk-budget backstop deletes oldest over-budget dirs, sparing current + in-window', async () => {
    scanner.diskBudgetBytes = 5; // tiny budget to force enforcement
    const current = `recording_${dayStr(0)}`;
    makeSessionDir(outputDir, current, { ageMs: 0, bytes: 10 }); // over budget but current → spared
    const oldBig = `recording_${dayStr(4)}`;
    makeSessionDir(outputDir, oldBig, { ageMs: 4 * DAY, bytes: 10 });
    const olderBig = `recording_${dayStr(9)}`;
    makeSessionDir(outputDir, olderBig, { ageMs: 9 * DAY, bytes: 10 });

    await scanner.cleanupOldRecordings();

    expect(exists(current)).toBe(true);       // current always spared
    // The two old dirs are over budget → oldest deleted first until under budget.
    expect(exists(olderBig)).toBe(false);
  });
});
