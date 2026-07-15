// GATING TESTS for the session-dir name contract (ADR-0028).
//
// _parseSessionDir is the single recognizer every scanner consumer gates on:
// _scanSessionDirs (clip lookup), cleanupOldRecordings, and
// _enforceDiskBudget all skip anything it returns null for. If
// ContinuousRecordingService.startRecording ever changes the dir-name format
// without this parser (and these tests) changing in lockstep, new dirs become
// invisible to cleanup (the unbounded-disk-leak returns) AND to clip lookup
// (all new clips silently break). Extend these tests FIRST when touching the
// format.
jest.mock('../../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

const RecordingDiskScanner = require('../../../services/recording/RecordingDiskScanner');

const makeScanner = () =>
  new RecordingDiskScanner({
    outputDir: '/tmp/parse-noop',
    segmentDuration: 4,
    retentionMinutes: 10,
    recordingRepository: {},
    owner: {},
  });

describe('RecordingDiskScanner._parseSessionDir', () => {
  const scanner = makeScanner();

  test('per-run format recording_<date>_<epochMs> → the run-start epoch (ADR-0028)', () => {
    expect(scanner._parseSessionDir('recording_2026-07-14_1752480000000')).toBe(1752480000000);
  });

  test('per-run epoch wins over the date part (age must be run-start, not midnight)', () => {
    const midnight = Date.parse('2026-07-14T00:00:00Z');
    const parsed = scanner._parseSessionDir('recording_2026-07-14_1752530000000');
    expect(parsed).toBe(1752530000000);
    expect(parsed).not.toBe(midnight);
  });

  test('retired per-day bucket recording_<date> → that day UTC midnight (back-compat)', () => {
    expect(scanner._parseSessionDir('recording_2026-07-14')).toBe(Date.parse('2026-07-14T00:00:00Z'));
  });

  test('legacy session_<unix-ms> → the epoch', () => {
    expect(scanner._parseSessionDir('session_1710000000000')).toBe(1710000000000);
  });

  test.each([
    'recording_2026-07-14_abc',
    'recording_2026-07-14_',
    'recording_',
    'recording_2026-7-14',
    'session_',
    'session_abc',
    'temp',
    'playlist_1752480000000.m3u8',
    '.stfolder',
  ])('rejects non-session name %s', (name) => {
    expect(scanner._parseSessionDir(name)).toBeNull();
  });

  test('LOCKSTEP: the exact id format startRecording produces parses to its epoch', () => {
    // Mirrors ContinuousRecordingService.startRecording:
    //   recording_${new Date(ts).toISOString().split('T')[0]}_${ts}
    const ts = 1752497723000;
    const produced = `recording_${new Date(ts).toISOString().split('T')[0]}_${ts}`;
    expect(scanner._parseSessionDir(produced)).toBe(ts);
  });
});
