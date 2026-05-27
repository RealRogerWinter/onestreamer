/**
 * LifecycleManager tests (PR 4.2).
 *
 * Uses Jest's fake timers so the scheduled work is driven deterministically.
 * Each test silences `console.log` / `console.warn` / `console.error` at the
 * top so the noise from the manager's structured-log lines doesn't pollute
 * the suite output. Spy refs are kept where a test asserts a specific log
 * message; restoreAllMocks cleans up at teardown.
 */

const LifecycleManager = require('../../services/LifecycleManager');

describe('LifecycleManager', () => {
  let manager;
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    manager = new LifecycleManager();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── schedule + happy-path firing ─────────────────────────────────────

  test('schedule() fires the function after the requested delay', () => {
    const fn = jest.fn();
    manager.schedule('test-task', fn, 500);

    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('pending set drains after the task fires', () => {
    manager.schedule('a', () => {}, 100);
    manager.schedule('b', () => {}, 100);
    expect(manager.pending.size).toBe(2);

    jest.advanceTimersByTime(100);
    // The setTimeout callbacks fire synchronously under fake timers; the
    // pending.delete(handle) happens inside the wrapper before the await.
    expect(manager.pending.size).toBe(0);
  });

  test('schedule() returns the timer handle for proactive cancel', () => {
    const fn = jest.fn();
    const handle = manager.schedule('cancel-me', fn, 1000);
    expect(handle).toBeDefined();

    const ok = manager.cancel(handle);
    expect(ok).toBe(true);
    jest.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  // ── stop() drains pending ────────────────────────────────────────────

  test('stop() clears all pending timers without firing them', async () => {
    const fnA = jest.fn();
    const fnB = jest.fn();
    manager.schedule('a', fnA, 1000);
    manager.schedule('b', fnB, 2000);

    await manager.stop();
    jest.advanceTimersByTime(5000);

    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).not.toHaveBeenCalled();
    expect(manager.pending.size).toBe(0);
  });

  test('stop() logs the cleared-task count when work was pending', async () => {
    manager.schedule('a', () => {}, 500);
    manager.schedule('b', () => {}, 500);

    await manager.stop();
    expect(logSpy).toHaveBeenCalledWith('[Lifecycle] cleared 2 pending task(s) on shutdown');
  });

  test('stop() with no pending work logs nothing', async () => {
    await manager.stop();
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('schedule() after stop() returns null and never fires', async () => {
    await manager.stop();
    const fn = jest.fn();
    const handle = manager.schedule('post-stop', fn, 500);

    expect(handle).toBeNull();
    jest.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  // ── validation ───────────────────────────────────────────────────────

  test('schedule() without a name warns and returns null', () => {
    const fn = jest.fn();
    expect(manager.schedule('', fn, 100)).toBeNull();
    expect(manager.schedule(null, fn, 100)).toBeNull();
    expect(manager.schedule(undefined, fn, 100)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[Lifecycle] schedule() called without a name; dropping');
  });

  test('schedule() without a function warns and returns null', () => {
    expect(manager.schedule('x', null, 100)).toBeNull();
    expect(manager.schedule('y', 'not-a-fn', 100)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[Lifecycle] schedule(x) called without a function; dropping');
  });

  test('schedule() with non-numeric, NaN, or negative delayMs warns and returns null', () => {
    const fn = jest.fn();
    expect(manager.schedule('a', fn, 'not-a-number')).toBeNull();
    expect(manager.schedule('b', fn, NaN)).toBeNull();
    expect(manager.schedule('c', fn, -10)).toBeNull();
    expect(manager.schedule('d', fn, Infinity)).toBeNull();
    // All four refused.
    expect(fn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('schedule(a) called with non-numeric / negative delayMs'),
    );
  });

  // ── error swallowing inside the scheduled fn ─────────────────────────

  test('a throwing scheduled fn is logged but does not bubble', async () => {
    const boom = jest.fn(() => { throw new Error('boom'); });
    manager.schedule('exploder', boom, 100);

    jest.advanceTimersByTime(100);
    // Drain microtask queue so the wrapper's catch lands.
    await Promise.resolve();

    expect(boom).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Lifecycle] exploder threw after 100ms:'),
      expect.any(Error),
    );
  });

  test('an async rejecting scheduled fn is logged but does not bubble', async () => {
    const reject = jest.fn(async () => { throw new Error('async boom'); });
    manager.schedule('async-exploder', reject, 250);

    jest.advanceTimersByTime(250);
    // Two microtask drains: one for the async fn, one for the catch.
    await Promise.resolve();
    await Promise.resolve();

    expect(reject).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Lifecycle] async-exploder threw after 250ms:'),
      expect.any(Error),
    );
  });

  // ── in-flight wait on stop() (review feedback) ───────────────────────

  test('stop() awaits in-flight async fn promises before resolving', async () => {
    // Construct a fn whose resolution we control explicitly so we can
    // verify stop() blocks on it. Real timers here — fake timers don't
    // interleave well with the actual Promise chain we need.
    jest.useRealTimers();

    let resolveFn;
    const fnPromise = new Promise((resolve) => { resolveFn = resolve; });
    const fn = jest.fn(() => fnPromise);

    manager.schedule('long-task', fn, 10);

    // Wait for the timer to fire and the wrapper to enter `await fn()`.
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(manager.inFlight.size).toBe(1);

    // Kick off stop(). It must NOT resolve until fn's promise resolves.
    let stopResolved = false;
    const stopPromise = manager.stop().then(() => { stopResolved = true; });

    // Give the event loop a chance to schedule things.
    await new Promise((r) => setTimeout(r, 10));
    expect(stopResolved).toBe(false);

    // Now release the in-flight fn.
    resolveFn();
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(manager.inFlight.size).toBe(0);
  });

  test('stop() awaits an in-flight fn that rejects (allSettled, not all)', async () => {
    jest.useRealTimers();

    let rejectFn;
    const fnPromise = new Promise((_, reject) => { rejectFn = reject; });
    manager.schedule('long-rejector', () => fnPromise, 10);

    await new Promise((r) => setTimeout(r, 30));
    expect(manager.inFlight.size).toBe(1);

    const stopPromise = manager.stop();
    rejectFn(new Error('rejected mid-shutdown'));

    // Should resolve cleanly — allSettled tolerates rejections.
    await expect(stopPromise).resolves.toBeUndefined();
    expect(manager.inFlight.size).toBe(0);
    // The thrown error is logged through the wrapper's own catch.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Lifecycle] long-rejector threw after 10ms:'),
      expect.any(Error),
    );
  });

  test('stop() logs the in-flight count when there is in-flight work', async () => {
    jest.useRealTimers();

    let resolveFn;
    manager.schedule('logged-inflight', () => new Promise((r) => { resolveFn = r; }), 5);
    await new Promise((r) => setTimeout(r, 15));
    expect(manager.inFlight.size).toBe(1);

    const stopPromise = manager.stop();
    resolveFn();
    await stopPromise;

    expect(logSpy).toHaveBeenCalledWith('[Lifecycle] awaiting 1 in-flight task(s) on shutdown');
  });

  // ── cancel() edge cases ──────────────────────────────────────────────

  test('cancel() of a fired handle is a no-op (already gone from pending)', () => {
    const fn = jest.fn();
    const handle = manager.schedule('fire-then-cancel', fn, 100);
    jest.advanceTimersByTime(100);

    // Fired, removed from pending. Cancel should return false.
    expect(manager.cancel(handle)).toBe(false);
  });

  test('cancel() of a null/undefined handle is a no-op', () => {
    expect(manager.cancel(null)).toBe(false);
    expect(manager.cancel(undefined)).toBe(false);
  });

  test('cancel() of a foreign handle (never scheduled here) is a no-op', () => {
    const foreign = setTimeout(() => {}, 1000);
    expect(manager.cancel(foreign)).toBe(false);
    clearTimeout(foreign);
  });
});
