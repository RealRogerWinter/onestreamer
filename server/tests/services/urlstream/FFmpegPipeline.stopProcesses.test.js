/**
 * Tests for FFmpegPipeline.stopProcesses SIGKILL escalation (audit Plan 06 V4).
 *
 * The 3s escalation timer used to gate on `!process.killed` — but Node sets
 * `.killed` to true as soon as a signal is *sent* (it does NOT mean the
 * process died), so SIGKILL never fired and ffmpeg/streamlink processes that
 * ignored SIGTERM accumulated as zombies on rotation. The early-out at the
 * top of the map had the same `.killed` misuse. These tests pin escalation to
 * actual process exit.
 */

const EventEmitter = require('events');

const FFmpegPipeline = require('../../../services/urlstream/FFmpegPipeline');

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

/**
 * Fake child process mirroring the real ChildProcess contract:
 * - kill(signal) marks `.killed = true` immediately (signal *sent*)
 * - exitCode/signalCode stay null until the process actually exits
 */
function makeFakeProcess({ pid = 1234, exitsOnSigterm = false } = {}) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = jest.fn((signal) => {
    proc.killed = true; // Node semantics: signal was sent, NOT process died
    if (signal === 'SIGTERM' && exitsOnSigterm) {
      // Exit promptly on the next tick, like a well-behaved process
      process.nextTick(() => {
        proc.exitCode = 0;
        proc.signalCode = 'SIGTERM';
        proc.emit('exit', null, 'SIGTERM');
        proc.emit('close', null, 'SIGTERM');
      });
    }
    return true;
  });
  return proc;
}

function makeStreamEntry(proc) {
  return {
    urlId: 'url-stream-test',
    processes: [{ type: 'ffmpeg', process: proc }],
  };
}

describe('FFmpegPipeline.stopProcesses SIGKILL escalation (V4)', () => {
  let pipeline;

  beforeEach(() => {
    jest.useFakeTimers();
    pipeline = new FFmpegPipeline({}, silentLogger);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('escalates to SIGKILL when process ignores SIGTERM past the 3s window', async () => {
    const proc = makeFakeProcess({ exitsOnSigterm: false });
    const entry = makeStreamEntry(proc);

    const stopPromise = pipeline.stopProcesses(entry);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.killed).toBe(true); // signal sent — must NOT suppress escalation

    await jest.advanceTimersByTimeAsync(3000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    // Final 5s safety timeout resolves even if the process never exits
    await jest.advanceTimersByTimeAsync(2000);
    await stopPromise;
    expect(entry.processes).toEqual([]);
  });

  test('does not send SIGKILL when the process exits promptly after SIGTERM', async () => {
    const proc = makeFakeProcess({ exitsOnSigterm: true });
    const entry = makeStreamEntry(proc);

    const stopPromise = pipeline.stopProcesses(entry);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    await jest.advanceTimersByTimeAsync(3000);
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');

    await stopPromise;
    expect(entry.processes).toEqual([]);
  });

  test('skips processes that have already exited (exitCode set), not merely signalled', async () => {
    const proc = makeFakeProcess();
    proc.exitCode = 0; // already exited
    const entry = makeStreamEntry(proc);

    await pipeline.stopProcesses(entry);

    expect(proc.kill).not.toHaveBeenCalled();
    expect(entry.processes).toEqual([]);
  });

  test('still attempts teardown of a live process that was previously signalled (.killed true)', async () => {
    const proc = makeFakeProcess({ exitsOnSigterm: false });
    proc.killed = true; // a signal was sent earlier, but the process is still alive
    const entry = makeStreamEntry(proc);

    const stopPromise = pipeline.stopProcesses(entry);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    await jest.advanceTimersByTimeAsync(3000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    await jest.advanceTimersByTimeAsync(2000);
    await stopPromise;
  });
});
