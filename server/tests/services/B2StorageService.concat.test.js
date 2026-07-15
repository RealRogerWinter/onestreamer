/**
 * P2.2 — B2 concat ordering (R5) + ffmpeg timeout (R11).
 *
 * R5: the old sort keyed on the FIRST number in seg_<ts>_<idx>.ts — the
 * shared egress timestamp — so all segments of one run tied and fell back to
 * readdir() order (scrambled archive video). The fix sorts by the full
 * (timestamp, index) numeric tuple.
 *
 * R11: the concat ffmpeg had no timeout; a hung child never resolved
 * concatenateSegments, latching the upload scheduler's isProcessing forever.
 */

const { EventEmitter } = require('events');

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('fs', () => ({
  readdirSync: jest.fn(() => []),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn(() => false),
  statSync: jest.fn(() => ({ size: 1024 })),
  createReadStream: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
}));

const fs = require('fs');
const { spawn } = require('child_process');

// The module exports a singleton constructed at require time; B2_* env is
// unset under jest so it constructs disabled — concatenateSegments is still
// fully exercisable (it does not gate on enabled).
const b2Storage = require('../../services/B2StorageService');

function makeFakeFfmpeg() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('B2StorageService.concatenateSegments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('R5: concat list is ordered by the full (timestamp, index) numeric tuple; strays excluded', async () => {
    fs.readdirSync.mockReturnValue([
      // scrambled on purpose; two runs (legacy day-bucket shape) + an
      // index rollover past 99999 (5→6 digits, where lexicographic breaks)
      'seg_1779941358706_100000.ts',
      'seg_1779941358706_00000.ts',
      'seg_1700000000000_00002.ts',
      'seg_1779941358706_99999.ts',
      'stray.ts',
      'seg_1700000000000_00001.ts',
      'seg_1779941358706_00127.ts',
    ]);

    const fakeChild = makeFakeFfmpeg();
    spawn.mockReturnValue(fakeChild);

    const promise = b2Storage.concatenateSegments('/dir', '/tmp/out.mp4');
    // fail the concat so we don't need output-file stat plumbing
    fakeChild.emit('close', 1);
    await promise;

    const concatWrite = fs.writeFileSync.mock.calls.find(([p]) => String(p).endsWith('concat_list.txt'));
    expect(concatWrite).toBeDefined();
    const listed = concatWrite[1].split('\n').map((l) => l.replace(/^file '(.*)'$/, '$1'));
    expect(listed).toEqual([
      '/dir/seg_1700000000000_00001.ts',
      '/dir/seg_1700000000000_00002.ts',
      '/dir/seg_1779941358706_00000.ts',
      '/dir/seg_1779941358706_00127.ts',
      '/dir/seg_1779941358706_99999.ts',
      '/dir/seg_1779941358706_100000.ts',
    ]);
    expect(concatWrite[1]).not.toContain('stray.ts');
  });

  test('R11: a hung ffmpeg is SIGKILLed at the timeout and the partial output is unlinked', async () => {
    fs.readdirSync.mockReturnValue(['seg_1700000000000_00001.ts']);
    const fakeChild = makeFakeFfmpeg();
    spawn.mockReturnValue(fakeChild);

    const promise = b2Storage.concatenateSegments('/dir', '/tmp/out.mp4');

    jest.advanceTimersByTime(b2Storage.concatTimeoutMs + 1);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');

    // the killed child eventually closes; partial output exists
    fs.existsSync.mockImplementation((p) => p === '/tmp/out.mp4');
    fakeChild.emit('close', null);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/out.mp4');
  });

  test('normal completion clears the kill timer (no kill after close)', async () => {
    fs.readdirSync.mockReturnValue(['seg_1700000000000_00001.ts']);
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ size: 2048 });
    const fakeChild = makeFakeFfmpeg();
    spawn.mockReturnValue(fakeChild);

    const promise = b2Storage.concatenateSegments('/dir', '/tmp/out.mp4');
    fakeChild.emit('close', 0);
    const result = await promise;

    expect(result).toEqual({ success: true, fileSize: 2048 });
    jest.advanceTimersByTime(b2Storage.concatTimeoutMs * 2);
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });
});
