// Verifies the mtime-based clip lookup un-breaks clips on the current
// `recording_<date>` day-bucket format, including a gap (stream stop/restart
// within the day) that the old startTime+index*duration math mis-timed.
jest.mock('../../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const RecordingDiskScanner = require('../../../services/recording/RecordingDiskScanner');

function seg(dir, name, mtimeMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}

describe('RecordingDiskScanner clip lookup (mtime-based, recording_<date>)', () => {
  const SEG = 4; // seconds
  let outputDir;
  let scanner;
  let now;
  let dir;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
    now = Math.floor(Date.now() / 1000) * 1000; // whole second so utimes/stat round-trips exactly
    const dateStr = new Date(now).toISOString().split('T')[0];
    dir = path.join(outputDir, `recording_${dateStr}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'live.m3u8'), '#EXTM3U');
    scanner = new RecordingDiskScanner({
      outputDir,
      segmentDuration: SEG,
      retentionMinutes: 60,
      recordingRepository: { listSessionsPendingUpload: async () => [] },
      owner: { currentSessionId: `recording_${dateStr}` },
    });
  });

  afterEach(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  test('getAvailableRecordings recognizes the recording_<date> bucket and times it by mtime', async () => {
    seg(dir, 'seg_1.ts', now - 12000);
    seg(dir, 'seg_2.ts', now - 8000);
    seg(dir, 'seg_3.ts', now - 4000);
    const recs = await scanner.getAvailableRecordings();
    expect(recs).toHaveLength(1);
    expect(recs[0].segmentCount).toBe(3);
    expect(recs[0].startTime).toBe(now - 12000 - SEG * 1000); // first segment's media start
    expect(recs[0].isActive).toBe(true);
  });

  test('findSegmentsForClip selects by real mtime and skips an earlier gap', async () => {
    seg(dir, 'seg_old1.ts', now - 60000);
    seg(dir, 'seg_old2.ts', now - 56000);
    seg(dir, 'seg_a.ts', now - 8000);
    seg(dir, 'seg_b.ts', now - 4000);
    const { segments } = await scanner.findSegmentsForClip(now - 10000, now);
    expect(segments.map((s) => s.segmentFile)).toEqual(['seg_a.ts', 'seg_b.ts']);
  });

  test('getClippableRange reports a non-empty mtime-based range', async () => {
    for (let i = 10; i >= 1; i--) seg(dir, `seg_${i}.ts`, now - i * 4000);
    const range = await scanner.getClippableRange();
    expect(range.available).toBe(true); // 40s span >= 30s minimum
    expect(range.end).toBe(now - 4000); // newest segment mtime
    expect(range.totalSegments).toBe(10);
  });

  test('returns nothing for a window with no segments', async () => {
    seg(dir, 'seg_1.ts', now - 4000);
    const { segments } = await scanner.findSegmentsForClip(now - 3600000, now - 3590000);
    expect(segments).toHaveLength(0);
  });

  // ── Per-run dirs, recording_<date>_<epochMs> (ADR-0028) ──────────────────
  // The regression gate for the format cutover: if these fail, clip lookup
  // has gone blind to the dirs the producer now writes and all new clips
  // silently break.

  function makeRunDir(epoch) {
    const dateStr = new Date(now).toISOString().split('T')[0];
    const name = `recording_${dateStr}_${epoch}`;
    const p = path.join(outputDir, name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'live.m3u8'), '#EXTM3U');
    return { name, path: p };
  }

  test('a per-run dir is recognized, timed by mtime, and clippable', async () => {
    const run = makeRunDir(now - 20000);
    seg(run.path, 'seg_a.ts', now - 8000);
    seg(run.path, 'seg_b.ts', now - 4000);

    const recs = await scanner.getAvailableRecordings();
    expect(recs.map((r) => r.sessionId)).toContain(run.name);

    const { segments } = await scanner.findSegmentsForClip(now - 10000, now);
    expect(segments.map((s) => s.segmentFile)).toEqual(['seg_a.ts', 'seg_b.ts']);
    expect(segments.every((s) => s.sessionId === run.name)).toBe(true);
  });

  test('a retired day-bucket and a per-run dir on the same day BOTH surface', async () => {
    seg(dir, 'seg_day.ts', now - 30000);          // pre-cutover bucket footage
    const run = makeRunDir(now - 10000);          // post-cutover run
    seg(run.path, 'seg_run.ts', now - 4000);

    const recs = await scanner.getAvailableRecordings();
    const ids = recs.map((r) => r.sessionId).sort();
    expect(ids).toHaveLength(2);
    expect(ids).toContain(run.name);

    // A window spanning both pulls segments from both dirs, time-ordered.
    const { segments } = await scanner.findSegmentsForClip(now - 40000, now);
    expect(segments.map((s) => s.segmentFile)).toEqual(['seg_day.ts', 'seg_run.ts']);
  });

  test('two same-day runs stay distinct sessions with their own segments', async () => {
    const run1 = makeRunDir(now - 30000);
    seg(run1.path, 'seg_r1.ts', now - 26000);
    const run2 = makeRunDir(now - 8000);
    seg(run2.path, 'seg_r2.ts', now - 4000);

    const recs = await scanner.getAvailableRecordings();
    expect(recs.map((r) => r.sessionId).sort()).toEqual([run1.name, run2.name].sort());

    const { segments } = await scanner.findSegmentsForClip(now - 6000, now);
    expect(segments.map((s) => s.segmentFile)).toEqual(['seg_r2.ts']);
  });
});
