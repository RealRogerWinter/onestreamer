// Exercises retention cleanup against a REAL temp dir. Reproduces the disk-leak
// root cause: egress now writes `recording_<YYYY-MM-DD>` buckets but the scanner
// only matched `session_<ms>`, so cleanup deleted nothing. Verifies the fix
// deletes old, B2-confirmed, non-current buckets while retaining the current
// session and any not-yet-uploaded ones.
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

function makeSessionDir(root, name, segments = 2) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < segments; i++) fs.writeFileSync(path.join(dir, `seg_${i}.ts`), 'x');
}

describe('RecordingDiskScanner.cleanupOldRecordings (recording_<date> buckets)', () => {
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

  test('deletes old B2-uploaded buckets; keeps current and pending-upload; handles legacy', async () => {
    const current = `recording_${dayStr(0)}`; // active → skip
    const oldUploaded = `recording_${dayStr(3)}`; // → delete
    const oldPending = `recording_${dayStr(2)}`; // B2 not done → keep
    const legacyUploaded = `session_${Date.now() - 5 * 86400000}`; // legacy format → delete
    [current, oldUploaded, oldPending, legacyUploaded].forEach((n) => makeSessionDir(outputDir, n));
    pending = [{ session_id: oldPending }];

    await scanner.cleanupOldRecordings();

    expect(exists(current)).toBe(true); // current never deleted
    expect(exists(oldPending)).toBe(true); // B2 gate retains it
    expect(exists(oldUploaded)).toBe(false); // deleted
    expect(exists(legacyUploaded)).toBe(false); // legacy session_ still handled
  });

  test('a DB failure loading pending uploads aborts the tick (fail-closed, deletes nothing)', async () => {
    const oldUploaded = `recording_${dayStr(3)}`;
    makeSessionDir(outputDir, oldUploaded);
    scanner.recordingRepository.listSessionsPendingUpload = async () => {
      throw new Error('db down');
    };

    await scanner.cleanupOldRecordings();
    expect(exists(oldUploaded)).toBe(true);
  });
});
